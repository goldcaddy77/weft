// ---------------------------------------------------------------------------
// In-memory task queue for HTTP long-poll workers
// ---------------------------------------------------------------------------

import type { RetryPolicy } from '../core/types.ts';

/** A task waiting to be claimed by a long-poll worker. */
export interface PendingTask {
  operationId: string;
  activityName: string;
  input: unknown;
  attempt?: number | undefined;
  retryPolicy?: RetryPolicy | undefined;
  visibilityTimeout?: number | undefined;
  enqueuedAt?: number | undefined;
  /** Propagated interceptor headers (e.g. W3C trace context, auth tokens). */
  headers?: Record<string, string> | undefined;
}

/** Result reported by a long-poll worker after executing a task. */
export interface TaskResult {
  operationId: string;
  status: 'completed' | 'failed';
  value?: unknown;
  error?: string | undefined;
}

type CompletionCallback = (result: TaskResult) => void;

/** Configuration options for {@link TaskQueue}. */
export type TaskQueueOptions = {
  /**
   * Maximum time (in milliseconds) a task can sit in the pending queue before
   * it expires. When a task expires its completion callback is invoked with a
   * `'failed'` result carrying a timeout error, and all associated state is
   * cleaned up. Set to `0` or `Infinity` to disable expiration.
   *
   * @default 300_000 (5 minutes)
   */
  pendingTaskTimeToLive?: number;
};

const DEFAULT_PENDING_TASK_TTL = 5 * 60 * 1000; // 5 minutes

interface Waiter {
  activities: string[];
  resolve: (task: PendingTask | null) => void;
  timer: ReturnType<typeof setTimeout>;
}

// ---------------------------------------------------------------------------
// TaskQueue
// ---------------------------------------------------------------------------

/**
 * Manages pending tasks and waiting long-poll requests. When a task is
 * enqueued and a matching waiter exists, the task is dispatched immediately.
 * When a poll request arrives and no task is available, the request blocks
 * until a task arrives or the timeout expires.
 */
export class TaskQueue {
  #pending = new Map<string, PendingTask[]>();
  #waiters = new Map<string, Waiter[]>();
  #completionCallbacks = new Map<string, CompletionCallback>();
  #dispatched = new Set<string>();
  /** Expiration timers for pending tasks, keyed by operationId. */
  #expirationTimers = new Map<string, ReturnType<typeof setTimeout>>();
  #pendingTaskTimeToLive: number;

  constructor(options?: TaskQueueOptions) {
    const ttl = options?.pendingTaskTimeToLive ?? DEFAULT_PENDING_TASK_TTL;
    this.#pendingTaskTimeToLive = ttl;
  }

  /**
   * Enqueue a task. If a matching waiter exists, dispatch immediately.
   * Returns true if the task was dispatched to a waiter or queued.
   */
  enqueue(queue: string, task: PendingTask, onComplete?: CompletionCallback): boolean {
    // Reject duplicate operationIds — each task assigned to exactly one worker.
    if (this.#dispatched.has(task.operationId)) {
      return false;
    }

    this.#dispatched.add(task.operationId);
    task.enqueuedAt ??= Date.now();

    if (onComplete) {
      this.#completionCallbacks.set(task.operationId, onComplete);
    }

    const waiters = this.#waiters.get(queue);
    if (waiters && waiters.length > 0) {
      const index = waiters.findIndex((w) => w.activities.includes(task.activityName));

      if (index !== -1) {
        const waiter = waiters[index]!;
        clearTimeout(waiter.timer);
        waiters.splice(index, 1);
        if (waiters.length === 0) this.#waiters.delete(queue);
        waiter.resolve(task);
        return true;
      }
    }

    const tasks = this.#pending.get(queue) ?? [];
    tasks.push(task);
    this.#pending.set(queue, tasks);

    this.#scheduleExpiration(queue, task.operationId);

    return true;
  }

  /**
   * Long-poll for a task. Returns immediately if a matching task is queued,
   * otherwise blocks until a task arrives or `timeout` milliseconds elapse.
   */
  poll(
    queue: string,
    activities: string[],
    timeout: number,
    signal?: AbortSignal,
  ): Promise<PendingTask | null> {
    // Check for an immediately available task
    const tasks = this.#pending.get(queue);
    if (tasks) {
      const index = tasks.findIndex((t) => activities.includes(t.activityName));
      if (index !== -1) {
        const task = tasks.splice(index, 1)[0]!;
        if (tasks.length === 0) this.#pending.delete(queue);
        this.#cancelExpiration(task.operationId);
        return Promise.resolve(task);
      }
    }

    // No task available — wait for one
    return new Promise<PendingTask | null>((_resolve) => {
      let settled = false;
      const resolve = (value: PendingTask | null) => {
        if (settled) return;
        settled = true;
        _resolve(value);
      };

      const waiters = this.#waiters.get(queue) ?? [];
      this.#waiters.set(queue, waiters);

      const cleanup = () => {
        const idx = waiters.indexOf(waiter);
        if (idx !== -1) waiters.splice(idx, 1);
        if (waiters.length === 0) this.#waiters.delete(queue);
      };

      const settle = (value: PendingTask | null) => {
        clearTimeout(timer);
        cleanup();
        resolve(value);
      };

      const timer = setTimeout(() => settle(null), timeout);

      const waiter: Waiter = {
        activities,
        resolve: settle,
        timer,
      };
      waiters.push(waiter);

      if (signal) {
        signal.addEventListener('abort', () => settle(null), { once: true });
      }
    });
  }

  /**
   * Report a task completion. Invokes the completion callback registered
   * during enqueue (if any). Returns true if a callback was found.
   */
  complete(result: TaskResult): boolean {
    this.#cancelExpiration(result.operationId);
    this.#dispatched.delete(result.operationId);

    const callback = this.#completionCallbacks.get(result.operationId);
    if (callback) {
      this.#completionCallbacks.delete(result.operationId);
      callback(result);
      return true;
    }
    return false;
  }

  /** Check whether an operationId is currently tracked (pending or dispatched). */
  isTracked(operationId: string): boolean {
    return this.#dispatched.has(operationId);
  }

  /** Check if any waiter in the queue can handle the given activity. */
  hasWaiter(queue: string, activityName: string): boolean {
    const waiters = this.#waiters.get(queue);
    if (!waiters) return false;
    return waiters.some((w) => w.activities.includes(activityName));
  }

  /** Number of pending (unclaimed) tasks in a queue. */
  pendingCount(queue: string): number {
    return this.#pending.get(queue)?.length ?? 0;
  }

  // ---------------------------------------------------------------------------
  // Pending task expiration
  // ---------------------------------------------------------------------------

  /**
   * Schedule an expiration timer for a pending task. When it fires the task is
   * removed from `#pending`, `#dispatched`, and `#completionCallbacks`, and the
   * completion callback (if any) is invoked with a timeout failure.
   */
  #scheduleExpiration(queue: string, operationId: string): void {
    const ttl = this.#pendingTaskTimeToLive;
    if (ttl <= 0 || !Number.isFinite(ttl)) return;

    const timer = setTimeout(() => this.#expireTask(queue, operationId), ttl);
    this.#expirationTimers.set(operationId, timer);
  }

  /** Cancel a previously scheduled expiration timer. */
  #cancelExpiration(operationId: string): void {
    const timer = this.#expirationTimers.get(operationId);
    if (timer !== undefined) {
      clearTimeout(timer);
      this.#expirationTimers.delete(operationId);
    }
  }

  /** Remove an expired task and notify via the completion callback. */
  #expireTask(queue: string, operationId: string): void {
    this.#expirationTimers.delete(operationId);

    // Remove from the pending list
    const tasks = this.#pending.get(queue);
    if (tasks) {
      const index = tasks.findIndex((t) => t.operationId === operationId);
      if (index !== -1) {
        tasks.splice(index, 1);
        if (tasks.length === 0) this.#pending.delete(queue);
      }
    }

    // Clean up dispatched tracking
    this.#dispatched.delete(operationId);

    // Invoke and remove the completion callback with a timeout error
    const callback = this.#completionCallbacks.get(operationId);
    if (callback) {
      this.#completionCallbacks.delete(operationId);
      callback({
        operationId,
        status: 'failed',
        error: `Task expired after ${this.#pendingTaskTimeToLive}ms without being claimed by a worker`,
      });
    }
  }

  /** Remove and return pending tasks older than `maxAge` milliseconds. */
  removeStale(maxAge: number): PendingTask[] {
    if (!Number.isFinite(maxAge) || maxAge < 0) {
      throw new RangeError(`maxAge must be a finite, non-negative number, got: ${maxAge}`);
    }
    const cutoff = Date.now() - maxAge;
    const stale: PendingTask[] = [];

    for (const [queue, tasks] of this.#pending) {
      const remaining: PendingTask[] = [];

      for (const task of tasks) {
        if ((task.enqueuedAt ?? 0) < cutoff) {
          stale.push(task);
          this.#cancelExpiration(task.operationId);
          this.#dispatched.delete(task.operationId);

          const callback = this.#completionCallbacks.get(task.operationId);
          if (callback) {
            this.#completionCallbacks.delete(task.operationId);
            callback({
              operationId: task.operationId,
              status: 'failed',
              error: `Task expired after ${maxAge}ms without being claimed`,
            });
          }
        } else {
          remaining.push(task);
        }
      }

      if (remaining.length === 0) {
        this.#pending.delete(queue);
      } else {
        this.#pending.set(queue, remaining);
      }
    }

    return stale;
  }
}
