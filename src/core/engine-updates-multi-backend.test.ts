import { describe, expect, it } from 'bun:test';

import { KEYS } from '../storage/interface.ts';
import { storageBackends } from '../testing/storage-backends.ts';
import { decode, encode } from './codec.ts';
import type { Context } from './context.ts';
import { Engine } from './engine.ts';
import type { WorkflowContext } from './types.ts';
import { UpdateCoordinator, WorkflowTerminalError } from './updates.ts';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function flush(): Promise<void> {
  await Bun.sleep(10);
}

/** Suppress unhandled rejection from a handle's result promise. */
function suppressResult(handle: { result(): Promise<unknown> }): void {
  handle.result().catch(() => {});
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
  describe(`Synchronous Updates [${backend.name}]`, () => {
    // ---------------------------------------------------------------------
    // Cleanup TTL
    // ---------------------------------------------------------------------

    describe('cleanup TTL', () => {
      it('uses 5-minute default TTL (old responses cleaned, recent ones kept)', async () => {
        const { storage, cleanup } = backend.factory();
        const coordinator = new UpdateCoordinator(storage);

        const sixMinutesAgo = Date.now() - 6 * 60 * 1000;
        const twoMinutesAgo = Date.now() - 2 * 60 * 1000;

        await storage.put(
          'upr:old-1',
          encode({ updateId: 'old-1', result: 'stale', createdAt: sixMinutesAgo }),
        );

        await storage.put(
          'upr:recent-1',
          encode({ updateId: 'recent-1', result: 'fresh', createdAt: twoMinutesAgo }),
        );

        const cleaned = await coordinator.cleanupExpiredResponses();

        expect(cleaned).toBe(1);
        expect(await storage.get('upr:old-1')).toBeNull();
        expect(await storage.get('upr:recent-1')).not.toBeNull();

        cleanup();
      });
    });

    // ---------------------------------------------------------------------
    // Terminal workflow guard
    // ---------------------------------------------------------------------

    describe('terminal workflow guard', () => {
      it('throws WorkflowTerminalError for completed workflow via update()', async () => {
        const { storage, cleanup } = backend.factory();
        const engine = new Engine({ storage });

        engine.register('quick', async function* (_ctx: WorkflowContext) {
          return 'done';
        });

        const handle = await engine.start('quick', undefined);
        await handle.result();
        await flush();

        try {
          await engine.update(handle.id, 'someUpdate', 'payload');
          expect.unreachable('should have thrown');
        } catch (error) {
          expect(error).toBeInstanceOf(WorkflowTerminalError);
          expect((error as WorkflowTerminalError).workflowId).toBe(handle.id);
          expect((error as WorkflowTerminalError).status).toBe('completed');
          expect((error as WorkflowTerminalError).message).toContain('terminal');
        }

        await teardown(engine, cleanup);
      });

      it('throws WorkflowTerminalError for failed workflow via update()', async () => {
        const { storage, cleanup } = backend.factory();
        const engine = new Engine({ storage });

        engine.register('fail', async function* (_ctx: WorkflowContext) {
          throw new Error('intentional failure');
        });

        const handle = await engine.start('fail', undefined);
        suppressResult(handle);
        await flush();

        try {
          await engine.update(handle.id, 'someUpdate', 'payload');
          expect.unreachable('should have thrown');
        } catch (error) {
          expect(error).toBeInstanceOf(WorkflowTerminalError);
          expect((error as WorkflowTerminalError).status).toBe('failed');
        }

        await teardown(engine, cleanup);
      });

      it('throws WorkflowTerminalError for cancelled workflow', async () => {
        const { storage, cleanup } = backend.factory();
        const engine = new Engine({ storage });

        engine.register('cancelme', async function* (ctx: WorkflowContext) {
          yield* (ctx as Context).sleep('1 hour');
          return 'done';
        });

        const handle = await engine.start('cancelme', undefined);
        suppressResult(handle);
        await flush();

        await engine.cancel(handle.id);
        await flush();

        try {
          await engine.update(handle.id, 'someUpdate', 'payload');
          expect.unreachable('should have thrown');
        } catch (error) {
          expect(error).toBeInstanceOf(WorkflowTerminalError);
          expect((error as WorkflowTerminalError).status).toBe('cancelled');
        }

        await teardown(engine, cleanup);
      });

      it('allows updates to running workflows', async () => {
        const { storage, cleanup } = backend.factory();
        const engine = new Engine({ storage });

        engine.register('waiter', async function* (ctx: WorkflowContext) {
          (ctx as Context).onUpdate('greet', (payload) => `hello ${String(payload)}`);
          await Bun.sleep(999_999);
          return 'done';
        });

        const handle = await engine.start('waiter', undefined);
        suppressResult(handle);
        await flush();

        const result = await engine.update(handle.id, 'greet', 'world');
        expect(result).toBe('hello world');

        await teardown(engine, cleanup);
      });
    });

    // ---------------------------------------------------------------------
    // FIFO ordering
    // ---------------------------------------------------------------------

    describe('FIFO ordering', () => {
      it('selects the oldest pending update when multiple match the same name', async () => {
        const { storage, cleanup } = backend.factory();
        const coordinator = new UpdateCoordinator(storage);

        const updates = [
          {
            updateId: 'update-3',
            workflowId: 'wf-fifo',
            name: 'data',
            payload: 'third',
            createdAt: 3000,
          },
          {
            updateId: 'update-1',
            workflowId: 'wf-fifo',
            name: 'data',
            payload: 'first',
            createdAt: 1000,
          },
          {
            updateId: 'update-2',
            workflowId: 'wf-fifo',
            name: 'data',
            payload: 'second',
            createdAt: 2000,
          },
        ];

        for (const update of updates) {
          await storage.put(KEYS.update('wf-fifo', update.updateId), encode(update));
        }

        const pending = await coordinator.getPendingUpdates('wf-fifo');
        const filtered = pending.filter((u) => u.name === 'data');

        expect(filtered[0]!.payload).toBe('first');
        expect(filtered[1]!.payload).toBe('second');
        expect(filtered[2]!.payload).toBe('third');

        cleanup();
      });

      it('engine consumes the oldest pending update via waitForUpdate', async () => {
        const { storage, cleanup } = backend.factory();
        const engine = new Engine({ storage });

        const workflowId = 'fifo-wf';

        const oldUpdate = {
          updateId: 'update-old',
          workflowId,
          name: 'data',
          payload: 'first',
          createdAt: Date.now() - 1000,
        };
        const newUpdate = {
          updateId: 'update-new',
          workflowId,
          name: 'data',
          payload: 'second',
          createdAt: Date.now(),
        };

        // Insert newer first to ensure sort, not insertion order, wins
        await storage.put(KEYS.update(workflowId, 'update-new'), encode(newUpdate));
        await storage.put(KEYS.update(workflowId, 'update-old'), encode(oldUpdate));

        engine.register('fifo-test', async function* (ctx: WorkflowContext) {
          const { payload, respond } = yield* (ctx as Context).waitForUpdate<string>('data');
          respond(payload);
          return payload;
        });

        const handle = await engine.start('fifo-test', undefined, { id: workflowId });
        const result = await handle.result();

        expect(result).toBe('first');

        await teardown(engine, cleanup);
      });
    });

    // ---------------------------------------------------------------------
    // waitForUpdate integration
    // ---------------------------------------------------------------------

    describe('waitForUpdate integration', () => {
      it('ctx.waitForUpdate() pauses until engine.update() is called', async () => {
        const { storage, cleanup } = backend.factory();
        const engine = new Engine({ storage });

        engine.register('wait-for-update', async function* (ctx: WorkflowContext) {
          const context = ctx as Context;
          const { payload, respond } = yield* context.waitForUpdate<{ value: number }>('my-update');
          respond({ accepted: true, value: payload.value });
          return payload;
        });

        const handle = await engine.start('wait-for-update', null, { id: 'wf-update-1' });
        await flush();

        const updateResult = await engine.update('wf-update-1', 'my-update', { value: 42 });
        expect(updateResult).toEqual({ accepted: true, value: 42 });

        const result = await handle.result();
        expect(result).toEqual({ value: 42 });

        await teardown(engine, cleanup);
      });

      it('multiple concurrent waitForUpdate calls with different names work independently', async () => {
        const { storage, cleanup } = backend.factory();
        const engine = new Engine({ storage });

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

        await engine.update('wf-multi-update', 'update-a', 'hello');
        await flush();

        await engine.update('wf-multi-update', 'update-b', 'world');

        const result = await handle.result();
        expect(result).toBe('hello-world');

        await teardown(engine, cleanup);
      });

      it('respond() sends the result back to the engine.update() caller', async () => {
        const { storage, cleanup } = backend.factory();
        const engine = new Engine({ storage });

        engine.register('respond-test', async function* (ctx: WorkflowContext) {
          const { payload, respond } = yield* (ctx as Context).waitForUpdate<string>('review');
          respond({ accepted: true, originalPayload: payload });
          return `processed: ${payload}`;
        });

        const handle = await engine.start('respond-test', undefined);
        await flush();

        const updateResult = await engine.update(handle.id, 'review', 'my-data');
        expect(updateResult).toEqual({ accepted: true, originalPayload: 'my-data' });

        const result = await handle.result();
        expect(result).toBe('processed: my-data');

        await teardown(engine, cleanup);
      });

      it('calling respond() multiple times is idempotent', async () => {
        const { storage, cleanup } = backend.factory();
        const engine = new Engine({ storage });

        engine.register('idempotent-respond', async function* (ctx: WorkflowContext) {
          const { payload, respond } = yield* (ctx as Context).waitForUpdate<string>('data');
          respond('first-response');
          respond('second-response');
          return payload;
        });

        const handle = await engine.start('idempotent-respond', undefined);
        await flush();

        const updateResult = await engine.update(handle.id, 'data', 'input');
        expect(updateResult).toBe('first-response');

        const result = await handle.result();
        expect(result).toBe('input');

        await teardown(engine, cleanup);
      });
    });

    // ---------------------------------------------------------------------
    // Pending updates on resume
    // ---------------------------------------------------------------------

    describe('pending updates on resume', () => {
      it('drains pending updates for registered handlers after resume', async () => {
        const { storage, cleanup } = backend.factory();

        const engine1 = new Engine({ storage });
        engine1.register('durable', async function* (ctx: WorkflowContext) {
          (ctx as Context).onUpdate('process', (payload) => {
            return `processed: ${String(payload)}`;
          });
          yield* (ctx as Context).sleep('1 hour');
          return 'done';
        });

        const handle = await engine1.start('durable', undefined);
        suppressResult(handle);
        await flush();

        // Seed a pending coordinated update in storage
        const pendingUpdate = {
          updateId: 'pending-drain',
          workflowId: handle.id,
          name: 'process',
          payload: 'queued-data',
          createdAt: Date.now(),
        };
        await storage.put(KEYS.update(handle.id, 'pending-drain'), encode(pendingUpdate));

        // Dispose engine1 to simulate crash (don't close storage)
        engine1[Symbol.dispose]();
        await flush();

        // Create engine2 with the same storage, simulating restart
        const engine2 = new Engine({ storage });
        engine2.register('durable', async function* (ctx: WorkflowContext) {
          (ctx as Context).onUpdate('process', (payload) => {
            return `processed: ${String(payload)}`;
          });
          yield* (ctx as Context).sleep('1 hour');
          return 'done';
        });

        const resumedHandle = await engine2.resume(handle.id);
        suppressResult(resumedHandle);

        await flush();
        await flush();

        // The pending update request should have been consumed from storage
        const remaining = await storage.get(KEYS.update(handle.id, 'pending-drain'));
        expect(remaining).toBeNull();

        // The response should have been written
        const response = await storage.get('upr:pending-drain');
        expect(response).not.toBeNull();
        const decoded = decode(response!) as { result: unknown };
        expect(decoded.result).toBe('processed: queued-data');

        await teardown(engine2, cleanup);
      });
    });

    // ---------------------------------------------------------------------
    // Respond with pending coordinated updates
    // ---------------------------------------------------------------------

    describe('respond with pending coordinated updates', () => {
      it('respond() works with pending coordinated updates', async () => {
        const { storage, cleanup } = backend.factory();
        const engine = new Engine({ storage });
        const workflowId = 'coordinated-respond-wf';

        // Seed a pending coordinated update
        const pendingUpdate = {
          updateId: 'coordinated-1',
          workflowId,
          name: 'approve',
          payload: { amount: 100 },
          createdAt: Date.now() - 500,
        };
        await storage.put(KEYS.update(workflowId, 'coordinated-1'), encode(pendingUpdate));

        engine.register('coordinated-respond', async function* (ctx: WorkflowContext) {
          const { payload, respond } = yield* (ctx as Context).waitForUpdate<{ amount: number }>(
            'approve',
          );
          respond({ approved: true, amount: payload.amount });
          return `approved: ${payload.amount}`;
        });

        const handle = await engine.start('coordinated-respond', undefined, { id: workflowId });
        const result = await handle.result();
        expect(result).toBe('approved: 100');

        await flush();
        const responseBytes = await storage.get('upr:coordinated-1');
        expect(responseBytes).not.toBeNull();
        const response = decode(responseBytes!) as { result: unknown };
        expect(response.result).toEqual({ approved: true, amount: 100 });

        await teardown(engine, cleanup);
      });
    });

    // ---------------------------------------------------------------------
    // Inline handler integration
    // ---------------------------------------------------------------------

    describe('inline handler integration', () => {
      it('dispatches UpdateReceivedEvent and UpdateCompletedEvent', async () => {
        const { storage, cleanup } = backend.factory();
        const engine = new Engine({ storage });
        const events: string[] = [];

        engine.addEventListener('update:received', () => events.push('received'));
        engine.addEventListener('update:completed', () => events.push('completed'));

        engine.register('event-test', async function* (ctx: WorkflowContext) {
          (ctx as Context).onUpdate('test', (payload) => `echo: ${String(payload)}`);
          await Bun.sleep(999_999);
          return 'done';
        });

        const handle = await engine.start('event-test', undefined);
        suppressResult(handle);
        await flush();

        const result = await engine.update(handle.id, 'test', 'hello');
        expect(result).toBe('echo: hello');
        expect(events).toContain('received');
        expect(events).toContain('completed');

        await teardown(engine, cleanup);
      });
    });
  });
}
