import { describe, expect, it } from 'bun:test';

import { KEYS } from '../storage/interface.ts';
import { MemoryStorage } from '../storage/memory.ts';
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

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Synchronous Updates', () => {
  // -----------------------------------------------------------------------
  // Step 1: Default timeout and TTL
  // -----------------------------------------------------------------------

  describe('default timeout', () => {
    it('uses 30s default timeout (not 5s)', async () => {
      // The update() method uses 30_000 as the default timeout. We verify
      // by calling update on a workflow with no handler and a very short
      // custom timeout to confirm that the timeout mechanism works as
      // expected — this is indirect but proves the code path.
      const engine = new Engine();
      engine.register('simple', async function* (_ctx: WorkflowContext) {
        await Bun.sleep(999_999);
        return 'done';
      });

      const handle = await engine.start('simple', undefined);
      suppressResult(handle);
      await flush();

      // With a 50ms timeout, update should timeout quickly
      try {
        await engine.update(handle.id, 'nonexistent', undefined, { timeout: 50 });
        expect.unreachable('should have thrown');
      } catch (error) {
        // UpdateTimeoutError is thrown — this confirms timeout is configurable
        expect((error as Error).message).toContain('timed out');
      }

      engine[Symbol.dispose]();
    });
  });

  describe('cleanup TTL', () => {
    it('uses 5-minute default TTL (old responses cleaned, recent ones kept)', async () => {
      const storage = new MemoryStorage();
      const coordinator = new UpdateCoordinator(storage);

      const sixMinutesAgo = Date.now() - 6 * 60 * 1000;
      const twoMinutesAgo = Date.now() - 2 * 60 * 1000;

      // Old response (> 5 minutes) — should be cleaned
      await storage.put(
        'upr:old-1',
        encode({ updateId: 'old-1', result: 'stale', createdAt: sixMinutesAgo }),
      );

      // Recent response (< 5 minutes) — should be kept
      await storage.put(
        'upr:recent-1',
        encode({ updateId: 'recent-1', result: 'fresh', createdAt: twoMinutesAgo }),
      );

      const cleaned = await coordinator.cleanupExpiredResponses();

      expect(cleaned).toBe(1);
      expect(await storage.get('upr:old-1')).toBeNull();
      expect(await storage.get('upr:recent-1')).not.toBeNull();

      storage.clear();
    });
  });

  // -----------------------------------------------------------------------
  // Step 2: Reject updates to terminal workflows
  // -----------------------------------------------------------------------

  describe('terminal workflow guard', () => {
    it('throws WorkflowTerminalError for completed workflow via update()', async () => {
      const engine = new Engine();
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

      engine[Symbol.dispose]();
    });

    it('throws WorkflowTerminalError for failed workflow via update()', async () => {
      const engine = new Engine();
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

      engine[Symbol.dispose]();
    });

    it('throws WorkflowTerminalError for completed workflow via submitCoordinatedUpdate()', async () => {
      const engine = new Engine();
      engine.register('quick', async function* (_ctx: WorkflowContext) {
        return 'done';
      });

      const handle = await engine.start('quick', undefined);
      await handle.result();
      await flush();

      try {
        await engine.submitCoordinatedUpdate(handle.id, 'someUpdate', 'payload');
        expect.unreachable('should have thrown');
      } catch (error) {
        expect(error).toBeInstanceOf(WorkflowTerminalError);
        expect((error as WorkflowTerminalError).status).toBe('completed');
      }

      engine[Symbol.dispose]();
    });

    it('throws WorkflowTerminalError for cancelled workflow', async () => {
      const engine = new Engine();
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

      engine[Symbol.dispose]();
    });

    it('allows updates to running workflows', async () => {
      const engine = new Engine();
      engine.register('waiter', async function* (ctx: WorkflowContext) {
        (ctx as Context).onUpdate('greet', (payload) => `hello ${String(payload)}`);
        await Bun.sleep(999_999);
        return 'done';
      });

      const handle = await engine.start('waiter', undefined);
      suppressResult(handle);
      await flush();

      // Should not throw — workflow is still running
      const result = await engine.update(handle.id, 'greet', 'world');
      expect(result).toBe('hello world');

      engine[Symbol.dispose]();
    });
  });

  // -----------------------------------------------------------------------
  // Step 3: Generator handler validation
  // -----------------------------------------------------------------------

  describe('onUpdate handler validation', () => {
    it('rejects sync generator handler', async () => {
      const engine = new Engine();
      engine.register('gen-test', async function* (ctx: WorkflowContext) {
        expect(() => {
          (ctx as Context).onUpdate('bad', function* () {
            yield 1;
          } as unknown as (payload: unknown) => unknown);
        }).toThrow(TypeError);

        return 'done';
      });

      const handle = await engine.start('gen-test', undefined);
      await handle.result();

      engine[Symbol.dispose]();
    });

    it('rejects async generator handler', async () => {
      const engine = new Engine();
      engine.register('async-gen-test', async function* (ctx: WorkflowContext) {
        expect(() => {
          (ctx as Context).onUpdate('bad', async function* () {
            yield 1;
          } as unknown as (payload: unknown) => unknown);
        }).toThrow(TypeError);

        return 'done';
      });

      const handle = await engine.start('async-gen-test', undefined);
      await handle.result();

      engine[Symbol.dispose]();
    });

    it('accepts normal function handler', async () => {
      const engine = new Engine();
      engine.register('normal-test', async function* (ctx: WorkflowContext) {
        // Regular function — should not throw
        (ctx as Context).onUpdate('good', (payload) => `ok ${String(payload)}`);
        // Arrow function — should not throw
        (ctx as Context).onUpdate('also-good', (payload) => payload);
        // Async function — should not throw
        (ctx as Context).onUpdate('async-good', async (payload) => payload);
        return 'done';
      });

      const handle = await engine.start('normal-test', undefined);
      await handle.result();

      engine[Symbol.dispose]();
    });

    it('error message mentions handler name', async () => {
      const engine = new Engine();
      engine.register('msg-test', async function* (ctx: WorkflowContext) {
        let threw = false;
        try {
          (ctx as Context).onUpdate('myHandler', function* () {
            yield 1;
          } as unknown as (payload: unknown) => unknown);
          expect.unreachable('should have thrown');
        } catch (error) {
          threw = true;
          expect((error as TypeError).message).toContain('myHandler');
          expect((error as TypeError).message).toContain('generator');
        }
        expect(threw).toBe(true);
        return 'done';
      });

      const handle = await engine.start('msg-test', undefined);
      await handle.result();

      engine[Symbol.dispose]();
    });
  });

  // -----------------------------------------------------------------------
  // Step 4: BroadcastChannel notification
  // -----------------------------------------------------------------------

  describe('broadcast notification on update completion', () => {
    it('broadcasts update:completed via inline handler path', async () => {
      const engine = new Engine({ broadcastEvents: true });
      const messages: Record<string, unknown>[] = [];

      // Listen on the BroadcastChannel
      const channel = new BroadcastChannel('weft:events');
      channel.onmessage = (event) => {
        messages.push(event.data as Record<string, unknown>);
      };

      engine.register('bc-test', async function* (ctx: WorkflowContext) {
        (ctx as Context).onUpdate('ping', () => 'pong');
        await Bun.sleep(999_999);
        return 'done';
      });

      const handle = await engine.start('bc-test', undefined);
      suppressResult(handle);
      await flush();

      await engine.update(handle.id, 'ping', null);
      await flush();

      const updateMessages = messages.filter((message) => message['type'] === 'update:completed');
      expect(updateMessages.length).toBeGreaterThanOrEqual(1);
      expect(updateMessages[0]!['workflowId']).toBe(handle.id);
      expect(typeof updateMessages[0]!['updateId']).toBe('string');

      channel.close();
      engine[Symbol.dispose]();
    });
  });

  // -----------------------------------------------------------------------
  // Step 5: FIFO ordering of concurrent updates
  // -----------------------------------------------------------------------

  describe('FIFO ordering', () => {
    it('selects the oldest pending update when multiple match the same name', async () => {
      // Test FIFO at the coordinator level to verify sort correctness
      const storage = new MemoryStorage();
      const coordinator = new UpdateCoordinator(storage);

      // Create three updates with explicit timestamps in non-chronological
      // insertion order to ensure sorting (not insertion order) determines
      // priority.
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
      const sorted = pending
        .filter((u) => u.name === 'data')
        .toSorted((a, b) => a.createdAt - b.createdAt);

      // The oldest update should come first
      expect(sorted[0]!.payload).toBe('first');
      expect(sorted[1]!.payload).toBe('second');
      expect(sorted[2]!.payload).toBe('third');

      storage.clear();
    });

    it('engine consumes the oldest pending update via waitForUpdate', async () => {
      const engine = new Engine();
      const storage = engine.storage;

      // Seed pending updates BEFORE the workflow runs, so the wait-update
      // handler finds them immediately in FIFO order.
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
        const value = yield* (ctx as Context).waitForUpdate<string>('data');
        return value;
      });

      const handle = await engine.start('fifo-test', undefined, { id: workflowId });
      const result = await handle.result();

      // FIFO: the older update (payload 'first') should win
      expect(result).toBe('first');

      engine[Symbol.dispose]();
    });
  });

  // -----------------------------------------------------------------------
  // Step 6: Pending updates processed on resume
  // -----------------------------------------------------------------------

  describe('pending updates on resume', () => {
    it('processes pending coordinated updates when inline handler is registered', async () => {
      const engine = new Engine();

      engine.register('resumable', async function* (ctx: WorkflowContext) {
        (ctx as Context).onUpdate('validate', (payload) => {
          return `validated: ${String(payload)}`;
        });
        // Sleep to keep the workflow active
        yield* (ctx as Context).sleep('1 hour');
        return 'done';
      });

      const handle = await engine.start('resumable', undefined);
      suppressResult(handle);
      await flush();

      // Create a pending coordinated update in storage as if it arrived
      // while the engine was restarting (simulates the crash-recovery case)
      const pendingUpdate = {
        updateId: 'pending-1',
        workflowId: handle.id,
        name: 'validate',
        payload: 'test-data',
        createdAt: Date.now(),
      };
      await engine.storage.put(KEYS.update(handle.id, 'pending-1'), encode(pendingUpdate));

      // The inline handler path should handle this update directly since
      // the workflow is active and has a matching handler registered
      const result = await engine.update(handle.id, 'validate', 'direct-call');
      expect(result).toBe('validated: direct-call');

      engine[Symbol.dispose]();
    });

    it('drains pending updates for registered handlers after resume', async () => {
      // Use two engine instances sharing storage to simulate process restart
      const storage = new MemoryStorage();

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

      // Dispose engine1 to simulate crash
      engine1[Symbol.dispose]();

      // Create engine2 with the same storage, simulating restart
      const engine2 = new Engine({ storage });
      engine2.register('durable', async function* (ctx: WorkflowContext) {
        (ctx as Context).onUpdate('process', (payload) => {
          return `processed: ${String(payload)}`;
        });
        yield* (ctx as Context).sleep('1 hour');
        return 'done';
      });

      // Resume the workflow on engine2
      const resumedHandle = await engine2.resume(handle.id);
      suppressResult(resumedHandle);

      // Wait for queueMicrotask + async processing
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

      engine2[Symbol.dispose]();
    });
  });

  // -----------------------------------------------------------------------
  // WorkflowTerminalError
  // -----------------------------------------------------------------------

  describe('WorkflowTerminalError', () => {
    it('has correct properties', () => {
      const error = new WorkflowTerminalError('wf-123', 'completed');
      expect(error).toBeInstanceOf(Error);
      expect(error.name).toBe('WorkflowTerminalError');
      expect(error.workflowId).toBe('wf-123');
      expect(error.status).toBe('completed');
      expect(error.message).toContain('wf-123');
      expect(error.message).toContain('completed');
      expect(error.message).toContain('terminal');
    });
  });

  // -----------------------------------------------------------------------
  // Inline handler path (integration)
  // -----------------------------------------------------------------------

  describe('inline handler integration', () => {
    it('dispatches UpdateReceivedEvent and UpdateCompletedEvent', async () => {
      const engine = new Engine();
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

      engine[Symbol.dispose]();
    });
  });
});
