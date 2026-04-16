import { describe, expect, it } from 'bun:test';

import type { BatchOperation } from '../../storage/interface.ts';
import { KEYS } from '../../storage/interface.ts';
import { MemoryStorage } from '../../storage/memory.ts';
import type { Context } from '../context.ts';
import { Engine } from '../engine.ts';
import type { WorkflowContext } from '../types.ts';

async function flush(): Promise<void> {
  await Bun.sleep(25);
}

class RecordingMemoryStorage extends MemoryStorage {
  readonly batchCalls: BatchOperation[][] = [];

  override async batch(operations: BatchOperation[]): Promise<void> {
    this.batchCalls.push([...operations]);
    await super.batch(operations);
  }
}

async function collectKeys(storage: MemoryStorage, prefix: string): Promise<string[]> {
  const keys: string[] = [];
  for await (const key of storage.keys ? storage.keys(prefix) : collectScanKeys(storage, prefix)) {
    keys.push(key);
  }
  return keys;
}

async function* collectScanKeys(storage: MemoryStorage, prefix: string): AsyncGenerator<string> {
  for await (const [key] of storage.scan(prefix)) {
    yield key;
  }
}

describe('workflow retention', () => {
  it('Acceptance criteria: EngineOptions.retention cleans up terminal workflows after updatedAt + TTL', async () => {
    let now = 1_000;
    const engine = new Engine({
      storage: new MemoryStorage(),
      getNow: () => now,
      retention: {
        completed: '5s',
      },
      retentionSweepInterval: '10ms',
    });

    engine.register('echo', async function* (_ctx: WorkflowContext, input: unknown) {
      return input;
    });

    const handle = await engine.start('echo', 'hello', { id: 'retention-completed' });
    await handle.result();

    expect(await engine.get(handle.id)).not.toBeNull();

    now += 4_000;
    await flush();
    expect(await engine.get(handle.id)).not.toBeNull();

    now += 1_001;
    await flush();
    expect(await engine.get(handle.id)).toBeNull();

    engine[Symbol.dispose]();
  });

  it('Acceptance criteria: retention sweep uses a configurable interval and processes a configurable batch size', async () => {
    let now = 10_000;
    const engine = new Engine({
      storage: new MemoryStorage(),
      getNow: () => now,
      retention: {
        completed: 0,
      },
      retentionSweepInterval: '50ms',
      retentionSweepBatchSize: 1,
    });

    engine.register('echo', async function* (_ctx: WorkflowContext, input: unknown) {
      return input;
    });

    const first = await engine.start('echo', 'a', { id: 'batched-a' });
    const second = await engine.start('echo', 'b', { id: 'batched-b' });
    await Promise.all([first.result(), second.result()]);

    await Bun.sleep(60);

    const remainingAfterFirstSweep = [
      await engine.get(first.id),
      await engine.get(second.id),
    ].filter((state) => state !== null);
    expect(remainingAfterFirstSweep).toHaveLength(1);

    await Bun.sleep(60);

    expect(await engine.get(first.id)).toBeNull();
    expect(await engine.get(second.id)).toBeNull();

    engine[Symbol.dispose]();
  });

  it('Acceptance criteria: retention sweep defaults to every 5 minutes when not configured', async () => {
    const engine = new Engine({
      storage: new MemoryStorage(),
      retention: {
        completed: '1s',
      },
    });

    engine.register('echo', async function* (_ctx: WorkflowContext, input: unknown) {
      return input;
    });

    const overview = engine.getRetentionOverview();
    expect(overview.sweepIntervalMs).toBe(300_000);
    expect(overview.nextSweepAt).not.toBeNull();

    engine[Symbol.dispose]();
  });

  it('Acceptance criteria: per-workflow-type retention overrides the engine default', async () => {
    let now = 5_000;
    const engine = new Engine({
      storage: new MemoryStorage(),
      getNow: () => now,
      retention: {
        completed: '1s',
      },
      retentionSweepInterval: '10ms',
    });

    engine.register('short-lived', async function* () {
      return 'short';
    });
    engine.register('long-lived', {
      handler: async function* () {
        return 'long';
      },
      retention: {
        completed: '10s',
      },
    });

    const shortHandle = await engine.start('short-lived', null, { id: 'short-lived' });
    const longHandle = await engine.start('long-lived', null, { id: 'long-lived' });
    await Promise.all([shortHandle.result(), longHandle.result()]);

    now += 1_500;
    await flush();

    expect(await engine.get(shortHandle.id)).toBeNull();
    expect(await engine.get(longHandle.id)).not.toBeNull();

    now += 9_000;
    await flush();

    expect(await engine.get(longHandle.id)).toBeNull();

    engine[Symbol.dispose]();
  });

  it('Acceptance criteria: retention deletes workflow state, checkpoints, checkpoint history, events, search attribute indexes, offloaded data, archived data, and stream chunks in one batch() call per workflow', async () => {
    const storage = new RecordingMemoryStorage();
    const engine = new Engine({
      storage,
    });

    engine.register('artifact-workflow', async function* (ctx: WorkflowContext) {
      const concreteContext = ctx as Context;
      yield* concreteContext.stream('chunks', async function* () {
        yield { index: 0 };
        yield { index: 1 };
      });
      yield* concreteContext.offload('export', async () => ({ rows: [1, 2, 3] }));
      yield* concreteContext.archive('snapshot', { ok: true });
      return 'done';
    });

    const handle = await engine.start('artifact-workflow', null, {
      id: 'purge-me',
    });
    await handle.result();
    await engine.setAttributes(handle.id, { priority: 'high' });
    await storage.put(`shared:${handle.id}:counter`, new TextEncoder().encode('1'));

    const batchCallsBeforePurge = storage.batchCalls.length;

    const result = await engine.purge({ status: 'completed', type: 'artifact-workflow' });

    expect(result.deleted).toBe(1);
    expect(storage.batchCalls.length - batchCallsBeforePurge).toBe(1);
    expect(await engine.get(handle.id)).toBeNull();
    expect(await storage.get(KEYS.checkpoint(handle.id))).toBeNull();
    expect(await storage.get(KEYS.attribute(handle.id))).toBeNull();
    expect(await collectKeys(storage, `wf:${handle.id}:ckpt:`)).toEqual([]);
    expect(await collectKeys(storage, `ev:${handle.id}:`)).toEqual([]);
    expect(await collectKeys(storage, `offload:${handle.id}:`)).toEqual([]);
    expect(await collectKeys(storage, `archive:${handle.id}:`)).toEqual([]);
    expect(await collectKeys(storage, `blob:${handle.id}:`)).toEqual([]);
    expect(await collectKeys(storage, `shared:${handle.id}:`)).toEqual([]);
    expect(await collectKeys(storage, `idx:priority:`)).toEqual([]);

    engine[Symbol.dispose]();
  });

  it('Acceptance criteria: engine.purge(filter) manually triggers cleanup for matching terminal workflows only', async () => {
    const engine = new Engine({
      storage: new MemoryStorage(),
    });

    engine.register('completed', async function* () {
      return 'done';
    });
    engine.register('waiting', async function* (ctx: WorkflowContext) {
      yield* (ctx as Context).waitForSignal('continue');
      return 'done';
    });

    const completedHandle = await engine.start('completed', null, { id: 'completed-workflow' });
    const runningHandle = await engine.start('waiting', null, { id: 'running-workflow' });
    await completedHandle.result();

    const purgeResult = await engine.purge({ status: 'completed' });

    expect(purgeResult.deleted).toBe(1);
    expect(await engine.get(completedHandle.id)).toBeNull();
    expect(await engine.get(runningHandle.id)).not.toBeNull();

    await engine.signal(runningHandle.id, 'continue');
    await runningHandle.result();
    engine[Symbol.dispose]();
  });
});
