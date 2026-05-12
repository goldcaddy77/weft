/**
 * Construction options for {@link WorkerPool}.
 *
 * `concurrency` sets the maximum number of Worker instances created; once this
 * limit is reached, `acquire()` calls queue until a worker is released.
 * `workerUrl` is the script URL passed to `new Worker()`.  Set `smol: true` on
 * Bun to request a reduced-heap worker.
 *
 * @example
 * ```ts
 * import { WorkerPool, type WorkerPoolOptions } from 'weft';
 *
 * const options: WorkerPoolOptions = {
 *   concurrency: 4,
 *   workerUrl: new URL('./activity-worker.ts', import.meta.url),
 *   smol: false,
 * };
 * using pool = new WorkerPool(options);
 * void pool;
 * ```
 */
export interface WorkerPoolOptions {
  concurrency: number;
  workerUrl: string | URL;
  smol?: boolean;
}

/**
 * Bounded pool of Web Workers with acquire/release lifecycle management.
 *
 * Workers are created lazily up to `concurrency` and reused across tasks.
 * `acquire()` returns a `Worker` immediately if one is available, creates a new
 * one if under the limit, or queues the request until a worker is released.
 * Use `[Symbol.asyncDispose]()` for a graceful shutdown that waits for
 * in-flight workers to finish, or `[Symbol.dispose]()` for immediate
 * termination.
 *
 * @example
 * ```ts
 * import { WorkerPool } from 'weft';
 *
 * await using pool = new WorkerPool({
 *   concurrency: 2,
 *   workerUrl: new URL('./worker.ts', import.meta.url),
 * });
 *
 * const worker = await pool.acquire();
 * worker.postMessage({ task: 'hello' });
 * // ... wait for message event ...
 * pool.release(worker);
 * ```
 */
export class WorkerPool implements Disposable, AsyncDisposable {
  #workers: Set<Worker>;
  #available: Worker[];
  #queue: Array<{ resolve: (worker: Worker) => void }>;
  #specificWorkerQueue: Map<Worker, Array<{ resolve: (worker: Worker) => void }>>;
  #concurrency: number;
  #workerUrl: string | URL;
  #smol: boolean;
  #disposed: boolean;
  #asyncDisposeResolve: (() => void) | null;

  constructor(options: WorkerPoolOptions) {
    this.#workers = new Set();
    this.#available = [];
    this.#queue = [];
    this.#specificWorkerQueue = new Map();
    this.#concurrency = options.concurrency;
    this.#workerUrl = options.workerUrl;
    this.#smol = options.smol ?? false;
    this.#disposed = false;
    this.#asyncDisposeResolve = null;
  }

  /** Acquire a worker from the pool. Blocks if at capacity. */
  async acquire(): Promise<Worker> {
    if (this.#disposed) {
      throw new Error('WorkerPool has been disposed');
    }

    // If there is an available worker, return it immediately.
    const available = this.#available.pop();
    if (available) {
      return available;
    }

    // If we haven't hit the concurrency limit, create a new worker.
    if (this.#workers.size < this.#concurrency) {
      const worker = this.#createWorker();
      return worker;
    }

    // Otherwise, queue the request and wait.
    return new Promise<Worker>((resolve) => {
      this.#queue.push({ resolve });
    });
  }

  /**
   * Acquire a specific worker once it is released back to the pool.
   *
   * This is intentionally narrower than `acquire()`: it preserves worker-local
   * generator state for parked workflow execution without reserving unrelated
   * idle workers while the target worker is still busy.
   */
  async acquireSpecificWorker(worker: Worker): Promise<Worker> {
    if (this.#disposed) {
      throw new Error('WorkerPool has been disposed');
    }

    if (!this.#workers.has(worker)) {
      throw new Error('Worker does not belong to this WorkerPool');
    }

    const availableIndex = this.#available.indexOf(worker);
    if (availableIndex >= 0) {
      this.#available.splice(availableIndex, 1);
      return worker;
    }

    return new Promise<Worker>((resolve) => {
      const waiters = this.#specificWorkerQueue.get(worker) ?? [];
      waiters.push({ resolve });
      this.#specificWorkerQueue.set(worker, waiters);
    });
  }

  /** Release a worker back to the pool. */
  release(worker: Worker): void {
    // During graceful shutdown, accept releases so we can track when all
    // in-flight workers have been returned, then terminate.
    if (this.#disposed && !this.#asyncDisposeResolve) {
      return;
    }

    const specificPending = this.#specificWorkerQueue.get(worker);
    if (specificPending && specificPending.length > 0) {
      const pending = specificPending.shift()!;
      if (specificPending.length === 0) {
        this.#specificWorkerQueue.delete(worker);
      }
      pending.resolve(worker);
      return;
    }

    // If someone is waiting, hand the worker directly to them.
    const pending = this.#queue.shift();
    if (pending) {
      pending.resolve(worker);
      return;
    }

    // Return the worker to the available pool.
    this.#available.push(worker);

    // If we're waiting for async dispose and all workers are now available,
    // resolve the dispose promise.
    this.#checkAsyncDispose();
  }

  /** Get the number of available workers. */
  get availableCount(): number {
    return this.#available.length;
  }

  /** Get the total number of workers. */
  get totalCount(): number {
    return this.#workers.size;
  }

  /** Get the number of pending acquire requests. */
  get pendingCount(): number {
    return this.#queue.length;
  }

  /** Immediate termination. */
  [Symbol.dispose](): void {
    if (this.#disposed) {
      return;
    }

    this.#disposed = true;
    this.#terminateAll();
  }

  /** Graceful: wait for in-flight, then terminate. */
  async [Symbol.asyncDispose](): Promise<void> {
    if (this.#disposed) {
      return;
    }

    this.#disposed = true;

    // Drain any pending acquire requests so they don't hold references.
    this.#queue.length = 0;
    this.#specificWorkerQueue.clear();

    // If all workers are available (none in-flight), terminate immediately.
    if (this.#available.length === this.#workers.size) {
      this.#terminateAll();
      return;
    }

    // Otherwise, wait for all in-flight workers to be released.
    return new Promise<void>((resolve) => {
      this.#asyncDisposeResolve = () => {
        this.#terminateAll();
        resolve();
      };
    });
  }

  #createWorker(): Worker {
    const options: WorkerOptions & { smol?: boolean } = {};
    if (this.#smol) {
      options.smol = true;
    }
    const worker = new Worker(this.#workerUrl, options);
    this.#workers.add(worker);
    return worker;
  }

  #terminateAll(): void {
    for (const worker of this.#workers) {
      worker.terminate();
    }
    this.#workers.clear();
    this.#available.length = 0;
    this.#queue.length = 0;
    this.#specificWorkerQueue.clear();
  }

  #checkAsyncDispose(): void {
    if (this.#asyncDisposeResolve && this.#available.length === this.#workers.size) {
      this.#asyncDisposeResolve();
      this.#asyncDisposeResolve = null;
    }
  }
}
