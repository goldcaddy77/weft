export interface WorkerPoolOptions {
  concurrency: number;
  workerUrl: string | URL;
  smol?: boolean;
}

export class WorkerPool implements Disposable, AsyncDisposable {
  #workers: Set<Worker>;
  #available: Worker[];
  #queue: Array<{ resolve: (worker: Worker) => void }>;
  #concurrency: number;
  #workerUrl: string | URL;
  #smol: boolean;
  #disposed: boolean;
  #asyncDisposeResolve: (() => void) | null;

  constructor(options: WorkerPoolOptions) {
    this.#workers = new Set();
    this.#available = [];
    this.#queue = [];
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

  /** Release a worker back to the pool. */
  release(worker: Worker): void {
    // During graceful shutdown, accept releases so we can track when all
    // in-flight workers have been returned, then terminate.
    if (this.#disposed && !this.#asyncDisposeResolve) {
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
  }

  #checkAsyncDispose(): void {
    if (this.#asyncDisposeResolve && this.#available.length === this.#workers.size) {
      this.#asyncDisposeResolve();
      this.#asyncDisposeResolve = null;
    }
  }
}
