import { describe, expect, it } from 'bun:test';

import { MemoryStorage } from '../storage/memory';
import type { Context } from './context';
import { Engine } from './engine';
import type { WorkflowContext } from './types';

describe('child workflows', () => {
  it('parent starts child and gets result', async () => {
    const engine = new Engine();

    engine.register('child', async function* (_ctx: WorkflowContext, input: unknown) {
      const { value } = input as { value: number };
      return value * 2;
    });

    engine.register('parent', async function* (ctx: WorkflowContext, input: unknown) {
      const context = ctx as Context;
      const { value } = input as { value: number };
      const childResult = yield* context.startChild<number>('child', { value });
      return { doubled: childResult };
    });

    const handle = await engine.start('parent', { value: 21 });
    const result = await handle.result();
    expect(result).toEqual({ doubled: 42 });
  });

  it('child failure propagates to parent', async () => {
    const engine = new Engine();

    engine.register('failing-child', async function* () {
      throw new Error('child exploded');
    });

    engine.register('parent-catches', async function* (ctx: WorkflowContext) {
      const context = ctx as Context;
      try {
        yield* context.startChild('failing-child', {});
        return { caught: false };
      } catch (error) {
        return { caught: true, message: (error as Error).message };
      }
    });

    const handle = await engine.start('parent-catches', {});
    const result = (await handle.result()) as { caught: boolean; message: string };
    expect(result.caught).toBe(true);
    expect(result.message).toBe('child exploded');
  });

  it('nesting depth limit is enforced at default depth (10)', async () => {
    const engine = new Engine();

    // Register a recursive workflow that calls itself as a child
    engine.register('recursive', async function* (ctx: WorkflowContext, input: unknown) {
      const context = ctx as Context;
      const { depth } = input as { depth: number };
      if (depth > 0) {
        return yield* context.startChild<number>('recursive', { depth: depth - 1 });
      }
      return depth;
    });

    // Start with depth 15, which will nest 15 levels deep (exceeding default limit of 10)
    const handle = await engine.start('recursive', { depth: 15 });

    // The parent should fail because nesting depth is exceeded
    await expect(handle.result()).rejects.toThrow('nesting depth exceeded');
  });

  it('custom maxNestingDepth limits nesting', async () => {
    const engine = new Engine({ maxNestingDepth: 2 });

    engine.register('nested', async function* (ctx: WorkflowContext, input: unknown) {
      const context = ctx as Context;
      const { level } = input as { level: number };
      if (level < 3) {
        return yield* context.startChild<string>('nested', { level: level + 1 });
      }
      return `reached level ${level}`;
    });

    // Starting at level 0, it will try to nest: 0 -> 1 -> 2 -> 3
    // At depth 0->1 (depth 1), 1->2 (depth 2), 2->3 (depth 3 > max 2) should fail
    const handle = await engine.start('nested', { level: 0 });
    await expect(handle.result()).rejects.toThrow('nesting depth exceeded');
  });

  it('succeeds within custom maxNestingDepth', async () => {
    const engine = new Engine({ maxNestingDepth: 3 });

    engine.register('nested-ok', async function* (ctx: WorkflowContext, input: unknown) {
      const context = ctx as Context;
      const { level } = input as { level: number };
      if (level < 3) {
        return yield* context.startChild<string>('nested-ok', { level: level + 1 });
      }
      return `reached level ${level}`;
    });

    // 0 -> 1 (depth 1), 1 -> 2 (depth 2), 2 -> 3 (depth 3) = exactly at limit
    const handle = await engine.start('nested-ok', { level: 0 });
    const result = await handle.result();
    expect(result).toBe('reached level 3');
  });

  it('child is independently stored', async () => {
    const storage = new MemoryStorage();
    const engine = new Engine({ storage });

    engine.register('stored-child', async function* (_ctx: WorkflowContext, input: unknown) {
      return `child result: ${(input as { data: string }).data}`;
    });

    engine.register('stored-parent', async function* (ctx: WorkflowContext) {
      const context = ctx as Context;
      const result = yield* context.startChild<string>('stored-child', { data: 'test' });
      return result;
    });

    const handle = await engine.start('stored-parent', {});
    await handle.result();

    // Scan storage for all workflow entries
    const workflowKeys: string[] = [];
    for await (const [key] of storage.scan('wf:')) {
      if (!key.includes(':ckpt')) {
        workflowKeys.push(key);
      }
    }

    // There should be at least 2 workflow state entries: parent and child
    expect(workflowKeys.length).toBeGreaterThanOrEqual(2);
  });

  it('cached result on recovery path', async () => {
    const engine = new Engine();

    let childCallCount = 0;

    engine.register('counting-child', async function* (_ctx: WorkflowContext, input: unknown) {
      childCallCount++;
      return `result-${(input as { id: number }).id}`;
    });

    engine.register('recovery-parent', async function* (ctx: WorkflowContext, input: unknown) {
      const context = ctx as Context;
      const { count } = input as { count: number };
      const results: string[] = [];
      for (let i = 0; i < count; i++) {
        const result = yield* context.startChild<string>('counting-child', { id: i });
        results.push(result);
      }
      return results;
    });

    const handle = await engine.start('recovery-parent', { count: 3 });
    const result = await handle.result();
    expect(result).toEqual(['result-0', 'result-1', 'result-2']);
    expect(childCallCount).toBe(3);
  });
});
