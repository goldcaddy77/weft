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
// Handle-level getAttributes / setAttributes
// ---------------------------------------------------------------------------

describe('Handle-level getAttributes / setAttributes', () => {
  it('handle.setAttributes() persists the attribute', async () => {
    const storage = new MemoryStorage();
    const engine = new Engine({ storage });

    engine.register('stay-running', async function* (ctx: WorkflowContext) {
      yield* (ctx as Context).waitForSignal('stop');
      return 'done';
    });

    const handle = await engine.start('stay-running', null, { id: 'wf-handle-set' });
    await flush();

    await handle.setAttributes({ region: 'us-east' });

    // Verify the attribute was persisted
    const attributes = await engine.getAttributes('wf-handle-set');
    expect(attributes).not.toBeNull();
    expect(attributes!['region']).toBe('us-east');

    engine[Symbol.dispose]();
  });

  it('handle.getAttributes() retrieves the set attributes', async () => {
    const storage = new MemoryStorage();
    const engine = new Engine({ storage });

    engine.register('stay-running', async function* (ctx: WorkflowContext) {
      yield* (ctx as Context).waitForSignal('stop');
      return 'done';
    });

    const handle = await engine.start('stay-running', null, {
      id: 'wf-handle-get',
      searchAttributes: { priority: 10, region: 'eu-west' },
    });
    await flush();

    const attributes = await handle.getAttributes();
    expect(attributes).not.toBeNull();
    expect(attributes!['priority']).toBe(10);
    expect(attributes!['region']).toBe('eu-west');

    engine[Symbol.dispose]();
  });

  it('handle methods work with the engine.start() return value', async () => {
    const engine = new Engine();

    engine.register('stay-running', async function* (ctx: WorkflowContext) {
      yield* (ctx as Context).waitForSignal('stop');
      return 'done';
    });

    const handle = await engine.start('stay-running', null, { id: 'wf-handle-both' });
    await flush();

    // Set via handle
    await handle.setAttributes({ status: 'active', count: 42 });

    // Get via same handle
    const attributes = await handle.getAttributes();
    expect(attributes).not.toBeNull();
    expect(attributes!['status']).toBe('active');
    expect(attributes!['count']).toBe(42);

    engine[Symbol.dispose]();
  });
});

// ---------------------------------------------------------------------------
// Schema Registration and Validation
// ---------------------------------------------------------------------------

describe('Schema Registration and Validation', () => {
  it('setting a registered attribute succeeds', async () => {
    const engine = new Engine();

    engine.register('schema-wf', {
      handler: async function* (ctx: WorkflowContext) {
        const context = ctx as Context;
        context.setAttribute('region', 'us-east');
        yield* context.run(async () => 'done');
        yield* context.waitForSignal('stop');
        return 'done';
      },
      searchAttributes: {
        region: { type: 'string' },
        priority: { type: 'number' },
      },
    });

    const handle = await engine.start('schema-wf', null, { id: 'wf-schema-ok' });
    await flush();

    const attributes = await engine.getAttributes('wf-schema-ok');
    expect(attributes).not.toBeNull();
    expect(attributes!['region']).toBe('us-east');

    engine[Symbol.dispose]();
  });

  it('setting an unknown attribute throws with descriptive error', async () => {
    const engine = new Engine();

    engine.register('schema-strict', {
      handler: async function* (ctx: WorkflowContext) {
        const context = ctx as Context;
        context.setAttribute('unknownKey', 'value');
        yield* context.run(async () => 'done');
        return 'done';
      },
      searchAttributes: {
        region: { type: 'string' },
        priority: { type: 'number' },
      },
    });

    const handle = await engine.start('schema-strict', null, { id: 'wf-schema-fail' });

    try {
      await handle.result();
      // If we reach here, the workflow completed without throwing. In the inline
      // strategy the error from setAttribute propagates through the generator.
      expect.unreachable('should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toContain('Unknown search attribute "unknownKey"');
      expect((error as Error).message).toContain('region');
      expect((error as Error).message).toContain('priority');
    }

    engine[Symbol.dispose]();
  });

  it('workflows without schema still accept any key (backward compatible)', async () => {
    const engine = new Engine();

    engine.register('no-schema', async function* (ctx: WorkflowContext) {
      const context = ctx as Context;
      context.setAttribute('anything', 'goes');
      context.setAttribute('random', 123);
      yield* context.run(async () => 'done');
      yield* context.waitForSignal('stop');
      return 'done';
    });

    const handle = await engine.start('no-schema', null, { id: 'wf-no-schema' });
    await flush();

    const attributes = await engine.getAttributes('wf-no-schema');
    expect(attributes).not.toBeNull();
    expect(attributes!['anything']).toBe('goes');
    expect(attributes!['random']).toBe(123);

    engine[Symbol.dispose]();
  });

  it('external engine.setAttributes() validates against schema', async () => {
    const engine = new Engine();

    engine.register('schema-ext', {
      handler: async function* (ctx: WorkflowContext) {
        yield* (ctx as Context).waitForSignal('stop');
        return 'done';
      },
      searchAttributes: {
        region: { type: 'string' },
        priority: { type: 'number' },
      },
    });

    await engine.start('schema-ext', null, { id: 'wf-schema-ext' });
    await flush();

    // Valid attribute should succeed
    await engine.setAttributes('wf-schema-ext', { region: 'us-west' });

    // Invalid attribute should throw
    try {
      await engine.setAttributes('wf-schema-ext', { badKey: 'value' });
      expect.unreachable('should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toContain('Unknown search attribute "badKey"');
      expect((error as Error).message).toContain('region');
      expect((error as Error).message).toContain('priority');
    }

    engine[Symbol.dispose]();
  });

  it('context.setAttributes() (batch) validates all keys against schema', async () => {
    const engine = new Engine();

    engine.register('schema-batch', {
      handler: async function* (ctx: WorkflowContext) {
        const context = ctx as Context;
        context.setAttributes({ region: 'us-east', badKey: 'oops' });
        yield* context.run(async () => 'done');
        return 'done';
      },
      searchAttributes: {
        region: { type: 'string' },
      },
    });

    const handle = await engine.start('schema-batch', null, { id: 'wf-schema-batch' });

    try {
      await handle.result();
      expect.unreachable('should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toContain('Unknown search attribute "badKey"');
    }

    engine[Symbol.dispose]();
  });
});

// ---------------------------------------------------------------------------
// gt / lt Filter Operators
// ---------------------------------------------------------------------------

describe('gt / lt Filter Operators', () => {
  it('engine.list() with gt filter excludes the boundary value', async () => {
    const storage = new MemoryStorage();
    const engine = new Engine({ storage });

    engine.register('stay-running', async function* (ctx: WorkflowContext) {
      yield* (ctx as Context).waitForSignal('stop');
      return 'done';
    });

    await engine.start('stay-running', null, {
      id: 'wf-p3',
      searchAttributes: { priority: 3 },
    });
    await engine.start('stay-running', null, {
      id: 'wf-p5',
      searchAttributes: { priority: 5 },
    });
    await engine.start('stay-running', null, {
      id: 'wf-p7',
      searchAttributes: { priority: 7 },
    });
    await engine.start('stay-running', null, {
      id: 'wf-p10',
      searchAttributes: { priority: 10 },
    });

    await flush();

    // gt: 5 should return only priority > 5 (not 5 itself)
    const result = await engine.list({
      attributes: [{ key: 'priority', gt: 5 }],
    });

    const ids = result.items.map((item) => item.id).toSorted();
    expect(ids).toEqual(['wf-p10', 'wf-p7']);

    engine[Symbol.dispose]();
  });

  it('engine.list() with lt filter excludes the boundary value', async () => {
    const storage = new MemoryStorage();
    const engine = new Engine({ storage });

    engine.register('stay-running', async function* (ctx: WorkflowContext) {
      yield* (ctx as Context).waitForSignal('stop');
      return 'done';
    });

    await engine.start('stay-running', null, {
      id: 'wf-p3',
      searchAttributes: { priority: 3 },
    });
    await engine.start('stay-running', null, {
      id: 'wf-p5',
      searchAttributes: { priority: 5 },
    });
    await engine.start('stay-running', null, {
      id: 'wf-p10',
      searchAttributes: { priority: 10 },
    });

    await flush();

    // lt: 10 should return only priority < 10 (not 10 itself)
    const result = await engine.list({
      attributes: [{ key: 'priority', lt: 10 }],
    });

    const ids = result.items.map((item) => item.id).toSorted();
    expect(ids).toEqual(['wf-p3', 'wf-p5']);

    engine[Symbol.dispose]();
  });

  it('gt and lt can be combined for an exclusive range', async () => {
    const storage = new MemoryStorage();
    const engine = new Engine({ storage });

    engine.register('stay-running', async function* (ctx: WorkflowContext) {
      yield* (ctx as Context).waitForSignal('stop');
      return 'done';
    });

    await engine.start('stay-running', null, {
      id: 'wf-p1',
      searchAttributes: { priority: 1 },
    });
    await engine.start('stay-running', null, {
      id: 'wf-p5',
      searchAttributes: { priority: 5 },
    });
    await engine.start('stay-running', null, {
      id: 'wf-p10',
      searchAttributes: { priority: 10 },
    });

    await flush();

    // gt: 1, lt: 10 — only priority=5 matches
    const result = await engine.list({
      attributes: [{ key: 'priority', gt: 1, lt: 10 }],
    });

    expect(result.items.length).toBe(1);
    expect(result.items[0]!.id).toBe('wf-p5');

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
      const { payload, respond } = yield* context.waitForUpdate<{ value: number }>('my-update');
      respond({ accepted: true, value: payload.value });
      return payload;
    });

    const handle = await engine.start('wait-for-update', null, { id: 'wf-update-1' });

    await flush();

    // Send update — the caller receives whatever respond() was called with
    const updateResult = await engine.update('wf-update-1', 'my-update', { value: 42 });
    expect(updateResult).toEqual({ accepted: true, value: 42 });

    // Workflow should have completed with the update payload
    const result = await handle.result();
    expect(result).toEqual({ value: 42 });

    engine[Symbol.dispose]();
  });

  it('multiple concurrent waitForUpdate calls with different names work independently', async () => {
    const engine = new Engine();

    engine.register('multi-update', async function* (ctx: WorkflowContext) {
      const context = ctx as Context;
      const { payload: firstPayload, respond: respond1 } =
        yield* context.waitForUpdate<string>('update-a');
      respond1(firstPayload);
      const { payload: secondPayload, respond: respond2 } =
        yield* context.waitForUpdate<string>('update-b');
      respond2(secondPayload);
      return `${firstPayload}-${secondPayload}`;
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
      const { payload, respond } = yield* context.waitForUpdate<string>('pending');
      respond(payload);
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
      const { payload, respond } = yield* context.waitForUpdate('my-update');
      respond(payload);
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
