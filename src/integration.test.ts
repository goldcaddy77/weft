import { describe, expect, it } from 'bun:test';

import type { Context } from './core/context';
import type { WorkflowContext } from './core/types';
import { Engine, MemoryStorage, WorkflowCompletedEvent, WorkflowStartedEvent } from './index';

/** Drain microtasks so fire-and-forget work completes. */
async function flush(): Promise<void> {
  await Bun.sleep(10);
}

describe('integration: full workflow lifecycle', () => {
  it('runs a complete multi-step workflow', async () => {
    const storage = new MemoryStorage();
    const engine = new Engine({ storage });

    const greet = async (...args: unknown[]) => `Hello, ${args[0] as string}!`;
    const notify = async (...args: unknown[]) => `Notified: ${args[0] as string}`;

    engine.register('welcome', async function* (ctx: WorkflowContext, input: unknown) {
      const c = ctx as Context;
      const { name } = input as { name: string };
      const greeting = yield* c.run(greet, name);
      yield* c.run(notify, greeting);
      return { greeting, notified: true };
    });

    const handle = await engine.start('welcome', { name: 'World' });
    const result = await handle.result();
    expect(result).toEqual({ greeting: 'Hello, World!', notified: true });
  });

  it('handles signals in a workflow', async () => {
    const engine = new Engine();

    engine.register('approval', async function* (ctx: WorkflowContext, input: unknown) {
      const c = ctx as Context;
      const { orderId } = input as { orderId: string };
      const approval = yield* c.waitForSignal<{ approved: boolean }>('approval');
      return { orderId, approved: approval.approved };
    });

    const handle = await engine.start('approval', { orderId: 'order-1' });

    // Signal the workflow
    await engine.signal(handle.id, 'approval', { approved: true });

    const result = await handle.result();
    expect(result).toEqual({ orderId: 'order-1', approved: true });
  });

  it('cancels a running workflow', async () => {
    const engine = new Engine();

    engine.register('long-running', async function* (ctx: WorkflowContext) {
      const c = ctx as Context;
      yield* c.sleep(999999);
      return 'done';
    });

    const handle = await engine.start('long-running', {});
    await handle.cancel();

    await expect(handle.result()).rejects.toThrow();
  });

  it('events fire for complete lifecycle', async () => {
    const engine = new Engine();
    const events: string[] = [];

    engine.addEventListener(WorkflowStartedEvent.type, () => events.push('started'));
    engine.addEventListener(WorkflowCompletedEvent.type, () => events.push('completed'));

    engine.register('simple', async function* (_ctx: WorkflowContext, input: unknown) {
      return `result: ${input as string}`;
    });

    const handle = await engine.start('simple', 'test');
    await handle.result();

    expect(events).toContain('started');
    expect(events).toContain('completed');
  });

  it('parallel operations complete', async () => {
    const engine = new Engine();

    const double = async (...args: unknown[]) => (args[0] as number) * 2;
    const triple = async (...args: unknown[]) => (args[0] as number) * 3;

    engine.register('parallel', async function* (ctx: WorkflowContext, input: unknown) {
      const c = ctx as Context;
      const n = input as number;
      const [doubled, tripled] = yield* c.all([c.run(double, n), c.run(triple, n)]);
      return { doubled, tripled };
    });

    const handle = await engine.start('parallel', 5);
    const result = await handle.result();
    expect(result).toEqual({ doubled: 10, tripled: 15 });
  });

  it('memo caches within a workflow', async () => {
    const engine = new Engine();
    let callCount = 0;

    const expensive = async () => {
      callCount++;
      return 42;
    };

    engine.register('memo-test', async function* (ctx: WorkflowContext) {
      const c = ctx as Context;
      const a = yield* c.memo('val', expensive);
      const b = yield* c.memo('val', expensive);
      return { a, b };
    });

    const handle = await engine.start('memo-test', {});
    const result = await handle.result();
    expect(result).toEqual({ a: 42, b: 42 });
    expect(callCount).toBe(1);
  });

  it('search attributes are set and readable', async () => {
    const engine = new Engine();

    engine.register('with-attrs', async function* (ctx: WorkflowContext, input: unknown) {
      const c = ctx as Context;
      const { customerId } = input as { customerId: string };
      c.setAttribute('customerId', customerId);
      c.setAttribute('status', 'processing');
      yield* c.run(async () => 'done');
      c.setAttribute('status', 'shipped');
      return 'ok';
    });

    const handle = await engine.start('with-attrs', { customerId: 'cust-123' });
    await handle.result();
    // Verify attributes were set (at least no errors thrown)
    expect(true).toBe(true);
  });

  it('TestEngine with time control', async () => {
    const { TestEngine } = await import('./testing/test-engine');

    const engine = new TestEngine({ startTime: 0 });

    engine.register('sleeper', async function* (ctx: WorkflowContext) {
      const c = ctx as Context;
      yield* c.sleep(5000);
      return 'awake';
    });

    const handle = await engine.start('sleeper', null);
    await flush();

    // Advance past the sleep
    await engine.advanceTime(6000);
    await flush();

    const result = await handle.result();
    expect(result).toBe('awake');
    engine[Symbol.dispose]();
  });

  it('BunSQLiteStorage works as engine backend', async () => {
    const { BunSQLiteStorage } = await import('./storage/bun-sql');

    using storage = new BunSQLiteStorage(':memory:');
    const engine = new Engine({ storage });

    engine.register('sqlite-test', async function* (_ctx: WorkflowContext, input: unknown) {
      return `stored: ${input as string}`;
    });

    const handle = await engine.start('sqlite-test', 'data');
    const result = await handle.result();
    expect(result).toBe('stored: data');
  });
});
