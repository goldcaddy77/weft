import { describe, expect, it } from 'bun:test';

import type { PendingTask, TaskResult } from './task-queue.ts';
import { TaskQueue } from './task-queue.ts';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTask(overrides: Partial<PendingTask> = {}): PendingTask {
  return {
    operationId: overrides.operationId ?? `op-${crypto.randomUUID().slice(0, 8)}`,
    activityName: overrides.activityName ?? 'charge',
    input: overrides.input ?? { amount: 100 },
    attempt: overrides.attempt,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('TaskQueue', () => {
  describe('enqueue and poll', () => {
    it('returns a queued task immediately when a matching poll arrives', async () => {
      const queue = new TaskQueue();
      const task = makeTask({ activityName: 'charge' });

      queue.enqueue('default', task);

      const result = await queue.poll('default', ['charge'], 1000);

      expect(result).toEqual(task);
    });

    it('returns null when no matching task exists and timeout expires', async () => {
      const queue = new TaskQueue();

      const result = await queue.poll('default', ['charge'], 50);

      expect(result).toBeNull();
    });

    it('dispatches directly to a waiting poller when a task is enqueued', async () => {
      const queue = new TaskQueue();

      // Start a poll that will block
      const pollPromise = queue.poll('default', ['charge'], 5000);

      // Enqueue a task — should resolve the waiting poll immediately
      const task = makeTask({ activityName: 'charge' });
      queue.enqueue('default', task);

      const result = await pollPromise;
      expect(result).toEqual(task);
    });

    it('respects activity filtering on poll', async () => {
      const queue = new TaskQueue();

      queue.enqueue('default', makeTask({ activityName: 'ship' }));

      // Poll for 'charge' — should not match the 'ship' task
      const result = await queue.poll('default', ['charge'], 50);

      expect(result).toBeNull();
      expect(queue.pendingCount('default')).toBe(1);
    });

    it('respects activity filtering on enqueue with waiters', async () => {
      const queue = new TaskQueue();

      // Waiter wants 'charge' only
      const pollPromise = queue.poll('default', ['charge'], 5000);

      // Enqueue a 'ship' task — should not match the waiter
      queue.enqueue('default', makeTask({ activityName: 'ship' }));

      // Enqueue a 'charge' task — should match
      const chargeTask = makeTask({ activityName: 'charge' });
      queue.enqueue('default', chargeTask);

      const result = await pollPromise;
      expect(result).toEqual(chargeTask);
      // The 'ship' task should still be pending
      expect(queue.pendingCount('default')).toBe(1);
    });

    it('isolates tasks by queue name', async () => {
      const queue = new TaskQueue();

      queue.enqueue('billing', makeTask({ activityName: 'charge' }));

      const result = await queue.poll('shipping', ['charge'], 50);

      expect(result).toBeNull();
      expect(queue.pendingCount('billing')).toBe(1);
    });

    it('serves tasks in FIFO order', async () => {
      const queue = new TaskQueue();

      const first = makeTask({ operationId: 'first', activityName: 'charge' });
      const second = makeTask({ operationId: 'second', activityName: 'charge' });
      queue.enqueue('default', first);
      queue.enqueue('default', second);

      const result1 = await queue.poll('default', ['charge'], 100);
      const result2 = await queue.poll('default', ['charge'], 100);

      expect(result1?.operationId).toBe('first');
      expect(result2?.operationId).toBe('second');
    });

    it('resolves the earliest waiter when multiple are waiting', async () => {
      const queue = new TaskQueue();

      const poll1 = queue.poll('default', ['charge'], 5000);
      const poll2 = queue.poll('default', ['charge'], 5000);

      const task = makeTask({ activityName: 'charge' });
      queue.enqueue('default', task);

      const result1 = await poll1;
      expect(result1).toEqual(task);

      // Second poller is still waiting — enqueue another task
      const task2 = makeTask({ activityName: 'charge' });
      queue.enqueue('default', task2);

      const result2 = await poll2;
      expect(result2).toEqual(task2);
    });

    it('supports multiple activities in a single poll', async () => {
      const queue = new TaskQueue();

      const task = makeTask({ activityName: 'ship' });
      queue.enqueue('default', task);

      const result = await queue.poll('default', ['charge', 'ship', 'refund'], 100);

      expect(result).toEqual(task);
    });
  });

  describe('abort signal', () => {
    it('resolves null when the signal is aborted', async () => {
      const queue = new TaskQueue();
      const controller = new AbortController();

      const pollPromise = queue.poll('default', ['charge'], 60_000, controller.signal);

      controller.abort();

      const result = await pollPromise;
      expect(result).toBeNull();
    });

    it('cleans up the waiter after abort', async () => {
      const queue = new TaskQueue();
      const controller = new AbortController();

      const pollPromise = queue.poll('default', ['charge'], 60_000, controller.signal);
      expect(queue.hasWaiter('default', 'charge')).toBe(true);

      controller.abort();
      await pollPromise;

      expect(queue.hasWaiter('default', 'charge')).toBe(false);
    });
  });

  describe('complete', () => {
    it('invokes the completion callback registered during enqueue', () => {
      const queue = new TaskQueue();
      const results: TaskResult[] = [];

      const task = makeTask({ operationId: 'op-1' });
      queue.enqueue('default', task, (result) => results.push(result));

      const found = queue.complete({
        operationId: 'op-1',
        status: 'completed',
        value: 42,
      });

      expect(found).toBe(true);
      expect(results).toHaveLength(1);
      expect(results[0]).toEqual({
        operationId: 'op-1',
        status: 'completed',
        value: 42,
      });
    });

    it('returns false when no callback is registered', () => {
      const queue = new TaskQueue();

      const found = queue.complete({
        operationId: 'op-unknown',
        status: 'completed',
        value: null,
      });

      expect(found).toBe(false);
    });

    it('removes the callback after invocation', () => {
      const queue = new TaskQueue();
      let callCount = 0;

      const task = makeTask({ operationId: 'op-once' });
      queue.enqueue('default', task, () => {
        callCount += 1;
      });

      queue.complete({ operationId: 'op-once', status: 'completed' });
      queue.complete({ operationId: 'op-once', status: 'completed' });

      expect(callCount).toBe(1);
    });

    it('forwards failure results to the callback', () => {
      const queue = new TaskQueue();
      const results: TaskResult[] = [];

      const task = makeTask({ operationId: 'op-fail' });
      queue.enqueue('default', task, (result) => results.push(result));

      queue.complete({
        operationId: 'op-fail',
        status: 'failed',
        error: 'something broke',
      });

      expect(results[0]?.status).toBe('failed');
      expect(results[0]?.error).toBe('something broke');
    });
  });

  describe('hasWaiter', () => {
    it('returns true when a waiter can handle the activity', async () => {
      const queue = new TaskQueue();

      // Start a poll that will block
      const pollPromise = queue.poll('default', ['charge', 'ship'], 5000);

      expect(queue.hasWaiter('default', 'charge')).toBe(true);
      expect(queue.hasWaiter('default', 'ship')).toBe(true);
      expect(queue.hasWaiter('default', 'refund')).toBe(false);

      // Clean up
      queue.enqueue('default', makeTask({ activityName: 'charge' }));
      await pollPromise;
    });

    it('returns false when no waiters exist', () => {
      const queue = new TaskQueue();

      expect(queue.hasWaiter('default', 'charge')).toBe(false);
    });
  });

  describe('deduplication', () => {
    it('rejects a second enqueue with the same operationId', () => {
      const queue = new TaskQueue();

      const first = queue.enqueue('default', makeTask({ operationId: 'op-1' }));
      const second = queue.enqueue('default', makeTask({ operationId: 'op-1' }));

      expect(first).toBe(true);
      expect(second).toBe(false);
      expect(queue.pendingCount('default')).toBe(1);
    });

    it('rejects duplicate even when first was dispatched to a waiter', async () => {
      const queue = new TaskQueue();

      // Start a poll that will block
      const pollPromise = queue.poll('default', ['charge'], 5000);

      // Enqueue — dispatched directly to waiter
      const first = queue.enqueue(
        'default',
        makeTask({ operationId: 'dup-1', activityName: 'charge' }),
      );
      expect(first).toBe(true);
      await pollPromise;

      // Second enqueue with same operationId should be rejected
      const second = queue.enqueue(
        'default',
        makeTask({ operationId: 'dup-1', activityName: 'charge' }),
      );
      expect(second).toBe(false);
    });

    it('allows re-enqueue after completion', () => {
      const queue = new TaskQueue();

      queue.enqueue('default', makeTask({ operationId: 'op-reuse' }), () => {});
      queue.complete({ operationId: 'op-reuse', status: 'completed', value: null });

      // After completion the operationId should be available again
      const result = queue.enqueue('default', makeTask({ operationId: 'op-reuse' }));
      expect(result).toBe(true);
    });

    it('isTracked returns true for pending tasks', () => {
      const queue = new TaskQueue();

      expect(queue.isTracked('op-1')).toBe(false);

      queue.enqueue('default', makeTask({ operationId: 'op-1' }));
      expect(queue.isTracked('op-1')).toBe(true);
    });

    it('isTracked returns false after task is completed', () => {
      const queue = new TaskQueue();

      queue.enqueue('default', makeTask({ operationId: 'op-1' }), () => {});
      queue.complete({ operationId: 'op-1', status: 'completed' });

      expect(queue.isTracked('op-1')).toBe(false);
    });
  });

  describe('removeStale', () => {
    it('removes tasks older than maxAge and invokes completion callbacks with failed status', () => {
      const queue = new TaskQueue();
      const results: TaskResult[] = [];

      const task = makeTask({ operationId: 'stale-1' });
      // Backdate the enqueuedAt so the task appears old
      task.enqueuedAt = Date.now() - 10_000;

      queue.enqueue('default', task, (result) => results.push(result));

      const removed = queue.removeStale(5_000);

      expect(removed).toHaveLength(1);
      expect(removed[0]?.operationId).toBe('stale-1');
      expect(results).toHaveLength(1);
      expect(results[0]?.status).toBe('failed');
      expect(results[0]?.error).toContain('expired');
      expect(queue.pendingCount('default')).toBe(0);
      expect(queue.isTracked('stale-1')).toBe(false);
    });

    it('does not remove tasks younger than maxAge', () => {
      const queue = new TaskQueue();
      const task = makeTask({ operationId: 'fresh-1' });

      queue.enqueue('default', task);

      const removed = queue.removeStale(60_000);

      expect(removed).toHaveLength(0);
      expect(queue.pendingCount('default')).toBe(1);
      expect(queue.isTracked('fresh-1')).toBe(true);
    });

    it('allows re-enqueue of a stale operationId after removal', () => {
      const queue = new TaskQueue();
      const task = makeTask({ operationId: 'reuse-stale' });
      task.enqueuedAt = Date.now() - 10_000;

      queue.enqueue('default', task);
      queue.removeStale(5_000);

      expect(queue.isTracked('reuse-stale')).toBe(false);

      const reEnqueued = queue.enqueue('default', makeTask({ operationId: 'reuse-stale' }));
      expect(reEnqueued).toBe(true);
      expect(queue.pendingCount('default')).toBe(1);
    });
  });

  describe('pendingCount', () => {
    it('tracks the number of pending tasks', () => {
      const queue = new TaskQueue();

      expect(queue.pendingCount('default')).toBe(0);

      queue.enqueue('default', makeTask());
      queue.enqueue('default', makeTask());

      expect(queue.pendingCount('default')).toBe(2);
    });

    it('decrements when tasks are polled', async () => {
      const queue = new TaskQueue();

      queue.enqueue('default', makeTask({ activityName: 'charge' }));
      queue.enqueue('default', makeTask({ activityName: 'charge' }));

      await queue.poll('default', ['charge'], 100);

      expect(queue.pendingCount('default')).toBe(1);
    });

    it('returns 0 for unknown queues', () => {
      const queue = new TaskQueue();

      expect(queue.pendingCount('nonexistent')).toBe(0);
    });
  });

  describe('pending task expiration', () => {
    it('removes a pending task after the TTL expires', async () => {
      const queue = new TaskQueue({ pendingTaskTimeToLive: 50 });

      queue.enqueue('default', makeTask({ operationId: 'ttl-1', activityName: 'charge' }));
      expect(queue.pendingCount('default')).toBe(1);
      expect(queue.isTracked('ttl-1')).toBe(true);

      // Wait for the TTL to fire
      await Bun.sleep(100);

      expect(queue.pendingCount('default')).toBe(0);
      expect(queue.isTracked('ttl-1')).toBe(false);
    });

    it('invokes the completion callback with a failure on expiration', async () => {
      const queue = new TaskQueue({ pendingTaskTimeToLive: 50 });
      const results: TaskResult[] = [];

      queue.enqueue('default', makeTask({ operationId: 'ttl-cb' }), (result) =>
        results.push(result),
      );

      await Bun.sleep(100);

      expect(results).toHaveLength(1);
      expect(results[0]?.operationId).toBe('ttl-cb');
      expect(results[0]?.status).toBe('failed');
      expect(results[0]?.error).toContain('expired');
    });

    it('does not expire a task that was polled before the TTL', async () => {
      const queue = new TaskQueue({ pendingTaskTimeToLive: 100 });
      const results: TaskResult[] = [];

      queue.enqueue(
        'default',
        makeTask({ operationId: 'ttl-polled', activityName: 'charge' }),
        (result) => results.push(result),
      );

      // Poll the task before expiration
      const task = await queue.poll('default', ['charge'], 1000);
      expect(task?.operationId).toBe('ttl-polled');

      // Wait past the original TTL
      await Bun.sleep(150);

      // Callback should not have been invoked by expiration
      expect(results).toHaveLength(0);
      // The task is no longer pending (it was polled), but still tracked as dispatched
      expect(queue.pendingCount('default')).toBe(0);
    });

    it('does not expire a task dispatched directly to a waiter', async () => {
      const queue = new TaskQueue({ pendingTaskTimeToLive: 50 });
      const results: TaskResult[] = [];

      // Start a poll that will block
      const pollPromise = queue.poll('default', ['charge'], 5000);

      // Enqueue — dispatched directly to the waiter, never enters #pending
      queue.enqueue(
        'default',
        makeTask({ operationId: 'ttl-direct', activityName: 'charge' }),
        (result) => results.push(result),
      );

      const task = await pollPromise;
      expect(task?.operationId).toBe('ttl-direct');

      // Wait past TTL
      await Bun.sleep(100);

      // No expiration callback should have fired
      expect(results).toHaveLength(0);
    });

    it('allows re-enqueue after a task expires', async () => {
      const queue = new TaskQueue({ pendingTaskTimeToLive: 50 });

      queue.enqueue('default', makeTask({ operationId: 'ttl-reuse' }));

      // Wait for expiration
      await Bun.sleep(100);

      expect(queue.isTracked('ttl-reuse')).toBe(false);

      // Should be able to re-enqueue
      const result = queue.enqueue('default', makeTask({ operationId: 'ttl-reuse' }));
      expect(result).toBe(true);
    });

    it('does not expire tasks when TTL is Infinity', async () => {
      const queue = new TaskQueue({ pendingTaskTimeToLive: Infinity });

      queue.enqueue('default', makeTask({ operationId: 'ttl-inf', activityName: 'charge' }));

      await Bun.sleep(50);

      expect(queue.pendingCount('default')).toBe(1);
      expect(queue.isTracked('ttl-inf')).toBe(true);
    });

    it('does not expire tasks when TTL is 0', async () => {
      const queue = new TaskQueue({ pendingTaskTimeToLive: 0 });

      queue.enqueue('default', makeTask({ operationId: 'ttl-zero', activityName: 'charge' }));

      await Bun.sleep(50);

      expect(queue.pendingCount('default')).toBe(1);
      expect(queue.isTracked('ttl-zero')).toBe(true);
    });

    it('cleans up completion callback when task expires without one', async () => {
      const queue = new TaskQueue({ pendingTaskTimeToLive: 50 });

      // Enqueue without a callback
      queue.enqueue('default', makeTask({ operationId: 'ttl-no-cb' }));

      await Bun.sleep(100);

      // Task should be cleaned up without errors
      expect(queue.pendingCount('default')).toBe(0);
      expect(queue.isTracked('ttl-no-cb')).toBe(false);

      // Calling complete on an expired task should return false (no callback)
      const found = queue.complete({ operationId: 'ttl-no-cb', status: 'completed' });
      expect(found).toBe(false);
    });
  });
});
