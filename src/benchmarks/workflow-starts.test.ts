import { describe, expect, it } from 'bun:test';

import { Engine } from '../core/engine.ts';
import type { WorkflowContext } from '../core/types.ts';
import { BunSQLiteStorage } from '../storage/bun-sql.ts';
import { isCoverageInstrumentationEnabled } from './coverage-mode.ts';

/**
 * K2a: Workflow start throughput benchmark.
 *
 * Measures how many workflows the engine can start per second using an
 * in-memory SQLite backend.
 *
 * Architecture target: 50K/sec. Measured 2026-04-12: ~17.4-18.6K/sec in
 * direct runs on this machine and ~16.2-17.8K/sec in isolated
 * `bun test --coverage` runs, still far above the pre-optimization ~13K/sec
 * baseline. Optimizations applied: prepared-statement caching in
 * `BunSQLiteStorage`, auto-id dedup-skip in `Engine.start`,
 * nesting-depth-map allocation skip, deadline timer operations folded
 * into the start batch (eliminating a separate storage transaction), and
 * checkpoint history pruning made non-blocking. The remaining gap is
 * dominated by the per-start SQLite WAL fsync and the inline strategy's
 * generator drive on the main thread; closing it further requires
 * pipelining or a binary checkpoint format. Tracked in
 * `reference/IMPORTANT.md`.
 *
 * Previous threshold: 5_000 (10_000 on CI), relaxed because ~13K/sec was
 * the prior measured ceiling. In practice, cross-machine variance and
 * suite-level load still make higher local floors flaky, so the enforced
 * gate stays at a stable 10K/sec baseline until the benchmark harness is
 * isolated from host noise.
 */

const SAMPLES = 5;
const BASELINE_TARGET_STARTS_PER_SECOND = 10_000;
const COVERAGE_TARGET_STARTS_PER_SECOND = process.env['CI'] ? 8_000 : 10_000;

function percentile(sorted: number[], fraction: number): number {
  if (sorted.length === 0) {
    return 0;
  }

  const index = Math.min(sorted.length - 1, Math.floor(sorted.length * fraction));
  return sorted[index]!;
}

async function measureStartsPerSecond(totalStarts: number): Promise<number> {
  const storage = new BunSQLiteStorage(':memory:');
  const engine = new Engine({ storage });
  try {
    engine.register('noop', async function* (_ctx: WorkflowContext) {
      return 'done';
    });

    // Warm up: start a handful of workflows to prime prepared statements,
    // WAL mode, and internal caches.
    for (let index = 0; index < 50; index += 1) {
      const handle = await engine.start('noop', index);
      await handle.result();
    }

    const handles: Array<{ result: () => Promise<unknown> }> = [];
    const start = performance.now();

    for (let index = 0; index < totalStarts; index += 1) {
      const handle = await engine.start('noop', index);
      handles.push(handle);
    }

    const elapsed = performance.now() - start;
    await Promise.all(handles.map((handle) => handle.result()));
    return Math.round((totalStarts / elapsed) * 1000);
  } finally {
    engine[Symbol.dispose]();
    storage[Symbol.dispose]();
  }
}

describe('Workflow start throughput', () => {
  it(`starts exceed ${(isCoverageInstrumentationEnabled()
    ? COVERAGE_TARGET_STARTS_PER_SECOND
    : BASELINE_TARGET_STARTS_PER_SECOND
  ).toLocaleString()} workflows/sec`, async () => {
    const totalStarts = 10_000;
    const targetStartsPerSecond = isCoverageInstrumentationEnabled()
      ? COVERAGE_TARGET_STARTS_PER_SECOND
      : BASELINE_TARGET_STARTS_PER_SECOND;
    const samples: number[] = [];

    for (let sample = 0; sample < SAMPLES; sample += 1) {
      samples.push(await measureStartsPerSecond(totalStarts));
    }

    samples.sort((left, right) => left - right);
    const medianStartsPerSecond = percentile(samples, 0.5);

    console.log(
      [
        `\n  Workflow start throughput benchmark:`,
        `    Total starts:    ${totalStarts.toLocaleString()}`,
        `    Samples:         ${samples.map((sample) => sample.toLocaleString()).join(', ')}`,
        `    Median/sec:      ${medianStartsPerSecond.toLocaleString()}`,
        `    Target:          ${targetStartsPerSecond.toLocaleString()}`,
        `    Coverage mode:   ${isCoverageInstrumentationEnabled() ? 'yes' : 'no'}`,
        `    Spec target:     50,000`,
        `    Headroom:        ${((medianStartsPerSecond / targetStartsPerSecond) * 100 - 100).toFixed(0)}%\n`,
      ].join('\n'),
    );

    expect(medianStartsPerSecond).toBeGreaterThanOrEqual(targetStartsPerSecond);
  }, 120_000);
});
