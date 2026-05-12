/**
 * Bun.serve() wrapper with WebSocket support, dashboard UI, and clean shutdown.
 *
 * @module server
 */

import { decode } from '../core/codec.ts';
import type { Engine } from '../core/engine.ts';
import type { RetryPolicy } from '../core/types.ts';
import { createMcpSessionManager } from '../mcp/session.ts';
import type { MetricsCollector, PrometheusExporter } from '../observability/metrics.ts';
import type { RoutingPolicy } from '../worker/registry.ts';
import { WorkerRegistry } from '../worker/registry.ts';
import type { AuthConfig } from './authentication.ts';
import { buildTLSOptions, createAuthenticator, validateAuthConfig } from './authentication.ts';
import { DeadlineTracker } from './deadline-tracker.ts';
import type { DiscoveryInfo } from './discovery-info.ts';
import { createEngineEventFeedBackend } from './engine-event-feed-backend.ts';
import {
  closeJsonRpcSessionsForShutdown,
  type WebSocketData,
} from './json-rpc-websocket-runtime.ts';
import { createLiveOperationRegistry, createLiveRestBindings } from './rest-bindings.ts';
import {
  createServerWebSocketHandlers,
  deriveSupportedOpenApiSecuritySchemes,
  handleServerFetchRequest,
} from './runtime/authentication-bridge.ts';
import type { ServerContext } from './runtime/context.ts';
import {
  registerWorkflowEventLifecycle,
  wireEventBroadcasting,
  type EventBroadcastingHandle,
} from './runtime/event-broadcasting.ts';
import {
  shutdownAllWorkers as shutdownAllWorkersImpl,
  shutdownWorker as shutdownWorkerImpl,
} from './runtime/shutdown.ts';
import { stopBunServerForShutdown } from './runtime/stop-server.ts';
import { cancelTask, dispatchTaskImpl } from './runtime/task-dispatch.ts';
import { reconcileOrphanedRecords, scanExpiredTasks } from './runtime/task-reconciliation.ts';
import { publishTokenMessage } from './runtime/websocket-stream.ts';
import { isInflightRecord, withRetry } from './runtime/websocket-worker.ts';
import { TaskQueue, type SchedulingPolicy } from './task-queue.ts';
import { createWorkflowEventFeed } from './workflow-event-feed.ts';

export {
  wireEventBroadcasting,
  type EventBroadcastingHandle,
} from './runtime/event-broadcasting.ts';

/**
 * Configuration object for the `serve()` function.
 *
 * At minimum supply an `engine` and optionally a `port`.  Authentication,
 * routing policy, metrics, and worker-dispatch settings are all optional — the
 * server runs with sensible defaults when omitted.
 *
 * @example
 * ```ts
 * import { serve, type ServeOptions } from 'weft/server';
 * import { Engine, MemoryStorage } from 'weft';
 *
 * await using storage = new MemoryStorage();
 * await using engine = new Engine({ storage });
 *
 * const options: ServeOptions = {
 *   engine,
 *   port: 3000,
 *   auth: { apiKeys: ['secret'] },
 * };
 * await using server = serve(options);
 * console.log(server.url); // http://localhost:3000
 * ```
 */
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
  /**
   * Routing policy used by the {@link WorkerRegistry} when dispatching tasks.
   * Defaults to `'least-loaded'`. Set to `'round-robin'` for deterministic
   * rotation across workers.
   *
   * **Note on `'fair-share'`:** fair-share requires a `fairShareKey` to be
   * passed at dispatch time via {@link TaskDispatch.fairShareKey}. `serve()`
   * does not currently derive that key from `ctx.tenant` automatically — call
   * sites must thread it through each `dispatchTask()` call themselves. When
   * the key is omitted on a dispatch, the registry degrades gracefully to
   * least-loaded for that single call.
   */
  routingPolicy?: RoutingPolicy;
  /**
   * Scheduling policy used by the {@link TaskQueue} when ordering pending tasks
   * within a queue. Defaults to `'priority'`.
   */
  schedulingPolicy?: SchedulingPolicy;
  /**
   * Optional {@link PrometheusExporter} that produces the body of `/v1/metrics`.
   * Recommended for projects that source metrics from the OpenTelemetry SDK —
   * e.g. wrap `@opentelemetry/exporter-prometheus` to satisfy the interface.
   * When set, it takes precedence over {@link ServeOptions.metricsCollector}.
   */
  prometheusExporter?: PrometheusExporter;
  /**
   * Optional {@link MetricsCollector} used as the default metrics source for
   * `/v1/metrics` when no `prometheusExporter` is supplied.
   *
   * @deprecated Prefer `prometheusExporter` — wrap your metrics source (OpenTelemetry
   * or otherwise) in a {@link PrometheusExporter} and pass it there. This
   * field remains for projects still using the legacy `MetricsCollector`
   * path and has lower precedence if both are set.
   */
  metricsCollector?: MetricsCollector;
  /**
   * Optional metadata applied uniformly to all three discovery documents
   * (`/openapi.json`, `/openrpc.json`, `/asyncapi.json`). When set, the
   * description, contact, license, and externalDocs fields appear in every
   * discovery surface from one source — ensuring zero drift across the
   * three documents.
   */
  discoveryInfo?: DiscoveryInfo;
  /**
   * Explicit public origin used by `/.well-known/api-catalog` (e.g.
   * `https://api.example.com`). Recommended in production. Either this
   * or `trustedHosts` MUST be set or the catalog route returns 503.
   */
  publicOrigin?: string;
  /**
   * Allowlist of `Host` values trusted to source absolute URLs in
   * `/.well-known/api-catalog`. Required (with `publicOrigin` as the
   * alternative) in production — Bun.serve() resolves `request.url`
   * from the incoming Host header so attackers can otherwise poison
   * the discovery URLs.
   */
  trustedHosts?: ReadonlyArray<string>;
}

/**
 * Descriptor for a task dispatched to a remote worker via
 * {@link WeftServer.dispatchTask}.
 *
 * `operationId` and `activityName` are required; all other fields refine
 * routing, retry behaviour, and priority.  Set `sticky: true` together with
 * `workflowId` to route the task to the worker that last handled tasks for
 * that workflow.
 *
 * @example
 * ```ts
 * import { type TaskDispatch } from 'weft/server';
 *
 * const task: TaskDispatch = {
 *   operationId: crypto.randomUUID(),
 *   activityName: 'sendEmail',
 *   input: { to: 'user@example.com', subject: 'Hello' },
 *   queue: 'email',
 *   retryPolicy: { maxAttempts: 3, initialBackoff: '1s', backoffMultiplier: 2, maxBackoff: '30s' },
 * };
 * void task;
 * ```
 */
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
  /** Propagated interceptor headers (e.g. W3C trace context, auth tokens). */
  headers?: Record<string, string>;
  /** Task priority. Higher values are dequeued first. Agent tasks default to 10. */
  priority?: number;
  /**
   * Partition key for `'fair-share'` routing — typically a tenant or customer
   * id. Ignored by other policies. When omitted under `'fair-share'`, the
   * registry degrades gracefully to `'least-loaded'` for that dispatch.
   */
  fairShareKey?: string;
}

/**
 * Handle returned by `serve()` that exposes the running server's address,
 * worker registry, task dispatch, and shutdown controls.
 *
 * Implements `AsyncDisposable` — `serve()` itself is synchronous, but the
 * returned handle is awaitable for cleanup. Use `await using server = serve(...)`
 * in TypeScript 5.2+ to have the server stop automatically when the enclosing
 * block exits.
 *
 * **Type availability note:** `registry` is typed as `WorkerRegistry`, which
 * is exported from `'weft'` but not from `'weft/server'`. `taskQueue` is typed
 * as `TaskQueue`, which is an internal type not re-exported from any public
 * entry point. Prefer using `WeftServer` methods (`dispatchTask`,
 * `shutdownWorker`, etc.) rather than reaching into `taskQueue` directly.
 *
 * @example
 * ```ts
 * import { serve, type WeftServer } from 'weft/server';
 * import { Engine, MemoryStorage } from 'weft';
 *
 * await using storage = new MemoryStorage();
 * await using engine = new Engine({ storage });
 * await using server: WeftServer = serve({ engine, port: 4000 });
 *
 * console.log(server.url);            // http://localhost:4000
 * console.log(server.registry);       // WorkerRegistry instance
 * await server.stop();
 * ```
 */
export interface WeftServer extends AsyncDisposable {
  readonly port: number;
  readonly hostname: string;
  readonly url: string;
  readonly registry: WorkerRegistry;
  readonly taskQueue: TaskQueue;
  stop(): Promise<void>;
  /** Dispatch a task to the best available worker. Returns true if dispatched. */
  dispatchTask(task: TaskDispatch): Promise<boolean>;
  /** Send a shutdown message to a specific worker and wait for it to disconnect. Returns true if the worker was found. */
  shutdownWorker(workerId: string, options?: { timeoutMs?: number }): Promise<boolean>;
  /** Send a shutdown message to all connected workers and wait for them to disconnect. */
  shutdownAllWorkers(options?: { timeoutMs?: number }): Promise<void>;
  /** Send a cancel message for a specific operation to the worker handling it. Returns true if the worker was found. */
  cancelTask(operationId: string): boolean;
}

// ---------------------------------------------------------------------------
// Worker stream helpers
// ---------------------------------------------------------------------------

/** Reconciliation full-scan runs at this multiple of the visibility poll interval (~60s at default). */
const RECONCILIATION_MULTIPLIER = 12;

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

/**
 * Start the Weft HTTP + WebSocket server with embedded dashboard.
 *
 * `serve()` validates the supplied `auth` configuration synchronously and
 * throws `Error` before binding the port if any auth setting is invalid.
 * In-flight task records from previous server runs are restored from storage
 * on startup so no tasks are silently lost across restarts.
 *
 * The returned `WeftServer.taskQueue` field is intentionally opaque — prefer
 * `WeftServer` methods (`dispatchTask`, `shutdownWorker`, etc.) over reaching
 * into it directly.
 *
 * @example
 * ```ts
 * import { Engine, MemoryStorage } from 'weft';
 * import { serve } from 'weft/server';
 *
 * await using engine = new Engine({ storage: new MemoryStorage() });
 * engine.register('greet', async function* (ctx: import('weft').WorkflowContext, input: { name: string }) {
 *   return `Hello, ${input.name}!`;
 * });
 *
 * await using server = serve({ engine, port: 7233 });
 * console.log(`Weft listening on ${server.url}`);
 * ```
 */
// oxlint-disable-next-line complexity -- ID:server-index-serve-complexity
export function serve(options: ServeOptions): WeftServer {
  const port = options.port ?? 7233;
  const hostname = options.hostname ?? '0.0.0.0';
  const development = options.development ?? false;

  // Validate auth config synchronously so misconfigurations fail fast.
  if (options.auth) {
    validateAuthConfig(options.auth);
  }

  const tlsOptions = buildTLSOptions(options.auth);

  // The dashboard HTML is passed in via options or loaded dynamically.
  // When available, Bun's static route handler bundles and serves it
  // with HMR in dev mode and cached assets in production mode.
  const dashboard = options.dashboard ?? null;

  const eventFeedBackend = createEngineEventFeedBackend(options.engine);
  const context: ServerContext = {
    registry: new WorkerRegistry(
      options.routingPolicy !== undefined ? { policy: options.routingPolicy } : undefined,
    ),
    taskQueue: new TaskQueue(
      options.schedulingPolicy !== undefined
        ? { schedulingPolicy: options.schedulingPolicy }
        : undefined,
    ),
    workerSockets: new Map(),
    streamSockets: new Map(),
    workerAffinity: new Map(),
    workflowOperations: new Map(),
    operationToWorkflow: new Map(),
    pendingTimers: new Set(),
    deadlineTracker: new DeadlineTracker(),
    liveOperationRegistry: createLiveOperationRegistry(
      options.metricsCollector !== undefined ? { metricsCollector: options.metricsCollector } : {},
    ),
    liveRestBindings: createLiveRestBindings(),
    supportedAuthenticationSchemes: deriveSupportedOpenApiSecuritySchemes(options.auth),
    eventFeedBackend,
    workflowEventFeed: createWorkflowEventFeed(eventFeedBackend),
    activeJsonRpcSessions: new Set(),
    mcpSessionManager: createMcpSessionManager(options.engine),
    // The authenticator is initialized asynchronously (key import) but the
    // promise is created eagerly and resolved before the first request completes.
    authenticatorPromise: options.auth ? createAuthenticator(options.auth) : null,
    visibilityPollMs: options.visibilityPollIntervalMs ?? 5_000,
    scanRunning: false,
    processingOperations: new Set(),
    reconciliationRunning: false,
  };

  /** Remove an operationId from the workflow→operations reverse index. */
  function cleanupWorkflowIndex(operationId: string): void {
    const workflowId = context.operationToWorkflow.get(operationId);
    if (workflowId) {
      const opIds = context.workflowOperations.get(workflowId);
      if (opIds) {
        opIds.delete(operationId);
        if (opIds.size === 0) context.workflowOperations.delete(workflowId);
      }
      context.operationToWorkflow.delete(operationId);
    }
  }

  const routes: Record<string, unknown> = {};
  if (dashboard !== null) {
    routes['/ui'] = dashboard;
    routes['/ui/*'] = dashboard;
  }

  let server: ReturnType<typeof Bun.serve>;
  server = Bun.serve<WebSocketData>({
    port,
    hostname,
    development,
    routes,
    ...(tlsOptions ? { tls: tlsOptions } : {}),
    fetch: (request): Promise<Response | undefined> =>
      handleServerFetchRequest(server, context, options, request),
    websocket: createServerWebSocketHandlers(context, options, cleanupWorkflowIndex),
  });

  // AsyncDisposableStack manages all server resources and disposes them in
  // reverse registration order on shutdown: interval → broadcasting → server.
  const stack = new AsyncDisposableStack();

  // Register the HTTP server first — it is disposed last.
  // Force-close active connections to avoid hanging on drain.
  stack.defer(() => stopBunServerForShutdown(server));

  // Wire up engine events → WebSocket broadcasting.
  // If wiring throws after the server is already listening, dispose the
  // stack (which stops the server) before propagating the error.
  let broadcastingHandle: EventBroadcastingHandle;
  try {
    broadcastingHandle = wireEventBroadcasting(options.engine, server, {
      publishTokenMessage: (workflowId, sequence, message) => {
        publishTokenMessage(context, workflowId, sequence, message);
      },
    });
  } catch (error) {
    void stack[Symbol.asyncDispose]();
    throw error;
  }

  // Registered second — disposed second-to-last.
  stack.defer(broadcastingHandle.dispose);
  stack.defer(() => context.workflowEventFeed.dispose());
  // Registered last — disposed FIRST. Close every active
  // `/jsonrpc` WS session and wait for its subscription pumps to
  // drain before the shared `WorkflowEventFeed` disposes or the
  // server force-closes sockets. Without this, `server.stop(true)`
  // would tear down sockets mid-pump, which produces noisy
  // post-dispose callbacks on the engine's listener registry.
  stack.defer(async () => {
    await closeJsonRpcSessionsForShutdown(context.activeJsonRpcSessions);
  });
  stack.defer(() => context.mcpSessionManager[Symbol.asyncDispose]());

  stack.defer(registerWorkflowEventLifecycle(options.engine, context, broadcastingHandle));

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
        context.registry.assignTask(record.workerId, record.operationId, remaining);
        context.deadlineTracker.add({ operationId: record.operationId, deadline: record.deadline });
        const tracked = context.registry
          .getWorkerTasks(record.workerId)
          .find((t) => t.operationId === record.operationId);
        if (tracked) {
          tracked.visibilityTimeout = record.visibilityTimeout;
        }

        // Rebuild workflow→operations reverse index so WorkflowCancelledEvent
        // can propagate cancels to tasks restored from storage after a restart.
        if (record.workflowId) {
          let opIds = context.workflowOperations.get(record.workflowId);
          if (!opIds) {
            opIds = new Set();
            context.workflowOperations.set(record.workflowId, opIds);
          }
          opIds.add(record.operationId);
          context.operationToWorkflow.set(record.operationId, record.workflowId);
        }
      }
    }
  }, 'restore in-flight tasks from storage').catch((error) => {
    console.error('[weft] Failed to restore in-flight tasks from storage:', error);
  });

  const visibilityPollHandle = setInterval(() => {
    void scanExpiredTasks(context, options, cleanupWorkflowIndex);
  }, context.visibilityPollMs);

  // Periodic full-storage reconciliation to catch orphaned inflight records
  // that were never tracked in the heap (e.g., written by another process or
  // left over from a crash). Runs at 12x the visibility poll interval to keep
  // cost low while still providing a safety net.
  const reconciliationIntervalMs = context.visibilityPollMs * RECONCILIATION_MULTIPLIER;
  const reconciliationHandle = setInterval(() => {
    void reconcileOrphanedRecords(context, options, cleanupWorkflowIndex);
  }, reconciliationIntervalMs);

  // Registered last — disposed first (reverse order).
  stack.defer(() => {
    clearInterval(visibilityPollHandle);
    clearInterval(reconciliationHandle);
    context.deadlineTracker.clear();
    // Clear all pending backoff-delay timers to prevent callbacks firing
    // against a stopped server.
    for (const timer of context.pendingTimers) {
      clearTimeout(timer);
    }
    context.pendingTimers.clear();
  });

  const resolvedPort = server.port ?? port;
  const resolvedHostname = server.hostname ?? hostname;
  const scheme = tlsOptions ? 'https' : 'http';

  return {
    port: resolvedPort,
    hostname: resolvedHostname,
    url: `${scheme}://${resolvedHostname}:${resolvedPort}`,
    registry: context.registry,
    taskQueue: context.taskQueue,
    async stop() {
      await stack[Symbol.asyncDispose]();
    },
    dispatchTask: (task) => dispatchTaskImpl(context, options, task),
    shutdownWorker: (workerId, shutdownOptions) =>
      shutdownWorkerImpl(context, workerId, shutdownOptions),
    shutdownAllWorkers: (shutdownOptions) => shutdownAllWorkersImpl(context, shutdownOptions),
    cancelTask: (operationId) => cancelTask(context, operationId),
    [Symbol.asyncDispose]() {
      return stack[Symbol.asyncDispose]();
    },
  };
}
