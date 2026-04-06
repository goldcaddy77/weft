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
const RECOVERY_SAMPLE_SIZE = 5;

function median(values: number[]): number {
  const sorted = values.toSorted((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted[middle]!;
}

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

    for (let index = 0; index < RECOVERY_SAMPLE_SIZE; index++) {
      await engine1.start('waiter', `shallow-${index}`, {
        id: `shallow-history-${index}`,
      });
    }
    await Bun.sleep(5);
    engine1[Symbol.dispose]();

    // Measure shallow recovery.
    const engine2 = new Engine({ storage });
    engine2.register('waiter', async function* (ctx: WorkflowContext) {
      yield* (ctx as Context).waitForSignal('go');
      return 'done';
    });

    const shallowTimes: number[] = [];
    for (let index = 0; index < RECOVERY_SAMPLE_SIZE; index++) {
      const shallowStart = performance.now();
      await engine2.resume(`shallow-history-${index}`);
      shallowTimes.push(performance.now() - shallowStart);
    }
    const shallowMedian = median(shallowTimes);
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
    for (let index = 0; index < RECOVERY_SAMPLE_SIZE; index++) {
      await engine3.start('waiter', `deep-${index}`, {
        id: `deep-history-${index}`,
      });
    }
    await Bun.sleep(5);
    engine3[Symbol.dispose]();

    // Measure deep recovery.
    const engine4 = new Engine({ storage });
    engine4.register('waiter', async function* (ctx: WorkflowContext) {
      yield* (ctx as Context).waitForSignal('go');
      return 'done';
    });

    const deepTimes: number[] = [];
    for (let index = 0; index < RECOVERY_SAMPLE_SIZE; index++) {
      const deepStart = performance.now();
      await engine4.resume(`deep-history-${index}`);
      deepTimes.push(performance.now() - deepStart);
    }
    const deepMedian = median(deepTimes);
    engine4[Symbol.dispose]();
    storage[Symbol.dispose]();

    console.log(
      [
        `\n  Recovery O(1) verification:`,
        `    Shallow median:          ${shallowMedian.toFixed(3)}ms`,
        `    Deep median:             ${deepMedian.toFixed(3)}ms`,
        `    Ratio:                   ${(deepMedian / shallowMedian).toFixed(2)}x`,
        `    Shallow samples:         ${shallowTimes.map((time) => time.toFixed(3)).join(', ')}`,
        `    Deep samples:            ${deepTimes.map((time) => time.toFixed(3)).join(', ')}\n`,
      ].join('\n'),
    );

    // Deep recovery should be at most 5x the shallow time. In a true O(1)
    // system they'd be nearly identical; the generous factor accounts for
    // cache effects and GC jitter.
    expect(deepMedian).toBeLessThan(shallowMedian * 5 + 2);
  }, 60_000);
});
