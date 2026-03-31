import { describe, expect, it } from 'bun:test';

import { KEYS } from '../storage/interface.ts';
import { collectKeys, storageBackends, storageHas } from '../testing/storage-backends.ts';
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

/**
 * Dispose engine first, flush to let async work drain, then clean up storage.
 * This ordering prevents "client closed" errors from backends like Turso
 * where async operations may still reference storage after engine disposal.
 */
async function teardown(engine: Engine, storageCleanup: () => void): Promise<void> {
  engine[Symbol.dispose]();
  await flush();
  storageCleanup();
}

// ---------------------------------------------------------------------------
// Multi-backend parametrized tests
// ---------------------------------------------------------------------------

for (const backend of storageBackends) {
  describe(`Search Attributes Integration [${backend.name}]`, () => {
    it('engine.start() with searchAttributes writes attr: and idx: keys', async () => {
      const { storage, cleanup } = backend.factory();
      const engine = new Engine({ storage });

      engine.register('noop', async function* () {
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
      const indexKeys = await collectKeys(storage, 'idx:');
      expect(indexKeys.length).toBe(2);

      // Verify the specific index key exists
      const statusIndexKey = KEYS.attributeIndex('status', 's:active', 'wf-1');
      expect(await storageHas(storage, statusIndexKey)).toBe(true);

      await teardown(engine, cleanup);
    });

    it('ctx.setAttribute() writes idx: entries while workflow is running', async () => {
      const { storage, cleanup } = backend.factory();
      const engine = new Engine({ storage });

      const setAttributeActivity = async () => 'done';

      engine.register('set-attrs-running', async function* (ctx: WorkflowContext) {
        const context = ctx as Context;
        context.setAttribute('region', 'us-east');
        yield* context.run(setAttributeActivity);
        yield* context.waitForSignal('stop');
        return 'done';
      });

      await engine.start('set-attrs-running', null, { id: 'wf-3' });
      await flush();

      // Verify idx: key for 'region' was written
      const regionIndexKey = KEYS.attributeIndex('region', 's:us-east', 'wf-3');
      expect(await storageHas(storage, regionIndexKey)).toBe(true);

      // Verify attr: record was written
      const attributeBytes = await storage.get(KEYS.attribute('wf-3'));
      expect(attributeBytes).not.toBeNull();
      const attributes = decode(attributeBytes!) as Record<string, SearchAttributeValue>;
      expect(attributes['region']).toBe('us-east');

      await teardown(engine, cleanup);
    });

    it('engine.list() with attribute filter returns matching workflows', async () => {
      const { storage, cleanup } = backend.factory();
      const engine = new Engine({ storage });

      engine.register('stay-running', async function* (ctx: WorkflowContext) {
        yield* (ctx as Context).waitForSignal('stop');
        return 'done';
      });

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

      const result = await engine.list({
        attributes: [{ key: 'status', value: 'active' }],
      });

      expect(result.items.length).toBe(2);
      const ids = result.items.map((item) => item.id).toSorted();
      expect(ids).toEqual(['wf-active-1', 'wf-active-2']);

      await teardown(engine, cleanup);
    });

    it('engine.list() with range attribute filter works', async () => {
      const { storage, cleanup } = backend.factory();
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

      const result = await engine.list({
        attributes: [{ key: 'price', gte: 10, lte: 100 }],
      });

      expect(result.items.length).toBe(1);
      expect(result.items[0]!.id).toBe('wf-price-50');

      await teardown(engine, cleanup);
    });

    it('index entries are cleaned up on workflow completion', async () => {
      const { storage, cleanup } = backend.factory();
      const engine = new Engine({ storage });

      engine.register('complete-quickly', async function* () {
        return 'done';
      });

      await engine.start('complete-quickly', null, {
        id: 'wf-cleanup',
        searchAttributes: { status: 'active', priority: 1 },
      });

      const handle = engine.getHandle('wf-cleanup');
      await handle.result();

      // Verify that index entries are cleaned up
      const indexKeys = await collectKeys(storage, 'idx:');
      expect(indexKeys.length).toBe(0);

      // Verify attr: record is cleaned up
      const attributeBytes = await storage.get(KEYS.attribute('wf-cleanup'));
      expect(attributeBytes).toBeNull();

      await teardown(engine, cleanup);
    });

    it('index entries are cleaned up on workflow failure', async () => {
      const { storage, cleanup } = backend.factory();
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

      const indexKeys = await collectKeys(storage, 'idx:');
      expect(indexKeys.length).toBe(0);

      const attributeBytes = await storage.get(KEYS.attribute('wf-fail-cleanup'));
      expect(attributeBytes).toBeNull();

      await teardown(engine, cleanup);
    });

    it('index entries are cleaned up on workflow cancellation', async () => {
      const { storage, cleanup } = backend.factory();
      const engine = new Engine({ storage });

      engine.register('stay-running', async function* (ctx: WorkflowContext) {
        yield* (ctx as Context).waitForSignal('stop');
        return 'done';
      });

      const handle = await engine.start('stay-running', null, {
        id: 'wf-cancel-cleanup',
        searchAttributes: { status: 'active' },
      });

      handle.result().catch(() => {});

      await flush();

      // Verify index exists before cancel
      let indexKeys = await collectKeys(storage, 'idx:');
      expect(indexKeys.length).toBe(1);

      await engine.cancel('wf-cancel-cleanup');

      // Verify index entries are cleaned up
      indexKeys = await collectKeys(storage, 'idx:');
      expect(indexKeys.length).toBe(0);

      await teardown(engine, cleanup);
    });

    it('list with multiple attribute filters intersects results', async () => {
      const { storage, cleanup } = backend.factory();
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

      await teardown(engine, cleanup);
    });
  });

  // -------------------------------------------------------------------------
  // Handle-level getAttributes / setAttributes
  // -------------------------------------------------------------------------

  describe(`Handle-level getAttributes / setAttributes [${backend.name}]`, () => {
    it('handle.setAttributes() persists the attribute', async () => {
      const { storage, cleanup } = backend.factory();
      const engine = new Engine({ storage });

      engine.register('stay-running', async function* (ctx: WorkflowContext) {
        yield* (ctx as Context).waitForSignal('stop');
        return 'done';
      });

      const handle = await engine.start('stay-running', null, { id: 'wf-handle-set' });
      await flush();

      await handle.setAttributes({ region: 'us-east' });

      const attributes = await engine.getAttributes('wf-handle-set');
      expect(attributes).not.toBeNull();
      expect(attributes!['region']).toBe('us-east');

      await teardown(engine, cleanup);
    });

    it('handle.getAttributes() retrieves the set attributes', async () => {
      const { storage, cleanup } = backend.factory();
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

      await teardown(engine, cleanup);
    });

    it('handle methods work with the engine.start() return value', async () => {
      const { storage, cleanup } = backend.factory();
      const engine = new Engine({ storage });

      engine.register('stay-running', async function* (ctx: WorkflowContext) {
        yield* (ctx as Context).waitForSignal('stop');
        return 'done';
      });

      const handle = await engine.start('stay-running', null, { id: 'wf-handle-both' });
      await flush();

      await handle.setAttributes({ status: 'active', count: 42 });

      const attributes = await handle.getAttributes();
      expect(attributes).not.toBeNull();
      expect(attributes!['status']).toBe('active');
      expect(attributes!['count']).toBe(42);

      await teardown(engine, cleanup);
    });
  });

  // -------------------------------------------------------------------------
  // gt / lt Filter Operators
  // -------------------------------------------------------------------------

  describe(`gt / lt Filter Operators [${backend.name}]`, () => {
    it('engine.list() with gt filter excludes the boundary value', async () => {
      const { storage, cleanup } = backend.factory();
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

      const result = await engine.list({
        attributes: [{ key: 'priority', gt: 5 }],
      });

      const ids = result.items.map((item) => item.id).toSorted();
      expect(ids).toEqual(['wf-p10', 'wf-p7']);

      await teardown(engine, cleanup);
    });

    it('engine.list() with lt filter excludes the boundary value', async () => {
      const { storage, cleanup } = backend.factory();
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

      const result = await engine.list({
        attributes: [{ key: 'priority', lt: 10 }],
      });

      const ids = result.items.map((item) => item.id).toSorted();
      expect(ids).toEqual(['wf-p3', 'wf-p5']);

      await teardown(engine, cleanup);
    });

    it('gt and lt can be combined for an exclusive range', async () => {
      const { storage, cleanup } = backend.factory();
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

      const result = await engine.list({
        attributes: [{ key: 'priority', gt: 1, lt: 10 }],
      });

      expect(result.items.length).toBe(1);
      expect(result.items[0]!.id).toBe('wf-p5');

      await teardown(engine, cleanup);
    });
  });
}
