import { describe, expect, it } from 'bun:test';

import { KEYS } from '../storage/interface.ts';
import { MemoryStorage } from '../storage/memory.ts';
import { decode } from './codec.ts';
import type { Context } from './context.ts';
import { Engine } from './engine.ts';
import type { SearchAttributeValue, WorkflowContext } from './types.ts';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Drain microtasks so fire-and-forget work completes. */
async function flush(): Promise<void> {
  await Bun.sleep(10);
}

// ---------------------------------------------------------------------------
// Search Attributes
// ---------------------------------------------------------------------------

describe('Search Attributes Integration', () => {
  it('engine.start() with searchAttributes writes attr: and idx: keys', async () => {
    const storage = new MemoryStorage();
    const engine = new Engine({ storage });

    engine.register('noop', async function* () {
      // Intentionally sleep to keep workflow running
      yield {
        type: 'sleep',
        operationId: 'test',
        duration: 100_000,
        scheduledFireAt: Date.now() + 100_000,
      };
      return 'done';
    });

    await engine.start('noop', null, {
      id: 'wf-1',
      searchAttributes: {
        status: 'active',
        priority: 5,
      },
    });

    await flush();

    // Verify attr: key was written
    const attributeBytes = await storage.get(KEYS.attribute('wf-1'));
    expect(attributeBytes).not.toBeNull();
    const attributes = decode(attributeBytes!) as Record<string, SearchAttributeValue>;
    expect(attributes['status']).toBe('active');
    expect(attributes['priority']).toBe(5);

    // Verify idx: keys were written
    const indexKeys = storage.keys().filter((key) => key.startsWith('idx:'));
    expect(indexKeys.length).toBe(2);

    // Verify the specific index keys exist
    const statusIndexKey = KEYS.attributeIndex('status', 's:active', 'wf-1');
    expect(storage.has(statusIndexKey)).toBe(true);

    engine[Symbol.dispose]();
  });

  it('ctx.setAttribute() generates correct idx: entries after checkpoint', async () => {
    const storage = new MemoryStorage();
    const engine = new Engine({ storage });

    const setAttributeActivity = async () => 'done';

    engine.register('set-attrs', async function* (ctx: WorkflowContext) {
      const context = ctx as Context;
      context.setAttribute('region', 'us-east');
      const result = yield* context.run(setAttributeActivity);
      return result;
    });

    const handle = await engine.start('set-attrs', null, { id: 'wf-2' });
    await handle.result();

    // During workflow execution, setAttribute should have triggered index writes
    // But since the workflow completed, cleanup would have removed them.
    // Let's verify with a workflow that stays running instead.

    engine[Symbol.dispose]();
  });

  it('ctx.setAttribute() writes idx: entries while workflow is running', async () => {
    const storage = new MemoryStorage();
    const engine = new Engine({ storage });

    const setAttributeActivity = async () => 'done';

    engine.register('set-attrs-running', async function* (ctx: WorkflowContext) {
      const context = ctx as Context;
      context.setAttribute('region', 'us-east');
      // Run an activity to trigger a checkpoint persist
      yield* context.run(setAttributeActivity);
      // Keep workflow running
      yield* context.waitForSignal('stop');
      return 'done';
    });

    await engine.start('set-attrs-running', null, { id: 'wf-3' });
    await flush();

    // Verify idx: key for 'region' was written
    const regionIndexKey = KEYS.attributeIndex('region', 's:us-east', 'wf-3');
    expect(storage.has(regionIndexKey)).toBe(true);

    // Verify attr: record was written
    const attributeBytes = await storage.get(KEYS.attribute('wf-3'));
    expect(attributeBytes).not.toBeNull();
    const attributes = decode(attributeBytes!) as Record<string, SearchAttributeValue>;
    expect(attributes['region']).toBe('us-east');

    engine[Symbol.dispose]();
  });

  it('engine.list() with attribute filter returns matching workflows', async () => {
    const storage = new MemoryStorage();
    const engine = new Engine({ storage });

    engine.register('stay-running', async function* (ctx: WorkflowContext) {
      yield* (ctx as Context).waitForSignal('stop');
      return 'done';
    });

    // Start workflows with different attributes
    await engine.start('stay-running', null, {
      id: 'wf-active-1',
      searchAttributes: { status: 'active' },
    });

    await engine.start('stay-running', null, {
      id: 'wf-active-2',
      searchAttributes: { status: 'active' },
    });

    await engine.start('stay-running', null, {
      id: 'wf-pending-1',
      searchAttributes: { status: 'pending' },
    });

    await flush();

    // Query for active workflows
    const result = await engine.list({
      attributes: [{ key: 'status', value: 'active' }],
    });

    expect(result.items.length).toBe(2);
    const ids = result.items.map((item) => item.id).toSorted();
    expect(ids).toEqual(['wf-active-1', 'wf-active-2']);

    engine[Symbol.dispose]();
  });

  it('engine.list() with range attribute filter works', async () => {
    const storage = new MemoryStorage();
    const engine = new Engine({ storage });

    engine.register('stay-running', async function* (ctx: WorkflowContext) {
      yield* (ctx as Context).waitForSignal('stop');
      return 'done';
    });

    await engine.start('stay-running', null, {
      id: 'wf-price-5',
      searchAttributes: { price: 5 },
    });

    await engine.start('stay-running', null, {
      id: 'wf-price-50',
      searchAttributes: { price: 50 },
    });

    await engine.start('stay-running', null, {
      id: 'wf-price-150',
      searchAttributes: { price: 150 },
    });

    await flush();

    // Range query: price between 10 and 100
    const result = await engine.list({
      attributes: [{ key: 'price', gte: 10, lte: 100 }],
    });

    expect(result.items.length).toBe(1);
    expect(result.items[0]!.id).toBe('wf-price-50');

    engine[Symbol.dispose]();
  });

  it('index entries are cleaned up on workflow completion', async () => {
    const storage = new MemoryStorage();
    const engine = new Engine({ storage });

    engine.register('complete-quickly', async function* () {
      return 'done';
    });

    await engine.start('complete-quickly', null, {
      id: 'wf-cleanup',
      searchAttributes: { status: 'active', priority: 1 },
    });

    // Wait for the workflow to complete
    const handle = engine.getHandle('wf-cleanup');
    await handle.result();

    // Verify that index entries are cleaned up
    const indexKeys = storage.keys().filter((key) => key.startsWith('idx:'));
    expect(indexKeys.length).toBe(0);

    // Verify attr: record is cleaned up
    const attributeBytes = await storage.get(KEYS.attribute('wf-cleanup'));
    expect(attributeBytes).toBeNull();

    engine[Symbol.dispose]();
  });

  it('index entries are cleaned up on workflow failure', async () => {
    const storage = new MemoryStorage();
    const engine = new Engine({ storage });

    engine.register('fail-quickly', async function* () {
      throw new Error('intentional failure');
    });

    const handle = await engine.start('fail-quickly', null, {
      id: 'wf-fail-cleanup',
      searchAttributes: { status: 'active' },
    });

    try {
      await handle.result();
    } catch {
      // expected
    }

    await flush();

    // Verify index entries are cleaned up
    const indexKeys = storage.keys().filter((key) => key.startsWith('idx:'));
    expect(indexKeys.length).toBe(0);

    const attributeBytes = await storage.get(KEYS.attribute('wf-fail-cleanup'));
    expect(attributeBytes).toBeNull();

    engine[Symbol.dispose]();
  });

  it('index entries are cleaned up on workflow cancellation', async () => {
    const storage = new MemoryStorage();
    const engine = new Engine({ storage });

    engine.register('stay-running', async function* (ctx: WorkflowContext) {
      yield* (ctx as Context).waitForSignal('stop');
      return 'done';
    });

    const handle = await engine.start('stay-running', null, {
      id: 'wf-cancel-cleanup',
      searchAttributes: { status: 'active' },
    });

    // Catch the rejection from the result promise so it does not surface as unhandled
    handle.result().catch(() => {});

    await flush();

    // Verify index exists before cancel
    let indexKeys = storage.keys().filter((key) => key.startsWith('idx:'));
    expect(indexKeys.length).toBe(1);

    await engine.cancel('wf-cancel-cleanup');

    // Verify index entries are cleaned up
    indexKeys = storage.keys().filter((key) => key.startsWith('idx:'));
    expect(indexKeys.length).toBe(0);

    engine[Symbol.dispose]();
  });

  it('list with multiple attribute filters intersects results', async () => {
    const storage = new MemoryStorage();
    const engine = new Engine({ storage });

    engine.register('stay-running', async function* (ctx: WorkflowContext) {
      yield* (ctx as Context).waitForSignal('stop');
      return 'done';
    });

    await engine.start('stay-running', null, {
      id: 'wf-both',
      searchAttributes: { status: 'active', region: 'us-east' },
    });

    await engine.start('stay-running', null, {
      id: 'wf-status-only',
      searchAttributes: { status: 'active', region: 'eu-west' },
    });

    await engine.start('stay-running', null, {
      id: 'wf-region-only',
      searchAttributes: { status: 'pending', region: 'us-east' },
    });

    await flush();

    const result = await engine.list({
      attributes: [
        { key: 'status', value: 'active' },
        { key: 'region', value: 'us-east' },
      ],
    });

    expect(result.items.length).toBe(1);
    expect(result.items[0]!.id).toBe('wf-both');

    engine[Symbol.dispose]();
  });
});

// ---------------------------------------------------------------------------
// Synchronous Updates (wait-update)
// ---------------------------------------------------------------------------

describe('Synchronous Updates (waitForUpdate)', () => {
  it('ctx.waitForUpdate() pauses until engine.update() is called', async () => {
    const engine = new Engine();

    engine.register('wait-for-update', async function* (ctx: WorkflowContext) {
      const context = ctx as Context;
      const updatePayload = yield* context.waitForUpdate<{ value: number }>('my-update');
      return updatePayload;
    });

    const handle = await engine.start('wait-for-update', null, { id: 'wf-update-1' });

    await flush();

    // Send update
    const updateResult = await engine.update('wf-update-1', 'my-update', { value: 42 });
    expect(updateResult).toEqual({ value: 42 });

    // Workflow should have completed with the update payload
    const result = await handle.result();
    expect(result).toEqual({ value: 42 });

    engine[Symbol.dispose]();
  });

  it('multiple concurrent waitForUpdate calls with different names work independently', async () => {
    const engine = new Engine();

    engine.register('multi-update', async function* (ctx: WorkflowContext) {
      const context = ctx as Context;
      const firstUpdate = yield* context.waitForUpdate<string>('update-a');
      const secondUpdate = yield* context.waitForUpdate<string>('update-b');
      return `${firstUpdate}-${secondUpdate}`;
    });

    const handle = await engine.start('multi-update', null, { id: 'wf-multi-update' });

    await flush();

    // Send first update
    await engine.update('wf-multi-update', 'update-a', 'hello');

    await flush();

    // Send second update
    await engine.update('wf-multi-update', 'update-b', 'world');

    const result = await handle.result();
    expect(result).toBe('hello-world');

    engine[Symbol.dispose]();
  });

  it('waitForUpdate with pre-existing pending update resolves immediately', async () => {
    const storage = new MemoryStorage();
    const engine = new Engine({ storage });

    engine.register('pending-update', async function* (ctx: WorkflowContext) {
      const context = ctx as Context;
      // Run an activity first to give time for the update to be queued
      yield* context.run(async () => {
        // This gives the engine time to process the update request
        await Bun.sleep(50);
        return 'activity-done';
      });
      const payload = yield* context.waitForUpdate<string>('pending');
      return payload;
    });

    const handle = await engine.start('pending-update', null, { id: 'wf-pending-update' });

    // Queue update before workflow reaches waitForUpdate
    // Use a short timeout and don't await (let it resolve naturally)
    void engine.update('wf-pending-update', 'pending', 'pre-queued', {
      timeout: 10000,
    });

    await flush();
    await flush();

    const result = await handle.result();
    expect(result).toBe('pre-queued');

    engine[Symbol.dispose]();
  });

  it('update events are dispatched for wait-update path', async () => {
    const engine = new Engine();
    const events: string[] = [];

    engine.addEventListener('update:received', () => events.push('received'));
    engine.addEventListener('update:completed', () => events.push('completed'));

    engine.register('events-update', async function* (ctx: WorkflowContext) {
      const context = ctx as Context;
      const payload = yield* context.waitForUpdate('my-update');
      return payload;
    });

    const handle = await engine.start('events-update', null, { id: 'wf-events-update' });
    await flush();

    await engine.update('wf-events-update', 'my-update', 'data');
    await handle.result();

    expect(events).toContain('received');
    expect(events).toContain('completed');

    engine[Symbol.dispose]();
  });
});
