import { describe, expect, it } from 'bun:test';

import type { Context } from '../core/context.ts';
import { Engine } from '../core/engine.ts';
import type { WorkflowContext } from '../core/types.ts';
import { BunSQLiteStorage } from '../storage/bun-sql.ts';

/**
 * K2c: Workflow recovery benchmark.
 *
 * Starts workflows that checkpoint, disposes the engine, creates a new
 * engine on the same storage, and measures per-workflow recovery time.
 * Architecture target is <1ms (O(1) checkpoint load); relaxed to <5ms
 * to absorb CI variance. Also verifies that recovery time is constant
 * regardless of workflow history size.
 */

const TARGET_RECOVERY_MS = process.env['CI'] ? 10 : 5;

describe('Workflow recovery', () => {
  it(`recovers a single workflow in <${TARGET_RECOVERY_MS}ms`, async () => {
    const storage = new BunSQLiteStorage(':memory:');
    const engine = new Engine({ storage });

    // A workflow that waits for a signal so it stays in 'running' state
    // after checkpointing.
    engine.register('waiter', async function* (ctx: WorkflowContext) {
      yield* (ctx as Context).waitForSignal('go');
      return 'done';
    });

    const totalWorkflows = 100;

    // Start workflows — they'll checkpoint at the signal-wait yield point.
    for (let i = 0; i < totalWorkflows; i++) {
      await engine.start('waiter', i);
    }

    // Allow microtasks to settle so checkpoints are written.
    await Bun.sleep(10);

    // Dispose the engine (simulates process crash / restart).
    engine[Symbol.dispose]();

    // Create a new engine on the same storage.
    const engine2 = new Engine({ storage });

    engine2.register('waiter', async function* (ctx: WorkflowContext) {
      yield* (ctx as Context).waitForSignal('go');
      return 'done';
    });

    // Measure recovery time for all workflows via recoverAll().
    const start = performance.now();
    const handles = await engine2.recoverAll();
    const elapsed = performance.now() - start;

    const perWorkflow = elapsed / handles.length;

    console.log(
      [
        `\n  Workflow recovery benchmark:`,
        `    Workflows:       ${handles.length}`,
        `    Total elapsed:   ${elapsed.toFixed(2)}ms`,
        `    Per workflow:    ${perWorkflow.toFixed(3)}ms`,
        `    Target:          <${TARGET_RECOVERY_MS}ms per workflow\n`,
      ].join('\n'),
    );

    expect(handles.length).toBe(totalWorkflows);
    expect(perWorkflow).toBeLessThan(TARGET_RECOVERY_MS);

    engine2[Symbol.dispose]();
    storage[Symbol.dispose]();
  }, 30_000);

  it('recovery time is O(1) — constant regardless of history depth', async () => {
    const storage = new BunSQLiteStorage(':memory:');

    // Phase 1: create a workflow with shallow history.
    const engine1 = new Engine({ storage });

    engine1.register('waiter', async function* (ctx: WorkflowContext) {
      yield* (ctx as Context).waitForSignal('go');
      return 'done';
    });

    await engine1.start('waiter', 'shallow', { id: 'shallow-history' });
    await Bun.sleep(5);
    engine1[Symbol.dispose]();

    // Measure shallow recovery.
    const engine2 = new Engine({ storage });
    engine2.register('waiter', async function* (ctx: WorkflowContext) {
      yield* (ctx as Context).waitForSignal('go');
      return 'done';
    });

    const shallowStart = performance.now();
    await engine2.resume('shallow-history');
    const shallowTime = performance.now() - shallowStart;
    engine2[Symbol.dispose]();

    // Phase 2: create a workflow with deeper history (more checkpoint data
    // in storage via many completed workflows to fill the store).
    const engine3 = new Engine({ storage });

    engine3.register('waiter', async function* (ctx: WorkflowContext) {
      yield* (ctx as Context).waitForSignal('go');
      return 'done';
    });

    // Add 500 completed workflows to increase overall storage volume.
    engine3.register('filler', async function* (_ctx: WorkflowContext) {
      return 'filler';
    });
    for (let i = 0; i < 500; i++) {
      const handle = await engine3.start('filler', i);
      await handle.result();
    }

    // Start a new 'waiter' workflow that will be recovered.
    await engine3.start('waiter', 'deep', { id: 'deep-history' });
    await Bun.sleep(5);
    engine3[Symbol.dispose]();

    // Measure deep recovery.
    const engine4 = new Engine({ storage });
    engine4.register('waiter', async function* (ctx: WorkflowContext) {
      yield* (ctx as Context).waitForSignal('go');
      return 'done';
    });

    const deepStart = performance.now();
    await engine4.resume('deep-history');
    const deepTime = performance.now() - deepStart;
    engine4[Symbol.dispose]();
    storage[Symbol.dispose]();

    console.log(
      [
        `\n  Recovery O(1) verification:`,
        `    Shallow (no extra data): ${shallowTime.toFixed(3)}ms`,
        `    Deep (500+ workflows):   ${deepTime.toFixed(3)}ms`,
        `    Ratio:                   ${(deepTime / shallowTime).toFixed(2)}x\n`,
      ].join('\n'),
    );

    // Deep recovery should be at most 5x the shallow time. In a true O(1)
    // system they'd be nearly identical; the generous factor accounts for
    // cache effects and GC jitter.
    expect(deepTime).toBeLessThan(shallowTime * 5 + 2);
  }, 60_000);
});
