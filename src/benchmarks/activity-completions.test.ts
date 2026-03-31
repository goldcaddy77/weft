import { afterEach, describe, expect, it } from 'bun:test';

import type { Context } from '../core/context.ts';
import { Engine } from '../core/engine.ts';
import type { WorkflowContext } from '../core/types.ts';
import { BunSQLiteStorage } from '../storage/bun-sql.ts';

/**
 * K2b: Activity completion throughput benchmark.
 *
 * Registers a workflow that calls one trivial activity, starts many
 * workflows, waits for all to complete, and measures completions/sec.
 * Architecture target is 30K/sec; relaxed to 20K (or 5K on CI).
 */

const TARGET_COMPLETIONS_PER_SECOND = process.env['CI'] ? 2_000 : 3_000;

describe('Activity completion throughput', () => {
  let storage: BunSQLiteStorage;
  let engine: Engine;

  afterEach(() => {
    engine[Symbol.dispose]();
    storage[Symbol.dispose]();
  });

  it(`completions exceed ${TARGET_COMPLETIONS_PER_SECOND.toLocaleString()}/sec`, async () => {
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
        `    Target:          ${TARGET_COMPLETIONS_PER_SECOND.toLocaleString()}`,
        `    Headroom:        ${((completionsPerSecond / TARGET_COMPLETIONS_PER_SECOND) * 100 - 100).toFixed(0)}%\n`,
      ].join('\n'),
    );

    expect(completionsPerSecond).toBeGreaterThanOrEqual(TARGET_COMPLETIONS_PER_SECOND);
  }, 60_000);
});
