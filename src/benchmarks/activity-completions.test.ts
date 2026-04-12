import { describe, expect, it } from 'bun:test';

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
 * Architecture target: 30K/sec. Measured 2026-04-11: ~10K/sec on Apple
 * Silicon (up from ~9K/sec baseline). Optimizations applied: completion
 * state write and attribute cleanup batched into a single storage
 * transaction, scheduler cancel made fire-and-forget for terminal
 * workflows, `#cleanupWorkflowStorage` and `#cleanupReviews` now use
 * `deletePrefix` instead of scan-then-delete loops. The remaining gap
 * requires coalescing terminal cleanup across workflow batches or
 * deferring it to a background queue. Tracked in `reference/IMPORTANT.md`.
 *
 * Previous threshold: 3_000 (5_000 on CI), relaxed because ~9K/sec was
 * the prior measured ceiling. In practice, cross-machine variance and
 * suite-level load still make higher local floors flaky, so the enforced
 * gate stays at the stable 5K/sec baseline until the benchmark harness is
 * isolated from host noise.
 */

const SAMPLES = 5;
const BASELINE_TARGET_COMPLETIONS_PER_SECOND = 5_000;
const COVERAGE_TARGET_COMPLETIONS_PER_SECOND = process.env['CI'] ? 3_000 : 5_000;

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
    function echo(value: unknown): unknown {
      return value;
    }

    engine.registerActivity('echo', echo);

    engine.register('with-activity', async function* (ctx: WorkflowContext) {
      const result = yield* (ctx as Context).run(echo, 42);
      return result;
    });

    // Warm up enough workflows to prime prepared statements, caches, and the
    // completion path before the timed section starts.
    for (let index = 0; index < 50; index += 1) {
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
  it(`completions exceed ${(isCoverageInstrumentationEnabled()
    ? COVERAGE_TARGET_COMPLETIONS_PER_SECOND
    : BASELINE_TARGET_COMPLETIONS_PER_SECOND
  ).toLocaleString()}/sec`, async () => {
    const totalWorkflows = 5_000;
    const targetCompletionsPerSecond = isCoverageInstrumentationEnabled()
      ? COVERAGE_TARGET_COMPLETIONS_PER_SECOND
      : BASELINE_TARGET_COMPLETIONS_PER_SECOND;
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
        `    Target:          ${targetCompletionsPerSecond.toLocaleString()}`,
        `    Coverage mode:   ${isCoverageInstrumentationEnabled() ? 'yes' : 'no'}`,
        `    Spec target:     30,000`,
        `    Headroom:        ${((medianCompletionsPerSecond / targetCompletionsPerSecond) * 100 - 100).toFixed(0)}%\n`,
      ].join('\n'),
    );

    expect(medianCompletionsPerSecond).toBeGreaterThanOrEqual(targetCompletionsPerSecond);
  }, 120_000);
});
