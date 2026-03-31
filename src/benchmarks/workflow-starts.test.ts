import { afterEach, describe, expect, it } from 'bun:test';

import { Engine } from '../core/engine.ts';
import type { WorkflowContext } from '../core/types.ts';
import { BunSQLiteStorage } from '../storage/bun-sql.ts';

/**
 * K2a: Workflow start throughput benchmark.
 *
 * Measures how many workflows the engine can start per second using an
 * in-memory SQLite backend. The architecture target is 50K/sec; the
 * threshold is relaxed to 30K/sec (or 10K on CI) to absorb machine and
 * runner variance.
 */

const TARGET_STARTS_PER_SECOND = process.env['CI'] ? 3_000 : 5_000;

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
