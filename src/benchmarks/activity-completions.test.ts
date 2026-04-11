import { describe, expect, it } from 'bun:test';

import type { Context } from '../core/context.ts';
import { Engine } from '../core/engine.ts';
import type { WorkflowContext } from '../core/types.ts';
import { BunSQLiteStorage } from '../storage/bun-sql.ts';

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

const SAMPLES = 5;
const CI_TARGET_COMPLETIONS_PER_SECOND = 5_000;
const LOCAL_TARGET_COMPLETIONS_PER_SECOND = 9_000;
const TARGET_COMPLETIONS_PER_SECOND = process.env['CI']
  ? CI_TARGET_COMPLETIONS_PER_SECOND
  : LOCAL_TARGET_COMPLETIONS_PER_SECOND;

function percentile(sorted: number[], fraction: number): number {
  if (sorted.length === 0) {
    return 0;
  }

  const index = Math.min(sorted.length - 1, Math.floor(sorted.length * fraction));
  return sorted[index]!;
}

async function measureCompletionsPerSecond(totalWorkflows: number): Promise<number> {
  const storage = new BunSQLiteStorage(':memory:');
  const engine = new Engine({ storage });

  try {
    // A trivial activity that returns its input.
    function echo(value: unknown): unknown {
      return value;
    }

    engine.registerActivity('echo', echo);

    engine.register('with-activity', async function* (ctx: WorkflowContext) {
      const result = yield* (ctx as Context).run(echo, 42);
      return result;
    });

    // Warm up.
    for (let index = 0; index < 20; index += 1) {
      const handle = await engine.start('with-activity', index);
      await handle.result();
    }

    const handles: Array<{ result: () => Promise<unknown> }> = [];
    const start = performance.now();

    for (let index = 0; index < totalWorkflows; index += 1) {
      const handle = await engine.start('with-activity', index);
      handles.push(handle);
    }

    await Promise.all(handles.map((handle) => handle.result()));

    const elapsed = performance.now() - start;
    return Math.round((totalWorkflows / elapsed) * 1000);
  } finally {
    engine[Symbol.dispose]();
    storage[Symbol.dispose]();
  }
}

describe('Activity completion throughput', () => {
  it(`completions exceed ${TARGET_COMPLETIONS_PER_SECOND.toLocaleString()}/sec`, async () => {
    const totalWorkflows = 5_000;
    const samples: number[] = [];

    for (let sample = 0; sample < SAMPLES; sample += 1) {
      samples.push(await measureCompletionsPerSecond(totalWorkflows));
    }

    samples.sort((left, right) => left - right);
    const medianCompletionsPerSecond = percentile(samples, 0.5);

    console.log(
      [
        `\n  Activity completion throughput benchmark:`,
        `    Total workflows: ${totalWorkflows.toLocaleString()}`,
        `    Samples:         ${samples.map((sample) => sample.toLocaleString()).join(', ')}`,
        `    Median/sec:      ${medianCompletionsPerSecond.toLocaleString()}`,
        `    Target:          ${TARGET_COMPLETIONS_PER_SECOND.toLocaleString()}`,
        `    Spec target:     30,000`,
        `    Headroom:        ${((medianCompletionsPerSecond / TARGET_COMPLETIONS_PER_SECOND) * 100 - 100).toFixed(0)}%\n`,
      ].join('\n'),
    );

    expect(medianCompletionsPerSecond).toBeGreaterThanOrEqual(TARGET_COMPLETIONS_PER_SECOND);
  }, 120_000);
});
