// ---------------------------------------------------------------------------
// Remote worker client — connects to the server via WebSocket
// ---------------------------------------------------------------------------

import { sleep } from '../runtime/portable.ts';
import {
  buildComposedInterceptor,
  executeWithInterceptors,
  type ComposedInterceptor,
} from './execute-with-interceptors.ts';
import { HeartbeatManager } from './heartbeat.ts';
import {
  REMOTE_WORKER_PROTOCOL_VERSION,
  isRemoteWorkerJsonValue,
  parseServerToWorkerMessage,
  type RemoteWorkerCapabilities,
  type RemoteWorkerJsonValue,
  type ServerToWorkerMessage,
  type TaskMessage,
} from './protocol.ts';

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
  deploymentName?: string;
  buildId?: string;
  runtimeVersion?: string;
  gitSha?: string;
  startedAt?: number;
  capabilities?: RemoteWorkerCapabilities;
  /** Activity interceptors to run around each activity execution on this worker. */
  interceptors?: import('../core/interceptor.ts').ActivityInterceptor[];
}

type PendingRegistration = {
  resolve: () => void;
  reject: (error: Error) => void;
};

// ---------------------------------------------------------------------------
// RemoteWorker
// ---------------------------------------------------------------------------

const DEFAULT_CONCURRENCY = 10;
const DEFAULT_QUEUE = 'default';
const HEARTBEAT_INTERVAL_MS = 10_000;
const DEFAULT_DISCONNECT_TIMEOUT_MS = 30_000;

/**
 * WebSocket-based remote worker that connects to the Weft server and executes
 * activities on behalf of the engine.
 *
 * Construct with the server URL, a map of activity implementations, and optional
 * concurrency and queue settings.  Call `start()` to open the WebSocket
 * connection and begin processing tasks.  Dispose the instance (or call
 * `[Symbol.dispose]()`) to close the connection.
 *
 * @example
 * ```ts
 * import { RemoteWorker } from 'weft';
 *
 * using worker = new RemoteWorker({
 *   serverUrl: 'ws://localhost:3000',
 *   activities: {
 *     sendEmail: async (input: unknown) => {
 *       console.log('sending', input);
 *       return 'sent';
 *     },
 *   },
 *   concurrency: 5,
 *   queue: 'email',
 * });
 * await worker.connect();
 * ```
 */
export class RemoteWorker implements Disposable {
  #options: RemoteWorkerOptions;
  #ws: WebSocket | null;
  #inFlight: number;
  #abortController: AbortController;
  #heartbeat: HeartbeatManager;
  #shuttingDown: boolean;
  #taskAbortControllers: Map<string, AbortController>;
  #composedInterceptor: ComposedInterceptor | null;
  #pendingRegistration: PendingRegistration | null;

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
    this.#pendingRegistration = null;
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
      const ws = new WebSocket(this.#options.serverUrl);
      this.#pendingRegistration = { resolve, reject };

      ws.addEventListener(
        'open',
        () => {
          this.#ws = ws;
          this.#sendMessage({
            type: 'register',
            protocolVersion: REMOTE_WORKER_PROTOCOL_VERSION,
            workerId: this.#options.workerId,
            activities: Object.keys(this.#options.activities),
            concurrency: this.#options.concurrency,
            queue: this.#options.queue,
            ...(this.#options.deploymentName !== undefined
              ? { deploymentName: this.#options.deploymentName }
              : {}),
            ...(this.#options.buildId !== undefined ? { buildId: this.#options.buildId } : {}),
            ...(this.#options.runtimeVersion !== undefined
              ? { runtimeVersion: this.#options.runtimeVersion }
              : {}),
            ...(this.#options.gitSha !== undefined ? { gitSha: this.#options.gitSha } : {}),
            ...(this.#options.startedAt !== undefined
              ? { startedAt: this.#options.startedAt }
              : {}),
            ...(this.#options.capabilities !== undefined
              ? { capabilities: this.#options.capabilities }
              : {}),
          });
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
          this.#rejectPendingRegistration('WebSocket connection failed');
        },
        { signal: this.#abortController.signal },
      );

      ws.addEventListener(
        'close',
        () => {
          this.#heartbeat.stop();
          this.#ws = null;
          this.#rejectPendingRegistration('WebSocket closed before worker registration completed');
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
    this.#rejectPendingRegistration('Worker disposed before worker registration completed');
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
      await sleep(50);
    }

    // Always abort the old controller to detach event listeners, even if the
    // remote end already closed the connection (which sets #ws to null via the
    // close listener). Then swap to a fresh controller for future connect() calls.
    this.#rejectPendingRegistration('Worker disconnected before worker registration completed');
    const oldAbortController = this.#abortController;
    this.#abortController = new AbortController();
    oldAbortController.abort();

    if (this.#ws !== null) {
      this.#ws.close();
      this.#ws = null;
    }
  }

  #parseServerMessage(event: MessageEvent): ServerToWorkerMessage | null {
    let rawData: unknown;
    try {
      rawData = JSON.parse(String(event.data));
    } catch {
      console.warn('[weft] Received non-JSON server message — ignoring');
      return null;
    }

    const parsed = parseServerToWorkerMessage(rawData);
    if (!parsed.ok) {
      if (parsed.error.code === 'unknown_message_type') {
        return null;
      }
      console.warn(`[weft] Received malformed server message: ${parsed.error.message}`);
      return null;
    }

    return parsed.message;
  }

  #handleRegisterAck(): void {
    if (this.#pendingRegistration === null) return;

    const pending = this.#pendingRegistration;
    this.#pendingRegistration = null;
    this.#heartbeat.start();
    pending.resolve();
  }

  #handleRegisterError(message: string): void {
    this.#rejectPendingRegistration(message);
    this.#heartbeat.stop();
    this.#ws?.close();
  }

  #rejectPendingRegistration(message: string): void {
    if (this.#pendingRegistration === null) return;

    const pending = this.#pendingRegistration;
    this.#pendingRegistration = null;
    pending.reject(new Error(message));
  }

  #handleCancel(operationId: string): void {
    const controller = this.#taskAbortControllers.get(operationId);
    if (controller) controller.abort();
  }

  async #handleMessage(event: MessageEvent): Promise<void> {
    const data = this.#parseServerMessage(event);
    if (data === null) return;

    switch (data.type) {
      case 'registerAck':
        this.#handleRegisterAck();
        break;
      case 'registerError':
        this.#handleRegisterError(data.message);
        break;
      case 'protocolError':
        console.warn(`[weft] RemoteWorker protocol error from server: ${data.message}`);
        break;
      case 'task':
        if (!this.#shuttingDown) await this.#executeTask(data);
        break;
      case 'shutdown':
        void this.#gracefulShutdown();
        break;
      case 'cancel':
        this.#handleCancel(data.operationId);
        break;
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
        value: normalizeWorkerJsonValue(result),
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

function normalizeWorkerJsonValue(value: unknown): RemoteWorkerJsonValue {
  if (value === undefined) return null;
  const encoded = JSON.stringify(value);
  if (encoded === undefined) return null;
  const parsed: unknown = JSON.parse(encoded);
  return isRemoteWorkerJsonValue(parsed) ? parsed : null;
}
