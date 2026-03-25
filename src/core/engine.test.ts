import { describe, expect, it } from 'bun:test';

import type { Storage as WeftStorage } from '../storage/interface.ts';
import { KEYS } from '../storage/interface.ts';
import { MemoryStorage } from '../storage/memory.ts';
import { decode } from './codec.ts';
import type { Context } from './context.ts';
import { Engine, WorkflowHandle } from './engine.ts';
import {
  WorkflowCancelledEvent,
  WorkflowCompletedEvent,
  WorkflowFailedEvent,
  WorkflowStartedEvent,
} from './events.ts';
import type { WorkflowContext, WorkflowState } from './types.ts';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Drain microtasks so fire-and-forget work completes. */
async function flush(): Promise<void> {
  await Bun.sleep(10);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Engine', () => {
  it('creates engine with no args and defaults to MemoryStorage', () => {
    const engine = new Engine();
    expect(engine).toBeInstanceOf(Engine);
    expect(engine).toBeInstanceOf(EventTarget);
    engine[Symbol.dispose]();
  });

  it('register(name, fn) shorthand registers a workflow', async () => {
    const engine = new Engine();
    const handler = async function* (_ctx: WorkflowContext, input: unknown) {
      return `hello ${input as string}`;
    };

    engine.register('greet', handler);
    const handle = await engine.start('greet', 'world');
    const result = await handle.result();
    expect(result).toBe('hello world');
    engine[Symbol.dispose]();
  });

  it('simple workflow completes with ctx.run', async () => {
    const engine = new Engine();
    const activity = async (...args: unknown[]) => (args[0] as number) * 2;

    engine.register('double', async function* (ctx: WorkflowContext, input: unknown) {
      const result = yield* (ctx as Context).run(activity, input);
      return result;
    });

    const handle = await engine.start('double', 5);
    const result = await handle.result();
    expect(result).toBe(10);
    engine[Symbol.dispose]();
  });

  it('two-step workflow completes both ctx.run calls', async () => {
    const engine = new Engine();
    const add = async (...args: unknown[]) => (args[0] as number) + (args[1] as number);
    const multiply = async (...args: unknown[]) => (args[0] as number) * (args[1] as number);

    engine.register('math', async function* (ctx: WorkflowContext, input: unknown) {
      const sum = yield* (ctx as Context).run(add, input, 3);
      const product = yield* (ctx as Context).run(multiply, sum, 2);
      return product;
    });

    const handle = await engine.start('math', 7);
    const result = await handle.result();
    expect(result).toBe(20); // (7 + 3) * 2
    engine[Symbol.dispose]();
  });

  it('handle.result() resolves with workflow output', async () => {
    const engine = new Engine();
    engine.register('value', async function* () {
      return { answer: 42 };
    });

    const handle = await engine.start('value', null);
    const result = await handle.result();
    expect(result).toEqual({ answer: 42 });
    engine[Symbol.dispose]();
  });

  it('WorkflowStartedEvent fires on start', async () => {
    const engine = new Engine();
    engine.register('noop', async function* () {
      return 'done';
    });

    const events: WorkflowStartedEvent[] = [];
    engine.addEventListener(WorkflowStartedEvent.type, (event) => {
      events.push(event as WorkflowStartedEvent);
    });

    const handle = await engine.start('noop', 'test-input');
    await handle.result();

    expect(events).toHaveLength(1);
    expect(events[0]!.workflowId).toBe(handle.id);
    expect(events[0]!.workflowType).toBe('noop');
    expect(events[0]!.input).toBe('test-input');
    engine[Symbol.dispose]();
  });

  it('WorkflowCompletedEvent fires with result and duration', async () => {
    const engine = new Engine();
    engine.register('fast', async function* () {
      return 'completed';
    });

    const events: WorkflowCompletedEvent[] = [];
    engine.addEventListener(WorkflowCompletedEvent.type, (event) => {
      events.push(event as WorkflowCompletedEvent);
    });

    const handle = await engine.start('fast', null);
    await handle.result();

    expect(events).toHaveLength(1);
    expect(events[0]!.workflowId).toBe(handle.id);
    expect(events[0]!.result).toBe('completed');
    expect(events[0]!.duration).toBeGreaterThanOrEqual(0);
    engine[Symbol.dispose]();
  });

  it('WorkflowFailedEvent fires when workflow throws', async () => {
    const engine = new Engine();
    engine.register('failing', async function* () {
      throw new Error('deliberate failure');
    });

    const events: WorkflowFailedEvent[] = [];
    engine.addEventListener(WorkflowFailedEvent.type, (event) => {
      events.push(event as WorkflowFailedEvent);
    });

    const handle = await engine.start('failing', null);
    await expect(handle.result()).rejects.toThrow('deliberate failure');

    expect(events).toHaveLength(1);
    expect(events[0]!.error.message).toBe('deliberate failure');
    engine[Symbol.dispose]();
  });

  it('cancel() aborts a running workflow', async () => {
    const engine = new Engine();
    const storage = engine.storage as MemoryStorage;

    engine.register('long-running', async function* (ctx: WorkflowContext) {
      yield* (ctx as Context).waitForSignal('never-arrives');
      return 'should not reach';
    });

    const handle = await engine.start('long-running', null);
    // Attach a catch handler before cancelling so the rejection is handled
    const resultPromise = handle.result().catch(() => {});
    await flush();

    await engine.cancel(handle.id);
    await resultPromise;

    const stateBytes = await storage.get(KEYS.workflow(handle.id));
    const state = decode(stateBytes!) as WorkflowState;
    expect(state.status).toBe('cancelled');
    engine[Symbol.dispose]();
  });

  it('WorkflowCancelledEvent fires on cancel', async () => {
    const engine = new Engine();

    engine.register('cancellable', async function* (ctx: WorkflowContext) {
      yield* (ctx as Context).waitForSignal('never');
      return 'nope';
    });

    const events: WorkflowCancelledEvent[] = [];
    engine.addEventListener(WorkflowCancelledEvent.type, (event) => {
      events.push(event as WorkflowCancelledEvent);
    });

    const handle = await engine.start('cancellable', null);
    const resultPromise = handle.result().catch(() => {});
    await flush();
    await engine.cancel(handle.id);
    await resultPromise;

    expect(events).toHaveLength(1);
    expect(events[0]!.workflowId).toBe(handle.id);
    engine[Symbol.dispose]();
  });

  it('signal() writes to storage and delivers to waiting workflow', async () => {
    const engine = new Engine();

    engine.register('signal-workflow', async function* (ctx: WorkflowContext) {
      const payload = yield* (ctx as Context).waitForSignal('my-signal');
      return `received: ${payload as string}`;
    });

    const handle = await engine.start('signal-workflow', null);
    await flush();

    await engine.signal(handle.id, 'my-signal', 'hello-signal');
    const result = await handle.result();

    expect(result).toBe('received: hello-signal');
    engine[Symbol.dispose]();
  });

  it('list() returns workflows', async () => {
    const engine = new Engine();
    engine.register('listable', async function* () {
      return 'ok';
    });

    const h1 = await engine.start('listable', null, { id: 'wf-a' });
    const h2 = await engine.start('listable', null, { id: 'wf-b' });
    await h1.result();
    await h2.result();

    const result = await engine.list();
    expect(result.total).toBe(2);
    expect(result.items.map((item) => item.id).toSorted()).toEqual(['wf-a', 'wf-b']);
    engine[Symbol.dispose]();
  });

  it('list() filters by status', async () => {
    const engine = new Engine();
    engine.register('filterable', async function* () {
      return 'ok';
    });
    engine.register('waiter', async function* (ctx: WorkflowContext) {
      yield* (ctx as Context).waitForSignal('block');
      return 'ok';
    });

    await engine.start('filterable', null, { id: 'done-1' });
    await engine.start('waiter', null, { id: 'running-1' });

    // Wait for the first to complete
    await flush();

    const completedOnly = await engine.list({ status: 'completed' });
    expect(completedOnly.items.every((item) => item.status === 'completed')).toBe(true);
    engine[Symbol.dispose]();
  });

  it('getHandle() returns handle for existing workflow', async () => {
    const engine = new Engine();
    engine.register('gettable', async function* () {
      return 42;
    });

    const handle = await engine.start('gettable', null, { id: 'fixed-id' });
    await handle.result();

    const retrieved = engine.getHandle('fixed-id');
    expect(retrieved).toBeInstanceOf(WorkflowHandle);
    expect(retrieved.id).toBe('fixed-id');
    engine[Symbol.dispose]();
  });

  it('Engine disposal via Symbol.dispose cleans up', () => {
    const engine = new Engine();
    engine.register('disposable', async function* () {
      return 'ok';
    });

    // Should not throw
    engine[Symbol.dispose]();
  });

  it('ctx.sleep pauses workflow via scheduler', async () => {
    let now = 1000;
    const storage = new MemoryStorage();
    const engine = new Engine({ storage: storage as WeftStorage, getNow: () => now });

    engine.register('sleepy', async function* (ctx: WorkflowContext) {
      yield* (ctx as Context).sleep(5000);
      return 'awake';
    });

    const handle = await engine.start('sleepy', null);
    await flush();

    // Workflow should still be running (sleep not yet expired)
    const stateBytes = await storage.get(KEYS.workflow(handle.id));
    const state = decode(stateBytes!) as WorkflowState;
    expect(state.status).toBe('running');

    // Advance time and tick the scheduler
    now = 7000;
    await engine.scheduler.tick(now);
    await flush();

    const result = await handle.result();
    expect(result).toBe('awake');
    engine[Symbol.dispose]();
  });

  it('ctx.all runs parallel operations', async () => {
    const engine = new Engine();
    const double = async (...args: unknown[]) => (args[0] as number) * 2;
    const triple = async (...args: unknown[]) => (args[0] as number) * 3;

    engine.register('parallel-workflow', async function* (ctx: WorkflowContext) {
      const results = yield* (ctx as Context).all([
        (ctx as Context).run(double, 5),
        (ctx as Context).run(triple, 5),
      ]);
      return results;
    });

    const handle = await engine.start('parallel-workflow', null);
    const result = await handle.result();
    expect(result).toEqual([10, 15]);
    engine[Symbol.dispose]();
  });

  it('ctx.race takes first result', async () => {
    const engine = new Engine();
    const fast = async () => 'fast';
    const slow = async () => {
      await Bun.sleep(100);
      return 'slow';
    };

    engine.register('race-workflow', async function* (ctx: WorkflowContext) {
      const result = yield* (ctx as Context).race([
        (ctx as Context).run(fast),
        (ctx as Context).run(slow),
      ]);
      return result;
    });

    const handle = await engine.start('race-workflow', null);
    const result = await handle.result();
    expect(result).toBe('fast');
    engine[Symbol.dispose]();
  });

  it('ctx.memo caches the value', async () => {
    const engine = new Engine();
    let callCount = 0;

    engine.register('memo-workflow', async function* (ctx: WorkflowContext) {
      const first = yield* (ctx as Context).memo('expensive', () => {
        callCount++;
        return 'computed';
      });
      const second = yield* (ctx as Context).memo('expensive', () => {
        callCount++;
        return 'computed-again';
      });
      return { first, second };
    });

    const handle = await engine.start('memo-workflow', null);
    const result = (await handle.result()) as { first: string; second: string };

    // memo('expensive') was called twice, but fn should only execute once
    // The second call returns the cached value from the memo cache in Context
    expect(result.first).toBe('computed');
    expect(result.second).toBe('computed');
    // The fn should have been called once for the first memo and the
    // second memo returns from the memo cache before yielding to the engine
    expect(callCount).toBe(1);
    engine[Symbol.dispose]();
  });

  it('custom workflow ID via options.id', async () => {
    const engine = new Engine();
    engine.register('identified', async function* () {
      return 'ok';
    });

    const handle = await engine.start('identified', null, { id: 'my-custom-id' });
    expect(handle.id).toBe('my-custom-id');
    await handle.result();
    engine[Symbol.dispose]();
  });

  it('activity failure propagates to workflow', async () => {
    const engine = new Engine();
    const failingActivity = async () => {
      throw new Error('activity broke');
    };

    engine.register('activity-fail', async function* (ctx: WorkflowContext) {
      const result = yield* (ctx as Context).run(failingActivity);
      return result;
    });

    const handle = await engine.start('activity-fail', null);
    await expect(handle.result()).rejects.toThrow('activity broke');
    engine[Symbol.dispose]();
  });

  it('throws when starting unregistered workflow type', async () => {
    const engine = new Engine();
    await expect(engine.start('nonexistent', null)).rejects.toThrow('No workflow registered');
    engine[Symbol.dispose]();
  });

  it('throws when starting duplicate workflow ID', async () => {
    const engine = new Engine();
    engine.register('dup', async function* () {
      return 'ok';
    });

    await engine.start('dup', null, { id: 'same-id' });
    await expect(engine.start('dup', null, { id: 'same-id' })).rejects.toThrow('already exists');
    engine[Symbol.dispose]();
  });
});
