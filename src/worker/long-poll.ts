// ---------------------------------------------------------------------------
// HTTP long-poll fallback worker for environments without WebSocket support
// ---------------------------------------------------------------------------

export interface LongPollWorkerOptions {
  serverUrl: string;
  activities: Record<string, (input: unknown) => Promise<unknown>>;
  concurrency?: number;
  queue?: string;
  pollTimeout?: number; // ms, default: 30000
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_CONCURRENCY = 10;
const DEFAULT_QUEUE = 'default';
const DEFAULT_POLL_TIMEOUT = 30_000;

// ---------------------------------------------------------------------------
// LongPollWorker
// ---------------------------------------------------------------------------

export class LongPollWorker implements Disposable {
  #options: LongPollWorkerOptions;
  #running: boolean;
  #inFlight: number;
  #abortController: AbortController;

  constructor(options: LongPollWorkerOptions) {
    this.#options = {
      ...options,
      concurrency: options.concurrency ?? DEFAULT_CONCURRENCY,
      queue: options.queue ?? DEFAULT_QUEUE,
      pollTimeout: options.pollTimeout ?? DEFAULT_POLL_TIMEOUT,
    };
    this.#running = false;
    this.#inFlight = 0;
    this.#abortController = new AbortController();
  }

  /** Start polling for tasks. */
  start(): void {
    if (this.#running) {
      return;
    }

    this.#running = true;
    this.#abortController = new AbortController();
    void this.#pollLoop();
  }

  /** Stop polling and wait for in-flight to finish. */
  async stop(): Promise<void> {
    this.#running = false;
    this.#abortController.abort();

    // Wait for in-flight tasks to complete
    while (this.#inFlight > 0) {
      await Bun.sleep(50);
    }
  }

  get inFlight(): number {
    return this.#inFlight;
  }

  get running(): boolean {
    return this.#running;
  }

  [Symbol.dispose](): void {
    this.#running = false;
    this.#abortController.abort();
  }

  // ---------------------------------------------------------------------------
  // Internal
  // ---------------------------------------------------------------------------

  async #pollLoop(): Promise<void> {
    while (this.#running) {
      // Only poll when we have capacity
      if (this.#inFlight >= (this.#options.concurrency ?? DEFAULT_CONCURRENCY)) {
        await Bun.sleep(100);
        continue;
      }

      try {
        const response = await fetch(`${this.#options.serverUrl}/poll`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            activities: Object.keys(this.#options.activities),
            queue: this.#options.queue,
            timeout: this.#options.pollTimeout,
          }),
          signal: this.#abortController.signal,
        });

        if (!response.ok) {
          await Bun.sleep(1000);
          continue;
        }

        const task = (await response.json()) as {
          operationId: string;
          activityName: string;
          input: unknown;
        } | null;

        if (task !== null) {
          void this.#executeTask(task);
        }
      } catch {
        // Abort errors are expected during shutdown; network errors trigger a backoff
        if (this.#running) {
          await Bun.sleep(1000);
        }
      }
    }
  }

  async #executeTask(task: {
    operationId: string;
    activityName: string;
    input: unknown;
  }): Promise<void> {
    const activityFunction = this.#options.activities[task.activityName];
    if (activityFunction === undefined) {
      return;
    }

    this.#inFlight += 1;

    try {
      const result = await activityFunction(task.input);

      await fetch(`${this.#options.serverUrl}/complete`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          operationId: task.operationId,
          status: 'completed',
          value: result,
        }),
        signal: this.#abortController.signal,
      });
    } catch (error) {
      try {
        await fetch(`${this.#options.serverUrl}/complete`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            operationId: task.operationId,
            status: 'failed',
            error: error instanceof Error ? error.message : String(error),
          }),
          signal: this.#abortController.signal,
        });
      } catch {
        // Best-effort error reporting; server will eventually time out the task
      }
    } finally {
      this.#inFlight -= 1;
    }
  }
}
