/**
 * Bun.serve() wrapper with WebSocket support, dashboard UI, and clean shutdown.
 *
 * @module server
 */

import type { ServerWebSocket } from 'bun';

import { decode, encode } from '../core/codec.ts';
import type { Engine } from '../core/engine.ts';
import {
  ActivityCompletedEvent,
  ActivityFailedEvent,
  ActivityStartedEvent,
  AttributesChangedEvent,
  SignalDeliveredEvent,
  SignalReceivedEvent,
  TokenEvent,
  UpdateCompletedEvent,
  UpdateReceivedEvent,
  WorkflowCancelledEvent,
  WorkflowCompletedEvent,
  WorkflowFailedEvent,
  WorkflowStartedEvent,
  WorkflowTimedOutEvent,
} from '../core/events.ts';
import { calculateBackoff } from '../core/scheduler.ts';
import type { RetryPolicy } from '../core/types.ts';
import { KEYS } from '../storage/interface.ts';
import { WorkerRegistry } from '../worker/registry.ts';
import type { AuthConfig, Authenticator } from './authentication.ts';
import { buildTLSOptions, createAuthenticator, validateAuthConfig } from './authentication.ts';
import { DeadlineTracker } from './deadline-tracker.ts';
import { handleRequest } from './handler.ts';
import { TaskQueue } from './task-queue.ts';
import type { InflightRecord, QueuedRecord } from './task-state.ts';
import {
  markQueued,
  transitionInflightToQueued,
  transitionInflightToResolved,
  transitionQueuedToInflight,
} from './task-state.ts';

// ---------------------------------------------------------------------------
// Internal types
// ---------------------------------------------------------------------------

/** Type guard for decoded storage records in the inflight state. */
function isInflightRecord(value: unknown): value is InflightRecord {
  if (value === null || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record['operationId'] === 'string' &&
    typeof record['activityName'] === 'string' &&
    typeof record['queue'] === 'string' &&
    typeof record['attempt'] === 'number' &&
    typeof record['visibilityTimeout'] === 'number' &&
    typeof record['workerId'] === 'string' &&
    typeof record['deadline'] === 'number'
  );
}

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface ServeOptions {
  engine: Engine;
  port?: number;
  hostname?: string;
  /** Enable Bun's development mode (HMR, source maps, detailed errors). */
  development?: boolean;
  /** Dashboard HTML import for Bun's static route handler (e.g., `import dashboard from './index.html'`). */
  dashboard?: unknown;
  /** Authentication configuration. When provided, all non-public endpoints require valid credentials. */
  auth?: AuthConfig;
  /** How often (in ms) the server scans `op:inflight:*` for expired visibility deadlines. Defaults to 5 000. */
  visibilityPollIntervalMs?: number;
}

export interface TaskDispatch {
  operationId: string;
  activityName: string;
  input: unknown;
  attempt?: number;
  /** Queue to dispatch the task to. Defaults to `'default'`. */
  queue?: string;
  /** Workflow ID. Required for sticky routing to track worker affinity. */
  workflowId?: string | undefined;
  /** When true, prefer the worker that last handled a task for this workflow. Requires `workflowId`. */
  sticky?: boolean;
  /** Visibility timeout in milliseconds. Defaults to `DEFAULT_VISIBILITY_TIMEOUT` (30 000). */
  visibilityTimeout?: number;
  /** Retry policy governing maxAttempts and backoff between reassignment attempts. */
  retryPolicy?: RetryPolicy;
}

export interface WeftServer extends AsyncDisposable {
  readonly port: number;
  readonly hostname: string;
  readonly url: string;
  readonly registry: WorkerRegistry;
  readonly taskQueue: TaskQueue;
  stop(): Promise<void>;
  /** Dispatch a task to the best available worker. Returns true if dispatched. */
  dispatchTask(task: TaskDispatch): Promise<boolean>;
}

// ---------------------------------------------------------------------------
// Internal types
// ---------------------------------------------------------------------------

type ConnectionType = 'worker' | 'stream' | 'watch' | 'generic';

interface WebSocketData {
  pathname: string;
  connectionType: ConnectionType;
  /** Workflow ID extracted from the URL for stream/watch connections. */
  workflowId?: string;
  /** Queue name extracted from the URL for worker connections. */
  queue?: string;
  workerId?: string;
}

// ---------------------------------------------------------------------------
// Worker stream helpers
// ---------------------------------------------------------------------------

const WORKER_STREAM_RE = /^\/v1\/tasks\/([\w-]+)\/stream$/;
const WORKFLOW_STREAM_RE = /^\/v1\/workflows\/([\w-]+)\/stream$/;
const WORKFLOW_WATCH_RE = /^\/v1\/workflows\/([\w-]+)\/watch$/;
const TASK_POLL_RE = /^\/v1\/tasks\/([\w-]+)$/;
const TASK_RESULT_RE = /^\/v1\/tasks\/([\w-]+)\/result$/;

const MAX_POLL_TIMEOUT = 60_000;
const DEFAULT_POLL_TIMEOUT = 30_000;
const MAX_AFFINITY_ENTRIES = 10_000;
const DEFAULT_VISIBILITY_TIMEOUT = 30_000;
const MIN_VISIBILITY_TIMEOUT = 10;
const MAX_VISIBILITY_TIMEOUT = 3_600_000;
const MAX_WORKER_CONCURRENCY = 1_000;
/** Reconciliation full-scan runs at this multiple of the visibility poll interval (~60s at default). */
const RECONCILIATION_MULTIPLIER = 12;

/**
 * Clamp a visibility timeout to the allowed range.
 *
 * Negative or near-zero values cause immediate expiry, and `Infinity`
 * prevents expiry entirely—both are dangerous. This helper constrains
 * the value to [10 ms, 3 600 000 ms] (10 milliseconds to 1 hour).
 */
function clampVisibilityTimeout(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return DEFAULT_VISIBILITY_TIMEOUT;
  return Math.min(Math.max(value, MIN_VISIBILITY_TIMEOUT), MAX_VISIBILITY_TIMEOUT);
}

/**
 * Retry an async operation with a simple linear backoff.
 *
 * `maxAttempts` controls the total number of tries (including the initial one).
 * The default of `2` means: try once, and if it fails, retry once more.
 *
 * Used for critical fire-and-forget paths (event persistence, inflight
 * restoration) where a single transient failure should not silently lose data.
 */
async function withRetry<T>(
  operation: () => Promise<T>,
  label: string,
  maxAttempts = 2,
): Promise<T> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      if (attempt < maxAttempts) {
        console.warn(`[weft] Retrying "${label}" (attempt ${attempt + 1}/${maxAttempts})`);
        // Brief delay before retry — 100 ms × attempt number.
        await Bun.sleep(100 * attempt);
      }
    }
  }
  // All attempts exhausted — throw the last error so callers can handle it.
  throw lastError;
}

function isWorkerConnection(pathname: string): boolean {
  return WORKER_STREAM_RE.test(pathname);
}

/** Classify a WebSocket pathname and extract relevant parameters. */
function classifyConnection(
  pathname: string,
): Pick<WebSocketData, 'connectionType' | 'workflowId' | 'queue'> {
  const streamMatch = WORKFLOW_STREAM_RE.exec(pathname);
  if (streamMatch?.[1]) {
    return { connectionType: 'stream', workflowId: decodeURIComponent(streamMatch[1]) };
  }

  const watchMatch = WORKFLOW_WATCH_RE.exec(pathname);
  if (watchMatch?.[1]) {
    return { connectionType: 'watch', workflowId: decodeURIComponent(watchMatch[1]) };
  }

  const workerMatch = WORKER_STREAM_RE.exec(pathname);
  if (workerMatch?.[1]) {
    return { connectionType: 'worker', queue: decodeURIComponent(workerMatch[1]) };
  }

  return { connectionType: 'generic' };
}

// ---------------------------------------------------------------------------
// WebSocket event broadcasting
// ---------------------------------------------------------------------------

/**
 * Serialize an engine event to a JSON message for WebSocket clients.
 *
 * The wire format matches the dashboard's `WorkflowEvent` interface:
 * `{ type: string; timestamp: number; data: Record<string, unknown> }`.
 */
function serializeEvent(event: Event): string | null {
  const data: Record<string, unknown> = {};

  // Extract all public properties from the event into the nested data bag
  for (const [key, value] of Object.entries(event)) {
    if (key === 'type') continue;
    // Serialize Error objects to plain strings
    if (value instanceof Error) {
      data[key] = value.message;
    } else {
      data[key] = value;
    }
  }

  const message: { type: string; timestamp: number; data: Record<string, unknown> } = {
    type: event.type,
    timestamp: Date.now(),
    data,
  };

  return JSON.stringify(message);
}

/**
 * Attach event listeners to the engine that broadcast events via WebSocket
 * and persist each event to storage so GET /v1/workflows/:id/events returns data.
 * Returns a cleanup function that removes all listeners.
 */
function wireEventBroadcasting(engine: Engine, server: ReturnType<typeof Bun.serve>): () => void {
  const controller = new AbortController();
  const { signal } = controller;

  /**
   * Per-workflow monotonic sequence counter for event storage keys.
   *
   * On first access for a given workflow, the counter is initialized from
   * storage by scanning for the highest existing event key. This prevents
   * sequence numbers from resetting to 0 after a server restart, which would
   * silently overwrite previously persisted events.
   */
  const sequenceCounters = new Map<string, number>();
  const sequenceInitPromises = new Map<string, Promise<void>>();

  /**
   * Per-workflow serialization chain. Each workflow's events are persisted
   * sequentially by chaining promises—this eliminates the read-modify-write
   * race on `sequenceCounters` without requiring an explicit mutex.
   */
  const sequenceChains = new Map<string, Promise<void>>();

  /** Ensure the sequence counter for a workflow is seeded from storage. */
  function ensureSequenceInitialized(workflowId: string): Promise<void> {
    const existing = sequenceInitPromises.get(workflowId);
    if (existing) return existing;

    const promise = (async () => {
      const prefix = `ev:${workflowId}:`;
      let highestSequence = -1;

      for await (const [key] of engine.storage.scan(prefix, { reverse: true, limit: 1 })) {
        // Key format: ev:{workflowId}:{zero-padded sequence}
        const parts = key.split(':');
        const sequencePart = parts[parts.length - 1];
        if (sequencePart !== undefined) {
          highestSequence = parseInt(sequencePart, 10);
        }
      }

      // Start after the highest existing sequence number.
      sequenceCounters.set(workflowId, highestSequence + 1);
    })().catch((error) => {
      // Clear the cached promise so a subsequent event can retry initialization
      // instead of perpetually reusing a rejected promise.
      sequenceInitPromises.delete(workflowId);
      throw error;
    });

    sequenceInitPromises.set(workflowId, promise);
    return promise;
  }

  /**
   * Atomically claim the next sequence number for a workflow.
   *
   * This is safe to call from concurrent async contexts because callers
   * serialize through `sequenceChains`—only one caller executes at a time
   * per workflow, so the read-modify-write on the counter is effectively atomic.
   */
  function nextSequence(workflowId: string): number {
    const current = sequenceCounters.get(workflowId);
    if (current === undefined) {
      throw new Error(
        `Sequence counter for workflow "${workflowId}" accessed before initialization`,
      );
    }
    sequenceCounters.set(workflowId, current + 1);
    return current;
  }

  /** Persist an event to storage and publish to WebSocket channels. */
  async function persistAndPublishEvent(
    workflowId: string,
    eventType: string,
    message: string,
  ): Promise<void> {
    await ensureSequenceInitialized(workflowId);

    const parsed = JSON.parse(message) as {
      type: string;
      timestamp: number;
      data: Record<string, unknown>;
    };

    // Claim the sequence number once — outside the retry scope so a
    // failed storage write doesn't consume an additional number.
    const sequence = nextSequence(workflowId);
    const storageKey = KEYS.event(workflowId, sequence);
    const encoded = encode(parsed);

    await withRetry(
      async () => engine.storage.put(storageKey, encoded),
      `persist event "${eventType}" for workflow "${workflowId}"`,
    );

    // Publish to the workflow's watch channel
    const watchChannel = `/v1/workflows/${workflowId}/watch`;
    server.publish(watchChannel, message);

    // For token events, also publish to the stream channel
    if (eventType === TokenEvent.type) {
      const streamChannel = `/v1/workflows/${workflowId}/stream`;
      server.publish(streamChannel, message);
    }
  }

  const eventTypes = [
    WorkflowStartedEvent.type,
    WorkflowCompletedEvent.type,
    WorkflowFailedEvent.type,
    WorkflowCancelledEvent.type,
    WorkflowTimedOutEvent.type,
    ActivityStartedEvent.type,
    ActivityCompletedEvent.type,
    ActivityFailedEvent.type,
    TokenEvent.type,
    SignalReceivedEvent.type,
    SignalDeliveredEvent.type,
    AttributesChangedEvent.type,
    UpdateReceivedEvent.type,
    UpdateCompletedEvent.type,
  ] as const;

  for (const eventType of eventTypes) {
    engine.addEventListener(
      eventType,
      (event) => {
        const raw =
          'workflowId' in event ? (event as Record<string, unknown>)['workflowId'] : undefined;
        const workflowId = typeof raw === 'string' ? raw : undefined;
        if (workflowId === undefined) return;

        const message = serializeEvent(event);
        if (message === null) return;

        // Persist the event to storage for the REST events endpoint.
        // Sequence initialization is async (reads storage on first access per
        // workflow), so chain the persistence behind it. WebSocket publishing
        // is deferred until persistence succeeds so clients never see events
        // that failed to store.
        //
        // Events for the same workflow are serialized through `sequenceChains`
        // to prevent concurrent handlers from racing on `nextSequence`.
        const previousChain = sequenceChains.get(workflowId) ?? Promise.resolve();
        const nextChain = previousChain
          .then(() => persistAndPublishEvent(workflowId, eventType, message))
          .catch((error) => {
            console.error(
              `[weft] Failed to persist event "${eventType}" for workflow "${workflowId}":`,
              error,
            );
          });
        sequenceChains.set(workflowId, nextChain);
      },
      { signal },
    );
  }

  return () => controller.abort();
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

/** Start the Weft HTTP + WebSocket server with embedded dashboard. */
export function serve(options: ServeOptions): WeftServer {
  const port = options.port ?? 7233;
  const hostname = options.hostname ?? '0.0.0.0';
  const development = options.development ?? false;

  // Validate auth config synchronously so misconfigurations fail fast.
  if (options.auth) {
    validateAuthConfig(options.auth);
  }

  // The authenticator is initialized asynchronously (key import) but the
  // promise is created eagerly and resolved before the first request completes.
  const authenticatorPromise: Promise<Authenticator> | null = options.auth
    ? createAuthenticator(options.auth)
    : null;

  const tlsOptions = buildTLSOptions(options.auth);

  // The dashboard HTML is passed in via options or loaded dynamically.
  // When available, Bun's static route handler bundles and serves it
  // with HMR in dev mode and cached assets in production mode.
  const dashboard = options.dashboard ?? null;

  const registry = new WorkerRegistry();
  const taskQueue = new TaskQueue();
  const workerSockets = new Map<string, ServerWebSocket<WebSocketData>>();
  /** Tracks per-workflow worker affinity for sticky routing. Maps workflowId → workerId. */
  const workerAffinity = new Map<string, string>();
  /** Tracks pending backoff-delay timers so they can be cleared on shutdown. */
  const pendingTimers = new Set<ReturnType<typeof setTimeout>>();
  /** In-memory min-heap for inflight task deadlines — avoids full storage scans on each visibility tick. */
  const deadlineTracker = new DeadlineTracker();

  /**
   * Send existing token events from storage as replay messages to a newly
   * connected stream client, so it can catch up on tokens emitted before
   * the connection was established.
   */
  async function replayTokenEvents(
    ws: ServerWebSocket<WebSocketData>,
    workflowId: string,
  ): Promise<void> {
    const prefix = `ev:${workflowId}:`;
    try {
      for await (const [, value] of options.engine.storage.scan(prefix)) {
        const event = decode(value);
        if (event === null || typeof event !== 'object' || !('type' in event) || !('data' in event))
          continue;
        const { type: eventType, data } = event as { type: string; data: Record<string, unknown> };
        if (eventType !== TokenEvent.type) continue;

        ws.send(
          JSON.stringify({
            type: 'replay',
            timestamp: Date.now(),
            data,
          }),
        );
      }
    } catch (error) {
      console.error(`[weft] Failed to replay token events for workflow "${workflowId}":`, error);
    }
  }

  /** Schedule a delayed dispatch, tracking the timer for cleanup on shutdown. */
  function scheduleDelayedDispatch(task: TaskDispatch, delay: number): void {
    const timer = setTimeout(() => {
      pendingTimers.delete(timer);
      void dispatchTaskImpl(task).catch((err) =>
        console.error(`[weft] Delayed redispatch failed for "${task.operationId}":`, err),
      );
    }, delay);
    pendingTimers.add(timer);
  }

  /**
   * Given a persisted inflight record, either permanently fail the task (if
   * retry attempts are exhausted) or transition it back to queued and
   * re-dispatch with backoff. Both the worker-disconnect handler and the
   * visibility-timeout scanner share this logic.
   */
  async function reassignOrExpireTask(operationId: string, record: InflightRecord): Promise<void> {
    const nextAttempt = (record.attempt ?? 1) + 1;
    const policy = record.retryPolicy;

    if (policy && nextAttempt > policy.maxAttempts) {
      await transitionInflightToResolved(options.engine.storage, operationId, 'failed');
      options.engine.dispatchEvent(
        new ActivityFailedEvent(
          record.operationId,
          record.workflowId ?? '',
          record.activityName,
          new Error(
            `Activity "${record.activityName}" exhausted all ${policy.maxAttempts} retry attempts`,
          ),
          record.attempt ?? 1,
        ),
      );
      return;
    }

    const queuedRecord: QueuedRecord = {
      operationId: record.operationId,
      activityName: record.activityName,
      input: record.input,
      queue: record.queue,
      attempt: nextAttempt,
      visibilityTimeout: record.visibilityTimeout,
      retryPolicy: policy,
      queuedAt: Date.now(),
      workflowId: record.workflowId,
    };
    await transitionInflightToQueued(options.engine.storage, operationId, queuedRecord);

    const taskDispatch: TaskDispatch = {
      operationId: record.operationId,
      activityName: record.activityName,
      input: record.input,
      queue: record.queue,
      attempt: nextAttempt,
      visibilityTimeout: record.visibilityTimeout,
      workflowId: record.workflowId,
      ...(policy ? { retryPolicy: policy } : {}),
    };

    if (policy) {
      const delay = calculateBackoff(record.attempt ?? 1, policy);
      scheduleDelayedDispatch(taskDispatch, delay);
    } else {
      void dispatchTaskImpl(taskDispatch).catch((err) =>
        console.error(`[weft] Redispatch failed for "${record.operationId}":`, err),
      );
    }
  }

  const routes: Record<string, unknown> = {};
  if (dashboard !== null) {
    routes['/ui'] = dashboard;
    routes['/ui/*'] = dashboard;
  }

  const server = Bun.serve<WebSocketData>({
    port,
    hostname,
    development,
    routes,
    ...(tlsOptions ? { tls: tlsOptions } : {}),
    async fetch(request) {
      const url = new URL(request.url);

      // Authenticate all requests (HTTP and WebSocket upgrades) when auth is configured.
      if (authenticatorPromise) {
        const authenticator = await authenticatorPromise;
        const authResult = await authenticator(request);
        if (!authResult.authenticated) {
          return new Response(JSON.stringify({ error: authResult.error }), {
            status: 401,
            headers: {
              'Content-Type': 'application/json',
              'WWW-Authenticate': 'Bearer',
            },
          });
        }
      }

      // WebSocket upgrade
      if (request.headers.get('upgrade') === 'websocket') {
        const classification = classifyConnection(url.pathname);
        const upgraded = server.upgrade(request, {
          data: { pathname: url.pathname, ...classification },
        });
        if (upgraded) return undefined;
        return new Response('WebSocket upgrade failed', { status: 400 });
      }

      // Long-poll task endpoints (handled here because they need task queue access)
      if (request.method === 'GET') {
        const pollMatch = TASK_POLL_RE.exec(url.pathname);
        if (pollMatch?.[1]) {
          const queue = decodeURIComponent(pollMatch[1]);
          const activities = url.searchParams.getAll('activity');

          if (activities.length === 0) {
            return Response.json(
              { error: 'At least one "activity" query parameter is required' },
              { status: 400 },
            );
          }

          const rawTimeout = url.searchParams.get('timeout');
          const timeout =
            rawTimeout !== null
              ? Math.min(Math.max(0, Number(rawTimeout)), MAX_POLL_TIMEOUT)
              : DEFAULT_POLL_TIMEOUT;

          const task = await taskQueue.poll(queue, activities, timeout);

          // Transition queued → inflight when a long-poll worker claims a task.
          if (task) {
            const vt = task.visibilityTimeout ?? DEFAULT_VISIBILITY_TIMEOUT;
            const deadline = Date.now() + vt;
            const inflightRecord: InflightRecord = {
              operationId: task.operationId,
              workerId: `longpoll-${crypto.randomUUID().slice(0, 8)}`,
              deadline,
              activityName: task.activityName,
              queue,
              input: task.input,
              attempt: task.attempt ?? 1,
              visibilityTimeout: vt,
              retryPolicy: task.retryPolicy,
            };
            deadlineTracker.add({ operationId: task.operationId, deadline });
            void transitionQueuedToInflight(
              options.engine.storage,
              task.operationId,
              inflightRecord,
            );
          }

          if (task === null) {
            return new Response(null, { status: 204 });
          }

          return Response.json(task);
        }
      }

      if (request.method === 'POST') {
        const completeMatch = TASK_RESULT_RE.exec(url.pathname);
        if (completeMatch?.[1]) {
          let body: Record<string, unknown>;
          try {
            body = (await request.json()) as Record<string, unknown>;
          } catch {
            return Response.json({ error: 'Invalid JSON body' }, { status: 400 });
          }

          const operationId = body['operationId'];
          const status = body['status'];

          if (typeof operationId !== 'string' || typeof status !== 'string') {
            return Response.json(
              { error: 'Missing required fields: operationId, status' },
              { status: 400 },
            );
          }

          if (status !== 'completed' && status !== 'failed') {
            return Response.json(
              { error: 'status must be "completed" or "failed"' },
              { status: 400 },
            );
          }

          taskQueue.complete({
            operationId,
            status,
            value: body['value'],
            error: typeof body['error'] === 'string' ? body['error'] : undefined,
          });

          // Remove from deadline tracker and transition inflight → resolved in durable storage.
          deadlineTracker.remove(operationId);
          const resolvedStatus = status === 'failed' ? 'failed' : ('completed' as const);
          transitionInflightToResolved(options.engine.storage, operationId, resolvedStatus).catch(
            (error) => {
              console.error(
                `[weft] Failed to transition task "${operationId}" to resolved — inflight record may leak:`,
                error,
              );
            },
          );

          return Response.json({ ok: true });
        }
      }

      // API routes via existing platform-agnostic handler
      return handleRequest(request, options.engine);
    },
    websocket: {
      open(ws) {
        const { pathname, connectionType, workflowId } = ws.data;
        if (pathname) {
          ws.subscribe(pathname);
        }

        // For stream connections, replay existing token events from storage
        if (connectionType === 'stream' && workflowId) {
          void replayTokenEvents(ws, workflowId);
        }
      },
      message(ws, rawMessage) {
        if (!isWorkerConnection(ws.data.pathname)) return;

        const text =
          typeof rawMessage === 'string' ? rawMessage : new TextDecoder().decode(rawMessage);

        let parsed: { type: string; [key: string]: unknown };
        try {
          parsed = JSON.parse(text);
        } catch {
          return;
        }

        switch (parsed.type) {
          case 'register': {
            const rawWorkerId = parsed['workerId'];
            const workerId = typeof rawWorkerId === 'string' ? rawWorkerId : '';
            if (!workerId) return;

            const activities = parsed['activities'];
            const concurrency = parsed['concurrency'];

            // Validate and cap concurrency to prevent a misconfigured client
            // from claiming an unbounded number of task slots.
            const rawConcurrency = typeof concurrency === 'number' ? concurrency : 10;
            const clampedConcurrency = Math.min(
              Math.max(1, Math.floor(rawConcurrency)),
              MAX_WORKER_CONCURRENCY,
            );

            ws.data.workerId = workerId;
            registry.register({
              id: workerId,
              queue: ws.data.queue ?? 'default',
              activities: Array.isArray(activities) ? (activities as string[]) : [],
              concurrency: clampedConcurrency,
            });
            workerSockets.set(workerId, ws);
            break;
          }
          case 'taskResult': {
            const operationId = parsed['operationId'];
            const resultStatus = parsed['status'];
            if (typeof operationId === 'string') {
              // Remove in-flight tracking and decrement the worker's counter.
              registry.completeTask(operationId);
              deadlineTracker.remove(operationId);
              // Atomically transition inflight → resolved in storage.
              const resolvedStatus = resultStatus === 'failed' ? 'failed' : ('completed' as const);
              transitionInflightToResolved(
                options.engine.storage,
                operationId,
                resolvedStatus,
              ).catch((error) => {
                console.error(
                  `[weft] Failed to transition task "${operationId}" to resolved — inflight record may leak:`,
                  error,
                );
              });
            } else {
              // Fallback: decrement counter by worker ID when operationId is missing.
              // This path leaks the inflight tracking record — log a warning.
              const workerId = ws.data.workerId;
              if (workerId) {
                console.warn(
                  `[weft] taskResult from worker "${workerId}" is missing operationId — inflight tracking record will leak`,
                );
                registry.taskCompleted(workerId);
              }
            }
            break;
          }
          case 'heartbeat': {
            const workerId = ws.data.workerId;
            if (workerId) {
              registry.heartbeat(workerId);

              // Extend visibility deadline for all in-flight tasks assigned to this worker.
              for (const task of registry.getWorkerTasks(workerId)) {
                const newDeadline = registry.extendVisibility(
                  task.operationId,
                  task.visibilityTimeout,
                );

                // Update persisted storage record and deadline tracker with
                // the same deadline the registry computed, so all three stay
                // in sync across restarts and visibility scans.
                if (newDeadline !== undefined) {
                  deadlineTracker.remove(task.operationId);
                  deadlineTracker.add({ operationId: task.operationId, deadline: newDeadline });

                  const opId = task.operationId;
                  const heartbeatWorkerId = ws.data.workerId;
                  void withRetry(async () => {
                    // Guard: if the task completed or was reassigned during the async gap,
                    // skip the write to avoid resurrecting or corrupting another worker's record.
                    if (!registry.isAssigned(opId)) return;
                    const currentTask = registry
                      .getWorkerTasks(heartbeatWorkerId ?? '')
                      .find((t) => t.operationId === opId);
                    if (!currentTask) return;

                    const inflightKey = KEYS.operationInflight(opId);
                    const existing = await options.engine.storage.get(inflightKey);
                    if (existing) {
                      const record = decode(existing) as Record<string, unknown>;
                      record['deadline'] = newDeadline;
                      await options.engine.storage.put(inflightKey, encode(record));
                    }
                  }, `extend visibility for task "${opId}"`).catch((error) => {
                    console.error(`[weft] Failed to extend visibility for task "${opId}":`, error);
                  });
                }
              }
            }
            break;
          }
        }
      },
      close(ws) {
        const workerId = ws.data.workerId;
        if (workerId) {
          // Fix 2: If the worker already reconnected with a new socket, this close
          // event is for the stale connection — skip cleanup entirely.
          if (workerSockets.get(workerId) !== ws) {
            console.warn(
              `[weft] Ignoring stale socket close for worker "${workerId}" — already reconnected`,
            );
            return;
          }

          // Capture in-flight tasks from the in-memory registry (source of truth)
          // before cleanup so they can be reassigned even if storage hasn't committed yet.
          const inFlightTasks = registry.getWorkerTasks(workerId);

          // Remove in-flight tracking synchronously to allow re-dispatch.
          for (const task of inFlightTasks) {
            registry.completeTask(task.operationId);
            deadlineTracker.remove(task.operationId);
          }

          registry.unregister(workerId);
          workerSockets.delete(workerId);

          // Clean up affinity entries that pointed at this worker.
          for (const [workflowId, affinityWorkerId] of workerAffinity) {
            if (affinityWorkerId === workerId) {
              workerAffinity.delete(workflowId);
            }
          }

          // Requeue each in-flight task with incremented attempt, respecting retry policy.
          // The in-memory registry is the source of truth for *which* tasks to reassign.
          // Full task metadata (activityName, input, etc.) is read from storage.
          for (const task of inFlightTasks) {
            void (async () => {
              try {
                const inflightKey = KEYS.operationInflight(task.operationId);
                const existing = await options.engine.storage.get(inflightKey);

                if (existing) {
                  const record = decode(existing);
                  if (!isInflightRecord(record)) {
                    console.error(
                      `[weft] Corrupt inflight record for task "${task.operationId}" — skipping reassignment`,
                    );
                    return;
                  }
                  await reassignOrExpireTask(task.operationId, record);
                } else {
                  // Storage write hadn't committed — clean up the key just in case.
                  console.warn(
                    `[weft] No inflight record found in storage for task "${task.operationId}" — skipping reassignment`,
                  );
                  await options.engine.storage.delete(inflightKey);
                }
              } catch (error) {
                console.error(
                  `[weft] Failed to reassign task "${task.operationId}" from worker "${workerId}":`,
                  error,
                );
              }
            })();
          }
        }
      },
    },
  });

  // AsyncDisposableStack manages all server resources and disposes them in
  // reverse registration order on shutdown: interval → broadcasting → server.
  const stack = new AsyncDisposableStack();

  // Register the HTTP server first — it is disposed last.
  // Force-close active connections to avoid hanging on drain.
  stack.defer(() => server.stop(true));

  // Wire up engine events → WebSocket broadcasting.
  // If wiring throws after the server is already listening, dispose the
  // stack (which stops the server) before propagating the error.
  let cleanupBroadcasting: () => void;
  try {
    cleanupBroadcasting = wireEventBroadcasting(options.engine, server);
  } catch (error) {
    void stack[Symbol.asyncDispose]();
    throw error;
  }

  // Registered second — disposed second-to-last.
  stack.defer(cleanupBroadcasting);

  // Clean up worker affinity entries when workflows reach a terminal state.
  const affinityController = new AbortController();
  const terminalEventTypes = [
    WorkflowCompletedEvent.type,
    WorkflowFailedEvent.type,
    WorkflowCancelledEvent.type,
    WorkflowTimedOutEvent.type,
  ] as const;

  for (const eventType of terminalEventTypes) {
    options.engine.addEventListener(
      eventType,
      (event) => {
        const raw =
          'workflowId' in event ? (event as Record<string, unknown>)['workflowId'] : undefined;
        const workflowId = typeof raw === 'string' ? raw : undefined;
        if (workflowId) {
          workerAffinity.delete(workflowId);
        }
      },
      { signal: affinityController.signal },
    );
  }
  stack.defer(() => affinityController.abort());

  // Restore persisted in-flight records from storage so visibility timeout
  // tracking survives server restarts. Records whose deadline has already
  // passed are removed from storage (the task will be retried by the engine).
  void withRetry(async () => {
    for await (const [key, value] of options.engine.storage.scan('op:inflight:')) {
      const decoded = decode(value);
      if (!isInflightRecord(decoded)) {
        console.error(`[weft] Corrupt inflight record at "${key}" during restore — skipping`);
        continue;
      }
      const record = decoded;
      const now = Date.now();
      if (record.deadline <= now) {
        // Expired while the server was down — remove from storage.
        void options.engine.storage.delete(key);
      } else {
        // Still within the visibility window — use remaining time so the
        // deadline matches the original persisted value. Then patch the
        // stored visibilityTimeout to the original value so future heartbeat
        // extensions use the full duration, not the diminished remainder.
        const remaining = record.deadline - now;
        registry.assignTask(record.workerId, record.operationId, remaining);
        deadlineTracker.add({ operationId: record.operationId, deadline: record.deadline });
        const tracked = registry
          .getWorkerTasks(record.workerId)
          .find((t) => t.operationId === record.operationId);
        if (tracked) {
          tracked.visibilityTimeout = record.visibilityTimeout ?? DEFAULT_VISIBILITY_TIMEOUT;
        }
      }
    }
  }, 'restore in-flight tasks from storage').catch((error) => {
    console.error('[weft] Failed to restore in-flight tasks from storage:', error);
  });

  // ---------------------------------------------------------------------------
  // Visibility timeout expiry scanner
  // ---------------------------------------------------------------------------

  const visibilityPollMs = options.visibilityPollIntervalMs ?? 5_000;
  let scanRunning = false;

  /**
   * Drain expired entries from the in-memory deadline heap and reassign
   * their tasks. Only touches storage for the specific operations whose
   * deadlines have actually passed — no full `op:inflight:*` scan.
   */
  async function scanExpiredTasks(): Promise<void> {
    if (scanRunning) return;
    scanRunning = true;
    try {
      const now = Date.now();
      const expired = deadlineTracker.drainExpired(now);

      for (const { operationId, deadline } of expired) {
        try {
          const inflightKey = KEYS.operationInflight(operationId);
          const existing = await options.engine.storage.get(inflightKey);

          if (!existing) continue; // Already resolved or requeued by another path.

          const decoded = decode(existing);
          if (!isInflightRecord(decoded)) {
            console.error(`[weft] Corrupt inflight record for task "${operationId}" — skipping`);
            continue;
          }

          // Double-check the deadline in case a heartbeat extended it after
          // the entry was added to the heap.
          if (decoded.deadline > now) {
            deadlineTracker.add({ operationId, deadline: decoded.deadline });
            continue;
          }

          // Expired — remove from registry and reassign or permanently fail.
          registry.completeTask(decoded.operationId);
          await reassignOrExpireTask(decoded.operationId, decoded);
        } catch (error) {
          // Re-add to the heap so it will be retried on the next tick
          // instead of waiting for the slower reconciliation scan.
          deadlineTracker.add({ operationId, deadline });
          console.error(
            `[weft] Failed to process expired task "${operationId}" — will retry:`,
            error,
          );
        }
      }
    } finally {
      scanRunning = false;
    }
  }

  const visibilityPollHandle = setInterval(() => {
    void scanExpiredTasks();
  }, visibilityPollMs);

  // Periodic full-storage reconciliation to catch orphaned inflight records
  // that were never tracked in the heap (e.g., written by another process or
  // left over from a crash). Runs at 12x the visibility poll interval to keep
  // cost low while still providing a safety net.
  let reconciliationRunning = false;

  async function reconcileOrphanedRecords(): Promise<void> {
    if (reconciliationRunning) return;
    reconciliationRunning = true;
    try {
      const now = Date.now();
      for await (const [, value] of options.engine.storage.scan('op:inflight:')) {
        const decoded = decode(value);
        if (!isInflightRecord(decoded)) continue;

        if (decoded.deadline > now) {
          // Still valid — ensure it is tracked in the heap so the fast path
          // can handle it when it expires.
          deadlineTracker.remove(decoded.operationId);
          deadlineTracker.add({ operationId: decoded.operationId, deadline: decoded.deadline });
          continue;
        }

        // Expired orphan — remove from registry and reassign.
        registry.completeTask(decoded.operationId);
        await reassignOrExpireTask(decoded.operationId, decoded);
      }
    } catch (error) {
      console.error('[weft] Reconciliation scanner error:', error);
    } finally {
      reconciliationRunning = false;
    }
  }

  const reconciliationIntervalMs = visibilityPollMs * RECONCILIATION_MULTIPLIER;
  const reconciliationHandle = setInterval(() => {
    void reconcileOrphanedRecords();
  }, reconciliationIntervalMs);

  // Registered last — disposed first (reverse order).
  stack.defer(() => {
    clearInterval(visibilityPollHandle);
    clearInterval(reconciliationHandle);
    deadlineTracker.clear();
    // Clear all pending backoff-delay timers to prevent callbacks firing
    // against a stopped server.
    for (const timer of pendingTimers) {
      clearTimeout(timer);
    }
    pendingTimers.clear();
  });

  async function dispatchTaskImpl(task: TaskDispatch): Promise<boolean> {
    const queue = task.queue ?? 'default';
    const visibilityTimeout = clampVisibilityTimeout(task.visibilityTimeout);

    // Each task assigned to exactly one worker — reject duplicates.
    if (registry.isAssigned(task.operationId) || taskQueue.isTracked(task.operationId)) {
      return false;
    }

    // Resolve sticky preference: look up the last worker for this workflow.
    let stickyWorkerId: string | undefined;
    if (task.sticky && task.workflowId) {
      stickyWorkerId = workerAffinity.get(task.workflowId);
    }

    // Try WebSocket workers first (lowest latency)
    const routingOptions =
      stickyWorkerId !== undefined ? { queue, sticky: stickyWorkerId } : { queue };
    const worker = registry.findWorker(task.activityName, routingOptions);
    if (worker) {
      const ws = workerSockets.get(worker.id);
      if (ws) {
        ws.send(
          JSON.stringify({
            type: 'task',
            operationId: task.operationId,
            activityName: task.activityName,
            input: task.input,
            attempt: task.attempt ?? 1,
          }),
        );
        registry.assignTask(worker.id, task.operationId, visibilityTimeout);

        // Persist in-flight record to storage so it survives server restart.
        // Uses a batch to atomically remove any stale queued record and write the inflight record.
        const deadline = Date.now() + visibilityTimeout;
        deadlineTracker.add({ operationId: task.operationId, deadline });
        const inflightRecord: InflightRecord = {
          operationId: task.operationId,
          workerId: worker.id,
          deadline,
          activityName: task.activityName,
          queue,
          input: task.input,
          attempt: task.attempt ?? 1,
          visibilityTimeout,
          retryPolicy: task.retryPolicy,
          workflowId: task.workflowId,
        };
        await options.engine.storage.batch([
          { type: 'delete', key: KEYS.operationQueued(task.operationId) },
          {
            type: 'put',
            key: KEYS.operationInflight(task.operationId),
            value: encode(inflightRecord),
          },
        ]);

        // Record affinity for future sticky routing (FIFO eviction when over limit).
        if (task.workflowId) {
          workerAffinity.set(task.workflowId, worker.id);
          if (workerAffinity.size > MAX_AFFINITY_ENTRIES) {
            const firstKey = workerAffinity.keys().next().value;
            if (firstKey !== undefined) workerAffinity.delete(firstKey);
          }
        }

        return true;
      }
    }

    // Fall back to long-poll task queue.
    // Persist the durable queued record BEFORE enqueuing to the in-memory queue.
    // enqueue() may resolve a waiting long-poll request immediately, and the
    // GET handler transitions queued→inflight. If markQueued() ran after enqueue(),
    // it could recreate a stale op:queued:* record after the inflight transition.
    const queuedRecord: QueuedRecord = {
      operationId: task.operationId,
      activityName: task.activityName,
      input: task.input,
      queue,
      attempt: task.attempt ?? 1,
      visibilityTimeout,
      retryPolicy: task.retryPolicy,
      queuedAt: Date.now(),
      workflowId: task.workflowId,
    };
    await markQueued(options.engine.storage, queuedRecord);

    // Now enqueue to the in-memory queue. The operationId is tracked immediately,
    // preventing TOCTOU races where a concurrent dispatch could pass the
    // duplicate check during an async gap.
    return taskQueue.enqueue(queue, {
      operationId: task.operationId,
      activityName: task.activityName,
      input: task.input,
      attempt: task.attempt ?? 1,
      retryPolicy: task.retryPolicy,
      visibilityTimeout,
    });
  }

  const resolvedPort = server.port ?? port;
  const resolvedHostname = server.hostname ?? hostname;
  const scheme = tlsOptions ? 'https' : 'http';

  return {
    port: resolvedPort,
    hostname: resolvedHostname,
    url: `${scheme}://${resolvedHostname}:${resolvedPort}`,
    registry,
    taskQueue,
    async stop() {
      await stack[Symbol.asyncDispose]();
    },
    dispatchTask: dispatchTaskImpl,
    [Symbol.asyncDispose]() {
      return stack[Symbol.asyncDispose]();
    },
  };
}
