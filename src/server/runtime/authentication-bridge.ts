import type { ServerWebSocket } from 'bun';

import { decode } from '../../core/codec.ts';
import type { Engine } from '../../core/engine.ts';
import type { MetricsCollector, PrometheusExporter } from '../../observability/metrics.ts';
import { KEYS } from '../../storage/interface.ts';
import type { AuthConfig, AuthContext } from '../authentication.ts';
import { handleRequest } from '../handler.ts';
import { handleJsonRpcHttpRequestSafely } from '../json-rpc-transport-helpers.ts';
import {
  closeJsonRpcWebSocketSession,
  handleJsonRpcWebSocketMessage,
  openJsonRpcWebSocketSession,
  type WebSocketData,
} from '../json-rpc-websocket-runtime.ts';
import type { OpenApiSecuritySchemeName } from '../openapi.ts';
import type { ServerContext } from './context.ts';
import { handleTaskPollRequest, handleTaskResultRequest } from './task-polling.ts';
import { reassignOrExpireTask } from './task-reconciliation.ts';
import { addStreamSocket, removeStreamSocket, replayTokenStream } from './websocket-stream.ts';
import { handleWebSocketUpgrade } from './websocket-upgrade.ts';
import { handleWorkerWebSocketMessage, isInflightRecord } from './websocket-worker.ts';

type ServerFetchOptions = {
  engine: Engine;
  prometheusExporter?: PrometheusExporter;
  metricsCollector?: MetricsCollector;
};

export function deriveSupportedOpenApiSecuritySchemes(
  auth: AuthConfig | undefined,
): ReadonlySet<OpenApiSecuritySchemeName> {
  const schemes = new Set<OpenApiSecuritySchemeName>();
  if (auth?.jwt !== undefined) {
    schemes.add('bearerAuth');
  }
  if ((auth?.apiKeys?.length ?? 0) > 0 || auth?.resolveApiKeyPrincipal !== undefined) {
    schemes.add('apiKeyAuth');
  }
  return schemes;
}

export async function authenticateRequest(
  context: ServerContext,
  request: Request,
): Promise<{
  authContext?: AuthContext;
  response: Response | null;
}> {
  if (!context.authenticatorPromise) {
    return { response: null };
  }

  const authenticator = await context.authenticatorPromise;
  const authResult = await authenticator(request);
  if (authResult.authenticated) {
    if (authResult.method === 'public') {
      return { response: null };
    }

    return {
      authContext: {
        method: authResult.method,
        ...(authResult.claims !== undefined ? { claims: authResult.claims } : {}),
        ...(authResult.principal !== undefined ? { principal: authResult.principal } : {}),
      },
      response: null,
    };
  }

  return {
    response: new Response(JSON.stringify({ error: authResult.error }), {
      status: 401,
      headers: {
        'Content-Type': 'application/json',
        'WWW-Authenticate': 'Bearer',
      },
    }),
  };
}

export async function handleServerFetchRequest(
  server: ReturnType<typeof Bun.serve>,
  context: ServerContext,
  options: ServerFetchOptions,
  request: Request,
): Promise<Response | undefined> {
  const url = new URL(request.url);

  const authentication = await authenticateRequest(context, request);
  if (authentication.response) {
    return authentication.response;
  }

  // `handleWebSocketUpgrade` resolves the principal only for
  // `/jsonrpc` connections and only after the Upgrade-header
  // check. This keeps jwt-without-claims throws out of the HTTP
  // POST `/jsonrpc` path (which has its own try/catch that maps
  // the failure to a -32603 error envelope) and prevents an
  // auth-context failure on unrelated WS endpoints (`/stream`,
  // `/watch`, `/workers`) from returning a spurious 5xx.
  const websocketResponse = handleWebSocketUpgrade(
    server,
    context,
    options,
    request,
    url,
    authentication.authContext,
  );
  if (websocketResponse !== null) {
    return websocketResponse;
  }

  const taskPollResponse = await handleTaskPollRequest(context, options, request, url);
  if (taskPollResponse !== null) {
    return taskPollResponse;
  }

  const taskResultResponse = await handleTaskResultRequest(context, options, request, url);
  if (taskResultResponse !== null) {
    return taskResultResponse;
  }

  // JSON-RPC HTTP endpoint. Claimed here so `handleRequest` doesn't
  // see `/jsonrpc` and return 404 from its REST route table. The
  // adapter enforces method (POST only) and content-type internally.
  //
  // Wrap `authContextToPrincipal` + the adapter call in a try/catch so
  // that an authenticator-contract violation (e.g., `{method: 'jwt',
  // claims: undefined}` reaching the pipeline) maps to a 500 JSON-RPC
  // error envelope instead of escaping as an uncaught exception.
  // `handleRequest`'s REST path already does this via its own inner
  // try/catch; `/jsonrpc` has no such boundary without this wrapping.
  if (url.pathname === '/jsonrpc') {
    return handleJsonRpcHttpRequestSafely({
      request,
      registry: context.liveOperationRegistry,
      engine: options.engine,
      authContext: authentication.authContext,
    });
  }

  // API routes via existing platform-agnostic handler. Under
  // `exactOptionalPropertyTypes` we can't spread `undefined` values into
  // an options object whose fields are `T?: U` (not `T?: U | undefined`),
  // so each optional field is attached only when present.
  return handleRequest(request, options.engine, {
    ...(authentication.authContext !== undefined
      ? { authContext: authentication.authContext }
      : {}),
    ...(options.prometheusExporter !== undefined
      ? { prometheusExporter: options.prometheusExporter }
      : {}),
    ...(options.metricsCollector !== undefined
      ? { metricsCollector: options.metricsCollector }
      : {}),
    operationRegistry: context.liveOperationRegistry,
    restBindings: context.liveRestBindings,
    supportedAuthenticationSchemes: context.supportedAuthenticationSchemes,
  });
}

export function createServerWebSocketHandlers(
  context: ServerContext,
  options: ServerFetchOptions,
  cleanupWorkflowIndex: (operationId: string) => void,
): {
  open: (ws: ServerWebSocket<WebSocketData>) => void;
  message: (ws: ServerWebSocket<WebSocketData>, rawMessage: string | Buffer) => void;
  close: (ws: ServerWebSocket<WebSocketData>) => void;
} {
  return {
    open(ws) {
      const { pathname, connectionType, workflowId } = ws.data;
      // Watch and worker sockets ride Bun pub/sub by pathname. Stream
      // sockets do not: `serve()` wires token delivery through
      // `publishTokenMessage()` and the `streamSockets` registry instead,
      // while `wireEventBroadcasting()` retains the `server.publish()`
      // fallback for direct callers that manage subscriptions themselves.
      if (pathname && connectionType !== 'stream' && connectionType !== 'jsonrpc') {
        ws.subscribe(pathname);
      }

      // Stream sockets track replay state individually so reconnects can
      // catch up from durable storage without duplicate live tokens.
      if (connectionType === 'stream' && workflowId) {
        ws.data.replayInProgress = true;
        ws.data.pendingStreamMessages = [];
        addStreamSocket(context, workflowId, ws);
        void replayTokenStream(context, options.engine, ws, workflowId);
      }

      if (connectionType === 'jsonrpc') {
        openJsonRpcWebSocketSession({
          ws,
          registry: context.liveOperationRegistry,
          engine: options.engine,
          feed: context.workflowEventFeed,
          activeSessions: context.activeJsonRpcSessions,
        });
        return;
      }
    },
    message(ws, rawMessage) {
      // Explicit dispatch on connection type so control flow is
      // visible in the handler (rather than threaded through
      // helper bool returns). `stream`/`watch`/`generic`
      // connections do not receive client → server messages — the
      // stream/watch paths are unidirectional server → client —
      // so there's no branch for them.
      switch (ws.data.connectionType) {
        case 'jsonrpc':
          handleJsonRpcWebSocketMessage(ws, rawMessage);
          return;
        case 'worker':
          handleWorkerWebSocketMessage(context, options, ws, rawMessage, cleanupWorkflowIndex);
          return;
        case 'stream':
        case 'watch':
        case 'generic':
          return;
      }
    },
    close(ws) {
      if (ws.data.connectionType === 'jsonrpc') {
        closeJsonRpcWebSocketSession({
          session: ws.data.jsonRpcSession,
          activeSessions: context.activeJsonRpcSessions,
        });
        return;
      }

      if (ws.data.connectionType === 'stream') {
        removeStreamSocket(context, ws);
      }

      const workerId = ws.data.workerId;
      if (workerId) {
        // Fix 2: If the worker already reconnected with a new socket, this close
        // event is for the stale connection — skip cleanup entirely.
        if (context.workerSockets.get(workerId) !== ws) {
          console.warn(
            `[weft] Ignoring stale socket close for worker "${workerId}" — already reconnected`,
          );
          return;
        }

        // Capture in-flight tasks from the in-memory registry (source of truth)
        // before cleanup so they can be reassigned even if storage hasn't committed yet.
        const inFlightTasks = context.registry.getWorkerTasks(workerId);

        // Remove in-flight tracking synchronously to allow re-dispatch.
        for (const task of inFlightTasks) {
          context.registry.completeTask(task.operationId);
          context.deadlineTracker.remove(task.operationId);
        }

        context.registry.unregister(workerId);
        context.workerSockets.delete(workerId);

        // Clean up affinity entries that pointed at this worker.
        for (const [workflowId, affinityWorkerId] of context.workerAffinity) {
          if (affinityWorkerId === workerId) {
            context.workerAffinity.delete(workflowId);
          }
        }

        // Clean up workflow→operations reverse index for tasks owned by this worker.
        for (const task of inFlightTasks) {
          cleanupWorkflowIndex(task.operationId);
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
                await reassignOrExpireTask(context, options, task.operationId, record);
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
  };
}
