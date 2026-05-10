import type { ServerWebSocket } from 'bun';

import { decode, encode } from '../../core/codec.ts';
import { KEYS } from '../../storage/interface.ts';
import {
  REMOTE_WORKER_PROTOCOL_VERSION,
  REMOTE_WORKER_SUPPORTED_PROTOCOL_VERSIONS,
  parseWorkerToServerMessage,
  type ProtocolErrorMessage,
  type RegisterErrorMessage,
  type RegisterMessage,
  type TaskResultMessage,
} from '../../worker/protocol.ts';
import type { ServeOptions } from '../index.ts';
import type { WebSocketData } from '../json-rpc-websocket-runtime.ts';
import type { InflightRecord } from '../task-state.ts';
import { transitionInflightToResolved } from '../task-state.ts';
import type { ServerContext } from './context.ts';
import { WORKER_STREAM_RE } from './websocket-upgrade.ts';

const MAX_WORKER_CONCURRENCY = 1_000;
const DEFAULT_WORKER_CONCURRENCY = 10;
const WORKER_PROTOCOL_CLOSE_CODE = 1002;
const WORKER_REGISTRATION_CLOSE_CODE = 1008;

function isWorkerConnection(pathname: string): boolean {
  return WORKER_STREAM_RE.test(pathname);
}

/** Type guard for decoded storage records in the inflight state. */
export function isInflightRecord(value: unknown): value is InflightRecord {
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

export async function withRetry<T>(
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
        await Bun.sleep(100 * attempt);
      }
    }
  }

  throw lastError;
}

function sendWorkerProtocolMessage(
  ws: ServerWebSocket<WebSocketData>,
  message: ProtocolErrorMessage | RegisterErrorMessage | Record<string, unknown>,
): void {
  ws.send(JSON.stringify(message));
}

function closeWorkerSocket(ws: ServerWebSocket<WebSocketData>, code: number, reason: string): void {
  try {
    ws.unsubscribe(ws.data.pathname);
  } catch {
    // The socket may already be detached from the subscription set.
  }
  ws.close(code, reason);
  setTimeout(() => {
    try {
      ws.terminate();
    } catch {
      // The peer may have already completed the close handshake.
    }
  }, 10);
}

function rejectRegistration(
  ws: ServerWebSocket<WebSocketData>,
  code: RegisterErrorMessage['code'],
  message: string,
  requestedProtocolVersion?: number,
): void {
  sendWorkerProtocolMessage(ws, {
    type: 'registerError',
    code,
    message,
    supportedProtocolVersions: REMOTE_WORKER_SUPPORTED_PROTOCOL_VERSIONS,
    ...(requestedProtocolVersion !== undefined ? { requestedProtocolVersion } : {}),
  });
  closeWorkerSocket(ws, WORKER_REGISTRATION_CLOSE_CODE, code);
}

function rejectProtocolMessage(
  ws: ServerWebSocket<WebSocketData>,
  code: ProtocolErrorMessage['code'],
  message: string,
): void {
  sendWorkerProtocolMessage(ws, { type: 'protocolError', code, message });
  closeWorkerSocket(ws, WORKER_PROTOCOL_CLOSE_CODE, code);
}

function registerWorker(
  context: ServerContext,
  ws: ServerWebSocket<WebSocketData>,
  message: RegisterMessage,
): void {
  const rawConcurrency = message.concurrency ?? DEFAULT_WORKER_CONCURRENCY;
  const clampedConcurrency = Math.min(
    Math.max(1, Math.floor(rawConcurrency)),
    MAX_WORKER_CONCURRENCY,
  );
  const queue = ws.data.queue ?? 'default';

  ws.data.workerId = message.workerId;
  ws.data.workerRegistered = true;
  ws.data.workerProtocolVersion = message.protocolVersion;
  context.registry.register({
    id: message.workerId,
    queue,
    activities: [...message.activities],
    concurrency: clampedConcurrency,
  });
  context.workerSockets.set(message.workerId, ws);
  sendWorkerProtocolMessage(ws, {
    type: 'registerAck',
    protocolVersion: REMOTE_WORKER_PROTOCOL_VERSION,
    workerId: message.workerId,
    queue,
    activities: [...message.activities],
    concurrency: clampedConcurrency,
  });
}

function resolveTaskResultStatus(message: TaskResultMessage): 'completed' | 'failed' {
  return message.status === 'completed' ? 'completed' : 'failed';
}

// oxlint-disable-next-line complexity -- ID:server-index-handle-worker-web-socket-message-complexity
export function handleWorkerWebSocketMessage(
  context: ServerContext,
  options: ServeOptions,
  ws: ServerWebSocket<WebSocketData>,
  rawMessage: string | Buffer,
  cleanupWorkflowIndex: (operationId: string) => void,
): void {
  if (!isWorkerConnection(ws.data.pathname)) return;

  const text = typeof rawMessage === 'string' ? rawMessage : new TextDecoder().decode(rawMessage);

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    rejectProtocolMessage(ws, 'invalid_json', 'Worker protocol messages must be valid JSON');
    return;
  }

  const result = parseWorkerToServerMessage(parsed);
  if (!result.ok) {
    if (
      result.error.code === 'invalid_registration' ||
      result.error.code === 'unsupported_protocol_version'
    ) {
      rejectRegistration(
        ws,
        result.error.code,
        result.error.message,
        result.error.requestedProtocolVersion,
      );
      return;
    }

    rejectProtocolMessage(ws, result.error.code, result.error.message);
    return;
  }

  const message = result.message;
  if (message.type !== 'register' && ws.data.workerRegistered !== true) {
    rejectProtocolMessage(
      ws,
      'registration_required',
      'Worker must register before sending heartbeat or taskResult messages',
    );
    return;
  }

  switch (message.type) {
    case 'register': {
      registerWorker(context, ws, message);
      break;
    }
    case 'taskResult': {
      const operationId = message.operationId;
      context.registry.completeTask(operationId);
      context.deadlineTracker.remove(operationId);
      cleanupWorkflowIndex(operationId);

      transitionInflightToResolved(
        options.engine.storage,
        operationId,
        resolveTaskResultStatus(message),
      ).catch((error) => {
        console.error(
          `[weft] Failed to transition task "${operationId}" to resolved — inflight record may leak:`,
          error,
        );
      });
      break;
    }
    case 'heartbeat': {
      const workerId = ws.data.workerId;
      if (workerId) {
        context.registry.heartbeat(workerId);

        // Extend visibility deadline for all in-flight tasks assigned to this worker.
        for (const task of context.registry.getWorkerTasks(workerId)) {
          const newDeadline = context.registry.extendVisibility(
            task.operationId,
            task.visibilityTimeout,
          );

          // Update persisted storage record and deadline tracker with
          // the same deadline the registry computed, so all three stay
          // in sync across restarts and visibility scans.
          if (newDeadline !== undefined) {
            context.deadlineTracker.remove(task.operationId);
            context.deadlineTracker.add({ operationId: task.operationId, deadline: newDeadline });

            const opId = task.operationId;
            const heartbeatWorkerId = ws.data.workerId;
            void withRetry(async () => {
              // Guard: if the task completed or was reassigned during the async gap,
              // skip the write to avoid resurrecting or corrupting another worker's record.
              if (!context.registry.isAssigned(opId)) return;
              const currentTask = context.registry
                .getWorkerTasks(heartbeatWorkerId ?? '')
                .find((trackedTask) => trackedTask.operationId === opId);
              if (!currentTask) return;

              const inflightKey = KEYS.operationInflight(opId);
              const existing = await options.engine.storage.get(inflightKey);
              if (existing) {
                const decoded = decode(existing);
                if (!isInflightRecord(decoded)) {
                  console.error(
                    `[weft] Corrupt inflight record for task "${opId}" during heartbeat — skipping visibility extension`,
                  );
                  return;
                }
                const updated = { ...decoded, deadline: newDeadline };
                await options.engine.storage.put(inflightKey, encode(updated));
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
}
