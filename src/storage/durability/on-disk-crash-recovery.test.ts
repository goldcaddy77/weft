/**
 * Engine recovery against an on-disk SQLite file.
 *
 * Each test asserts a specific recovery invariant. The pattern mirrors the
 * in-memory recovery suite in `src/core/crash-recovery.test.ts`:
 *
 *   1. Engine1 opens an adapter at an on-disk path, runs a minimal
 *      workflow to its parking point, flushes async work.
 *   2. The test inspects storage through the `Storage` interface and
 *      asserts the recovery-relevant records were written.
 *   3. Engine1 is abandoned without `[Symbol.dispose]()` — the storage
 *      closes at the end of test scope. A fresh `Storage` instance is
 *      opened against the same path, handed to Engine2.
 *   4. Engine2.recoverAll() runs and the invariant is checked.
 *
 * The runtime persistence assertion at step 2 makes "the workflow never
 * reached the parking point" loud instead of silent.
 *
 * Bun-only at present: `better-sqlite3` cannot load under Bun
 * (oven-sh/bun#4290), so `NodeSQLiteStorage` integration variants are
 * skipped in this runtime. The recovery code path is shared across SQLite
 * adapters, so adapter parity at the recovery layer is established by the
 * other deliverables in `src/storage/durability/`.
 */

import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';

import { Engine } from '../../core/engine.ts';
import type { WorkflowContext } from '../../core/types.ts';
import { sleepForTesting } from '../../testing/fake-timers.ts';
import { BunSQLiteStorage } from '../bun-sql.ts';
import { KEYS as STORAGE_KEYS } from '../interface.ts';

import { FixtureScope } from './adapter-spec.ts';

async function flush(): Promise<void> {
  await sleepForTesting(10);
}

function openStorage(databasePath: string): BunSQLiteStorage {
  return new BunSQLiteStorage(databasePath);
}

describe('on-disk crash recovery — BunSQLiteStorage', () => {
  let scope: FixtureScope;

  beforeEach(() => {
    scope = new FixtureScope();
  });

  afterEach(() => {
    scope.cleanup();
  });

  it('pending-signal workflow resumes against a fresh Engine + fresh adapter', async () => {
    try {
      const directory = scope.makeTempDirectory('recovery-signal');
      const databasePath = join(directory, 'weft.db');

      function makeWorkflow() {
        return async function* (ctx: WorkflowContext) {
          const result = yield* ctx.waitForSignal('go');
          return `recovered:${String(result)}`;
        };
      }

      const storage1 = openStorage(databasePath);
      const engine1 = new Engine({ storage: storage1 });
      engine1.register('signal-resume', makeWorkflow());
      await engine1.start('signal-resume', null, { id: 'wf-signal' });
      await flush();

      // Persistence assertion: the workflow record must be on disk before
      // Engine2 is constructed.
      const workflowKey = STORAGE_KEYS.workflow('wf-signal');
      expect(await storage1.get(workflowKey)).not.toBeNull();
      storage1[Symbol.dispose]();

      const storage2 = openStorage(databasePath);
      const engine2 = new Engine({ storage: storage2 });
      engine2.register('signal-resume', makeWorkflow());

      const handles = await engine2.recoverAll();
      expect(handles).toHaveLength(1);
      await flush();

      await engine2.signal('wf-signal', 'go', 'payload');
      const result = await handles[0]!.result();
      expect(result).toBe('recovered:payload');
      storage2[Symbol.dispose]();
    } catch (error) {
      scope.markFailed();
      throw error;
    }
  });

  it('completed workflow is not re-resumed against a fresh adapter', async () => {
    try {
      const directory = scope.makeTempDirectory('recovery-completed');
      const databasePath = join(directory, 'weft.db');

      function makeWorkflow() {
        return async function* () {
          return 'done';
        };
      }

      const storage1 = openStorage(databasePath);
      const engine1 = new Engine({ storage: storage1 });
      engine1.register('completed-once', makeWorkflow());
      const initialHandle = await engine1.start('completed-once', null, { id: 'wf-done' });
      const firstResult = await initialHandle.result();
      expect(firstResult).toBe('done');
      await flush();

      expect(await storage1.get(STORAGE_KEYS.workflow('wf-done'))).not.toBeNull();
      storage1[Symbol.dispose]();

      const storage2 = openStorage(databasePath);
      const engine2 = new Engine({ storage: storage2 });
      engine2.register('completed-once', makeWorkflow());

      const handles = await engine2.recoverAll();
      expect(handles).toHaveLength(0);
      storage2[Symbol.dispose]();
    } catch (error) {
      scope.markFailed();
      throw error;
    }
  });

  it('event log persists across reopen and recovery preserves replay state', async () => {
    try {
      const directory = scope.makeTempDirectory('recovery-events');
      const databasePath = join(directory, 'weft.db');

      function makeWorkflow() {
        return async function* (ctx: WorkflowContext) {
          const first = yield* ctx.waitForSignal('step1');
          const second = yield* ctx.waitForSignal('step2');
          return `${String(first)}/${String(second)}`;
        };
      }

      const storage1 = openStorage(databasePath);
      const engine1 = new Engine({ storage: storage1 });
      engine1.register('two-signal', makeWorkflow());
      await engine1.start('two-signal', null, { id: 'wf-two' });
      await flush();

      await engine1.signal('wf-two', 'step1', 'A');
      await flush();

      // Confirm at least one event record exists for the workflow on disk
      // before we abandon Engine1.
      const eventPrefix = STORAGE_KEYS.eventPrefix('wf-two');
      let eventCount = 0;
      for await (const _entry of storage1.scan(eventPrefix)) {
        eventCount++;
      }
      expect(eventCount).toBeGreaterThan(0);
      storage1[Symbol.dispose]();

      const storage2 = openStorage(databasePath);
      const engine2 = new Engine({ storage: storage2 });
      engine2.register('two-signal', makeWorkflow());

      const handles = await engine2.recoverAll();
      expect(handles).toHaveLength(1);
      await flush();

      await engine2.signal('wf-two', 'step2', 'B');
      const result = await handles[0]!.result();
      expect(result).toBe('A/B');
      storage2[Symbol.dispose]();
    } catch (error) {
      scope.markFailed();
      throw error;
    }
  });

  it('storage scan order is stable across reopen for recoverable handles', async () => {
    try {
      const directory = scope.makeTempDirectory('recovery-scan-order');
      const databasePath = join(directory, 'weft.db');

      function makeWorkflow() {
        return async function* (ctx: WorkflowContext) {
          const value = yield* ctx.waitForSignal('release');
          return value;
        };
      }

      const storage1 = openStorage(databasePath);
      const engine1 = new Engine({ storage: storage1 });
      engine1.register('scan-order', makeWorkflow());
      await engine1.start('scan-order', null, { id: 'aaa' });
      await engine1.start('scan-order', null, { id: 'bbb' });
      await engine1.start('scan-order', null, { id: 'ccc' });
      await flush();

      expect(await storage1.get(STORAGE_KEYS.workflow('aaa'))).not.toBeNull();
      expect(await storage1.get(STORAGE_KEYS.workflow('bbb'))).not.toBeNull();
      expect(await storage1.get(STORAGE_KEYS.workflow('ccc'))).not.toBeNull();
      storage1[Symbol.dispose]();

      const storage2 = openStorage(databasePath);
      const engine2 = new Engine({ storage: storage2 });
      engine2.register('scan-order', makeWorkflow());

      const handles = await engine2.recoverAll();
      expect(handles.map((handle) => handle.id)).toEqual(['aaa', 'bbb', 'ccc']);
      storage2[Symbol.dispose]();
    } catch (error) {
      scope.markFailed();
      throw error;
    }
  });
});
