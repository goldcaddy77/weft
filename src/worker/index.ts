// ---------------------------------------------------------------------------
// Remote worker client — connects to the server via WebSocket
// ---------------------------------------------------------------------------

import {
  buildComposedInterceptor,
  executeWithInterceptors,
  type ComposedInterceptor,
} from './execute-with-interceptors.ts';
import { HeartbeatManager } from './heartbeat.ts';

export { HeartbeatManager } from './heartbeat.ts';
export { LongPollWorker } from './long-poll.ts';
export type { LongPollWorkerOptions } from './long-poll.ts';
export { WorkerRegistry } from './registry.ts';
export type { InFlightTask, RoutingOptions, WorkerInfo } from './registry.ts';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Context passed to activity functions executed by a remote worker. */
export interface RemoteActivityContext {
  signal: AbortSignal;
}

export interface RemoteWorkerOptions {
  serverUrl: string;
  workerId?: string;
  activities: Record<string, (input: unknown, context?: RemoteActivityContext) => Promise<unknown>>;
  concurrency?: number; // default: 10
  queue?: string; // default: 'default'
  disconnectTimeoutMs?: number; // default: 30_000
  /** Activity interceptors to run around each activity execution on this worker. */
  interceptors?: import('../core/interceptor.ts').ActivityInterceptor[];
}

interface TaskMessage {
  type: 'task';
  operationId: string;
  activityName: string;
  input: unknown;
  attempt?: number;
  /** Propagated interceptor headers from the dispatch path. */
  headers?: Record<string, string>;
}

interface ServerMessage {
  type: string;
  [key: string]: unknown;
}

// ---------------------------------------------------------------------------
// RemoteWorker
// ---------------------------------------------------------------------------

const DEFAULT_CONCURRENCY = 10;
const DEFAULT_QUEUE = 'default';
const HEARTBEAT_INTERVAL_MS = 10_000;
const DEFAULT_DISCONNECT_TIMEOUT_MS = 30_000;

export class RemoteWorker implements Disposable {
  #options: RemoteWorkerOptions;
  #ws: WebSocket | null;
  #inFlight: number;
  #abortController: AbortController;
  #heartbeat: HeartbeatManager;
  #shuttingDown: boolean;
  #taskAbortControllers: Map<string, AbortController>;
  #composedInterceptor: ComposedInterceptor | null;

  constructor(options: RemoteWorkerOptions) {
    this.#options = {
      ...options,
      concurrency: options.concurrency ?? DEFAULT_CONCURRENCY,
      queue: options.queue ?? DEFAULT_QUEUE,
      workerId: options.workerId ?? crypto.randomUUID(),
    };
    this.#ws = null;
    this.#inFlight = 0;
    this.#abortController = new AbortController();
    this.#shuttingDown = false;
    this.#taskAbortControllers = new Map();
    this.#composedInterceptor = buildComposedInterceptor(options.interceptors);
    /* c8 ignore next 3 -- heartbeat timer execution is covered by integration behavior rather than constructor attribution */
    this.#heartbeat = new HeartbeatManager(() => {
      this.#sendMessage({ type: 'heartbeat', workerId: this.#options.workerId });
    }, HEARTBEAT_INTERVAL_MS);
  }

  /** Connect to the server and start processing tasks. */
  async connect(): Promise<void> {
    // Reset shutdown flag so a reconnection after graceful shutdown can
    // accept new tasks (the flag is set by #gracefulShutdown and never
    // cleared elsewhere).
    this.#shuttingDown = false;

    return new Promise<void>((resolve, reject) => {
      let settled = false;
      const ws = new WebSocket(this.#options.serverUrl);

      ws.addEventListener(
        'open',
        () => {
          settled = true;
          this.#ws = ws;
          this.#sendMessage({
            type: 'register',
            workerId: this.#options.workerId,
            activities: Object.keys(this.#options.activities),
            concurrency: this.#options.concurrency,
            queue: this.#options.queue,
          });
          this.#heartbeat.start();
          resolve();
        },
        { signal: this.#abortController.signal },
      );

      ws.addEventListener(
        'message',
        (event: MessageEvent) => {
          void this.#handleMessage(event);
        },
        { signal: this.#abortController.signal },
      );

      ws.addEventListener(
        'error',
        () => {
          if (!settled) {
            settled = true;
            reject(new Error('WebSocket connection failed'));
          }
        },
        { signal: this.#abortController.signal },
      );

      ws.addEventListener(
        'close',
        () => {
          this.#heartbeat.stop();
          this.#ws = null;
        },
        { signal: this.#abortController.signal },
      );
    });
  }

  /** Gracefully disconnect: finish in-flight, then close. */
  async disconnect(): Promise<void> {
    this.#heartbeat.stop();
    await this.#drainAndClose();
  }

  /** Get the number of in-flight tasks. */
  get inFlight(): number {
    return this.#inFlight;
  }

  /** Whether the worker is connected. */
  get connected(): boolean {
    return this.#ws !== null && this.#ws.readyState === WebSocket.OPEN;
  }

  /** Whether the worker is in the process of shutting down. */
  get shuttingDown(): boolean {
    return this.#shuttingDown;
  }

  [Symbol.dispose](): void {
    this.#abortAllTasks();
    this.#abortController.abort();
    this.#abortController = new AbortController();
    this.#heartbeat.stop();

    if (this.#ws !== null) {
      this.#ws.close();
      this.#ws = null;
    }
  }

  // ---------------------------------------------------------------------------
  // Internal
  // ---------------------------------------------------------------------------

  /** Abort all in-flight task controllers and clear the map. */
  #abortAllTasks(): void {
    for (const controller of this.#taskAbortControllers.values()) {
      controller.abort();
    }
    this.#taskAbortControllers.clear();
  }

  async #gracefulShutdown(): Promise<void> {
    this.#shuttingDown = true;
    this.#heartbeat.stop();
    await this.#drainAndClose();
  }

  /** Drain in-flight tasks (with timeout), abort listeners, and close the socket. */
  async #drainAndClose(): Promise<void> {
    const timeout = this.#options.disconnectTimeoutMs ?? DEFAULT_DISCONNECT_TIMEOUT_MS;
    const deadline = Date.now() + timeout;

    while (this.#inFlight > 0) {
      if (Date.now() >= deadline) {
        console.warn(
          `[weft] RemoteWorker timed out after ${timeout}ms with ${this.#inFlight} tasks still in-flight`,
        );
        // Abort all remaining in-flight task controllers so activities don't
        // continue running after the worker has disconnected.
        this.#abortAllTasks();
        break;
      }
      await Bun.sleep(50);
    }

    // Always abort the old controller to detach event listeners, even if the
    // remote end already closed the connection (which sets #ws to null via the
    // close listener). Then swap to a fresh controller for future connect() calls.
    const oldAbortController = this.#abortController;
    this.#abortController = new AbortController();
    oldAbortController.abort();

    if (this.#ws !== null) {
      this.#ws.close();
      this.#ws = null;
    }
  }

  async #handleMessage(event: MessageEvent): Promise<void> {
    const data = JSON.parse(String(event.data)) as ServerMessage;

    if (data.type === 'task') {
      if (this.#shuttingDown) return;
      const task = data as unknown as TaskMessage;
      await this.#executeTask(task);
    } else if (data.type === 'shutdown') {
      void this.#gracefulShutdown();
    } else if (data.type === 'cancel') {
      const operationId = data['operationId'];
      if (typeof operationId !== 'string') {
        console.warn(
          '[weft] Received cancel message with missing or non-string operationId — ignoring',
        );
        return;
      }
      const controller = this.#taskAbortControllers.get(operationId);
      if (controller) {
        controller.abort();
      }
    }
  }

  async #executeTask(task: TaskMessage): Promise<void> {
    const activityFunction = this.#options.activities[task.activityName];
    if (activityFunction === undefined) {
      this.#sendMessage({
        type: 'taskResult',
        operationId: task.operationId,
        status: 'failed',
        error: `Unknown activity: ${task.activityName}`,
      });
      return;
    }

    const taskAbortController = new AbortController();
    this.#taskAbortControllers.set(task.operationId, taskAbortController);
    this.#inFlight += 1;

    try {
      const result = await executeWithInterceptors(
        activityFunction,
        task,
        this.#composedInterceptor,
        taskAbortController.signal,
      );

      this.#sendMessage({
        type: 'taskResult',
        operationId: task.operationId,
        status: 'completed',
        value: result,
      });
    } catch (error) {
      if (taskAbortController.signal.aborted) {
        this.#sendMessage({
          type: 'taskResult',
          operationId: task.operationId,
          status: 'cancelled',
          cancelled: true,
          error: 'Task cancelled',
        });
      } else {
        this.#sendMessage({
          type: 'taskResult',
          operationId: task.operationId,
          status: 'failed',
          error: error instanceof Error ? error.message : String(error),
        });
      }
    } finally {
      this.#taskAbortControllers.delete(task.operationId);
      this.#inFlight -= 1;
    }
  }

  #sendMessage(message: Record<string, unknown>): void {
    if (this.#ws !== null && this.#ws.readyState === WebSocket.OPEN) {
      this.#ws.send(JSON.stringify(message));
    }
  }
}
