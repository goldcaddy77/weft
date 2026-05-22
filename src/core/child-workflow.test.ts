import { describe, expect, it } from 'bun:test';

import { MemoryStorage } from '../storage/memory';
import { Engine } from './engine';
import type { WorkflowContext } from './types';
import { workflow } from './types';

describe('child workflows', () => {
  it('parent starts child and gets result', async () => {
    const engine = new Engine();

    const childWorkflow = workflow({ name: 'child' }).execute(async function* (
      _ctx: WorkflowContext,
      input: unknown,
    ) {
      const { value } = input as { value: number };
      return value * 2;
    });
    engine.register(childWorkflow);

    const parentWorkflow = workflow({ name: 'parent' }).execute(async function* (
      ctx: WorkflowContext,
      input: unknown,
    ) {
      const context = ctx;
      const { value } = input as { value: number };
      const childResult = yield* context.startChild<number>('child', { value });
      return { doubled: childResult };
    });
    engine.register(parentWorkflow);

    const handle = await engine.start('parent', { value: 21 });
    const result = await handle.result();
    expect(result).toEqual({ doubled: 42 });
  });

  it('child failure propagates to parent', async () => {
    const engine = new Engine();

    const failingChildWorkflow = workflow({ name: 'failing-child' }).execute(async function* () {
      throw new Error('child exploded');
    });
    engine.register(failingChildWorkflow);

    const parentCatchesWorkflow = workflow({ name: 'parent-catches' }).execute(async function* (
      ctx: WorkflowContext,
    ) {
      const context = ctx;
      try {
        yield* context.startChild('failing-child', {});
        return { caught: false };
      } catch (error) {
        return { caught: true, message: (error as Error).message };
      }
    });
    engine.register(parentCatchesWorkflow);

    const handle = await engine.start('parent-catches', {});
    const result = (await handle.result()) as { caught: boolean; message: string };
    expect(result.caught).toBe(true);
    expect(result.message).toBe('child exploded');
  });

  it('nesting depth limit is enforced at default depth (10)', async () => {
    const engine = new Engine();

    // Register a recursive workflow that calls itself as a child
    const recursiveWorkflow = workflow({ name: 'recursive' }).execute(async function* (
      ctx: WorkflowContext,
      input: unknown,
    ) {
      const context = ctx;
      const { depth } = input as { depth: number };
      if (depth > 0) {
        return yield* context.startChild<number>('recursive', { depth: depth - 1 });
      }
      return depth;
    });
    engine.register(recursiveWorkflow);

    // Start with depth 15, which will nest 15 levels deep (exceeding default limit of 10)
    const handle = await engine.start('recursive', { depth: 15 });

    // The parent should fail because nesting depth is exceeded
    await expect(handle.result()).rejects.toThrow('nesting depth exceeded');
  });

  it('custom maxNestingDepth limits nesting', async () => {
    const engine = new Engine({ maxNestingDepth: 2 });

    const nestedWorkflow = workflow({ name: 'nested' }).execute(async function* (
      ctx: WorkflowContext,
      input: unknown,
    ) {
      const context = ctx;
      const { level } = input as { level: number };
      if (level < 3) {
        return yield* context.startChild<string>('nested', { level: level + 1 });
      }
      return `reached level ${level}`;
    });
    engine.register(nestedWorkflow);

    // Starting at level 0, it will try to nest: 0 -> 1 -> 2 -> 3
    // At depth 0->1 (depth 1), 1->2 (depth 2), 2->3 (depth 3 > max 2) should fail
    const handle = await engine.start('nested', { level: 0 });
    await expect(handle.result()).rejects.toThrow('nesting depth exceeded');
  });

  it('succeeds within custom maxNestingDepth', async () => {
    const engine = new Engine({ maxNestingDepth: 3 });

    const nestedOkWorkflow = workflow({ name: 'nested-ok' }).execute(async function* (
      ctx: WorkflowContext,
      input: unknown,
    ) {
      const context = ctx;
      const { level } = input as { level: number };
      if (level < 3) {
        return yield* context.startChild<string>('nested-ok', { level: level + 1 });
      }
      return `reached level ${level}`;
    });
    engine.register(nestedOkWorkflow);

    // 0 -> 1 (depth 1), 1 -> 2 (depth 2), 2 -> 3 (depth 3) = exactly at limit
    const handle = await engine.start('nested-ok', { level: 0 });
    const result = await handle.result();
    expect(result).toBe('reached level 3');
  });

  it('child is independently stored', async () => {
    const storage = new MemoryStorage();
    const engine = new Engine({ storage });

    const storedChildWorkflow = workflow({ name: 'stored-child' }).execute(async function* (
      _ctx: WorkflowContext,
      input: unknown,
    ) {
      return `child result: ${(input as { data: string }).data}`;
    });
    engine.register(storedChildWorkflow);

    const storedParentWorkflow = workflow({ name: 'stored-parent' }).execute(async function* (
      ctx: WorkflowContext,
    ) {
      const context = ctx;
      const result = yield* context.startChild<string>('stored-child', { data: 'test' });
      return result;
    });
    engine.register(storedParentWorkflow);

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

    const countingChildWorkflow = workflow({ name: 'counting-child' }).execute(async function* (
      _ctx: WorkflowContext,
      input: unknown,
    ) {
      childCallCount++;
      return `result-${(input as { id: number }).id}`;
    });
    engine.register(countingChildWorkflow);

    const recoveryParentWorkflow = workflow({ name: 'recovery-parent' }).execute(async function* (
      ctx: WorkflowContext,
      input: unknown,
    ) {
      const context = ctx;
      const { count } = input as { count: number };
      const results: string[] = [];
      for (let i = 0; i < count; i++) {
        const result = yield* context.startChild<string>('counting-child', { id: i });
        results.push(result);
      }
      return results;
    });
    engine.register(recoveryParentWorkflow);

    const handle = await engine.start('recovery-parent', { count: 3 });
    const result = await handle.result();
    expect(result).toEqual(['result-0', 'result-1', 'result-2']);
    expect(childCallCount).toBe(3);
  });
});
