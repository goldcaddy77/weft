import { afterEach, describe, expect, it } from 'bun:test';

import { Engine } from '../core/engine.ts';
import type { WorkflowContext } from '../core/types.ts';
import { BunSQLiteStorage } from '../storage/bun-sql.ts';

/**
 * K2a: Workflow start throughput benchmark.
 *
 * Measures how many workflows the engine can start per second using an
 * in-memory SQLite backend.
 *
 * Architecture target: 50K/sec. Measured 2026-04-07: ~20K/sec on Apple
 * Silicon (up from ~13K/sec — prepared-statement caching in
 * `BunSQLiteStorage`, the auto-id dedup-skip in `Engine.start`, and the
 * nesting-depth-map allocation skip in `#startWorkflowExecution` closed
 * roughly half the gap to spec). The remaining gap is dominated by the
 * single SQLite WAL fsync per `start()` and the inline strategy's
 * generator drive on the main thread; closing it further requires
 * pipelining or a binary checkpoint format. Tracked in
 * `reference/IMPORTANT.md`.
 *
 * Previous threshold: 5_000 (10_000 on CI), relaxed because ~13K/sec was
 * the prior measured ceiling. New thresholds enforce the post-optimization
 * floor with headroom for machine variance.
 */

const TARGET_STARTS_PER_SECOND = process.env['CI'] ? 8_000 : 18_000;

describe('Workflow start throughput', () => {
  let storage: BunSQLiteStorage;
  let engine: Engine;

  afterEach(() => {
    engine[Symbol.dispose]();
    storage[Symbol.dispose]();
  });

  it(`starts exceed ${TARGET_STARTS_PER_SECOND.toLocaleString()} workflows/sec`, async () => {
    storage = new BunSQLiteStorage(':memory:');
    engine = new Engine({ storage });

    engine.register('noop', async function* (_ctx: WorkflowContext) {
      return 'done';
    });

    const totalStarts = 10_000;

    // Warm up: start a handful of workflows to prime prepared statements,
    // WAL mode, and internal caches.
    for (let i = 0; i < 50; i++) {
      await engine.start('noop', i);
    }

    const start = performance.now();

    for (let i = 0; i < totalStarts; i++) {
      await engine.start('noop', i);
    }

    const elapsed = performance.now() - start;
    const startsPerSecond = Math.round((totalStarts / elapsed) * 1000);

    console.log(
      [
        `\n  Workflow start throughput benchmark:`,
        `    Total starts:    ${totalStarts.toLocaleString()}`,
        `    Elapsed:         ${elapsed.toFixed(1)}ms`,
        `    Starts/sec:      ${startsPerSecond.toLocaleString()}`,
        `    Target:          ${TARGET_STARTS_PER_SECOND.toLocaleString()}`,
        `    Headroom:        ${((startsPerSecond / TARGET_STARTS_PER_SECOND) * 100 - 100).toFixed(0)}%\n`,
      ].join('\n'),
    );

    expect(startsPerSecond).toBeGreaterThanOrEqual(TARGET_STARTS_PER_SECOND);
  }, 60_000);
});
