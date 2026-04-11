import { afterEach, describe, expect, it } from 'bun:test';

import type { Context } from '../core/context.ts';
import { Engine } from '../core/engine.ts';
import type { WorkflowContext } from '../core/types.ts';
import { BunSQLiteStorage } from '../storage/bun-sql.ts';
import { isCoverageInstrumentationEnabled } from './coverage-mode.ts';

/**
 * K2b: Activity completion throughput benchmark.
 *
 * Registers a workflow that calls one trivial activity, starts many
 * workflows, waits for all to complete, and measures completions/sec.
 *
 * Architecture target: 30K/sec. Measured 2026-04-07: ~14K/sec on Apple
 * Silicon (up from ~9K/sec — same prepared-statement, dedup-skip, and
 * completion-state-merge optimizations as the workflow-start benchmark).
 * The remaining gap to spec is dominated by the per-workflow scheduler
 * cancel and `#cleanupTerminalWorkflow` deletes; further work would need
 * to coalesce these into the completion batch. Tracked in
 * `reference/IMPORTANT.md`.
 *
 * Previous threshold: 3_000 (5_000 on CI), relaxed because ~9K/sec was
 * the prior measured ceiling. New thresholds enforce the post-optimization
 * floor with headroom for machine variance.
 */

const BASELINE_TARGET_COMPLETIONS_PER_SECOND = process.env['CI'] ? 5_000 : 10_000;
const COVERAGE_TARGET_COMPLETIONS_PER_SECOND = process.env['CI'] ? 3_000 : 5_000;

describe('Activity completion throughput', () => {
  let storage: BunSQLiteStorage;
  let engine: Engine;

  afterEach(() => {
    engine[Symbol.dispose]();
    storage[Symbol.dispose]();
  });

  it(`completions exceed ${(isCoverageInstrumentationEnabled()
    ? COVERAGE_TARGET_COMPLETIONS_PER_SECOND
    : BASELINE_TARGET_COMPLETIONS_PER_SECOND
  ).toLocaleString()}/sec`, async () => {
    const targetCompletionsPerSecond = isCoverageInstrumentationEnabled()
      ? COVERAGE_TARGET_COMPLETIONS_PER_SECOND
      : BASELINE_TARGET_COMPLETIONS_PER_SECOND;

    storage = new BunSQLiteStorage(':memory:');
    engine = new Engine({ storage });

    // A trivial activity that returns its input.
    function echo(value: unknown): unknown {
      return value;
    }

    engine.registerActivity('echo', echo);

    engine.register('with-activity', async function* (ctx: WorkflowContext) {
      const result = yield* (ctx as Context).run(echo, 42);
      return result;
    });

    const totalWorkflows = 5_000;

    // Warm up
    for (let i = 0; i < 20; i++) {
      const handle = await engine.start('with-activity', i);
      await handle.result();
    }

    const handles: Array<{ result: () => Promise<unknown> }> = [];

    const start = performance.now();

    for (let i = 0; i < totalWorkflows; i++) {
      const handle = await engine.start('with-activity', i);
      handles.push(handle);
    }

    // Wait for all workflows to complete
    await Promise.all(handles.map((handle) => handle.result()));

    const elapsed = performance.now() - start;
    const completionsPerSecond = Math.round((totalWorkflows / elapsed) * 1000);

    console.log(
      [
        `\n  Activity completion throughput benchmark:`,
        `    Total workflows: ${totalWorkflows.toLocaleString()}`,
        `    Elapsed:         ${elapsed.toFixed(1)}ms`,
        `    Completions/sec: ${completionsPerSecond.toLocaleString()}`,
        `    Target:          ${targetCompletionsPerSecond.toLocaleString()}`,
        `    Coverage mode:   ${isCoverageInstrumentationEnabled() ? 'yes' : 'no'}`,
        `    Headroom:        ${((completionsPerSecond / targetCompletionsPerSecond) * 100 - 100).toFixed(0)}%\n`,
      ].join('\n'),
    );

    expect(completionsPerSecond).toBeGreaterThanOrEqual(targetCompletionsPerSecond);
  }, 60_000);
});
