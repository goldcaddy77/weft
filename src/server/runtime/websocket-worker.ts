import type { ServerWebSocket } from 'bun';

import { decode, encode } from '../../core/codec.ts';
import { KEYS } from '../../storage/interface.ts';
import type { ServeOptions } from '../index.ts';
import type { WebSocketData } from '../json-rpc-websocket-runtime.ts';
import type { InflightRecord } from '../task-state.ts';
import { transitionInflightToResolved } from '../task-state.ts';
import type { ServerContext } from './context.ts';
import { WORKER_STREAM_RE } from './websocket-upgrade.ts';

const MAX_WORKER_CONCURRENCY = 1_000;

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
      context.registry.register({
        id: workerId,
        queue: ws.data.queue ?? 'default',
        activities: Array.isArray(activities) ? (activities as string[]) : [],
        concurrency: clampedConcurrency,
      });
      context.workerSockets.set(workerId, ws);
      break;
    }
    case 'taskResult': {
      const operationId = parsed['operationId'];
      const resultStatus = parsed['status'];
      if (typeof operationId === 'string') {
        // Remove in-flight tracking and decrement the worker's counter.
        context.registry.completeTask(operationId);
        context.deadlineTracker.remove(operationId);
        cleanupWorkflowIndex(operationId);

        // Atomically transition inflight → resolved in storage.
        let resolvedStatus: 'completed' | 'failed';
        if (resultStatus === 'completed') {
          resolvedStatus = 'completed';
        } else if (resultStatus === 'failed' || resultStatus === 'cancelled') {
          resolvedStatus = 'failed';
        } else {
          console.warn(
            `[weft] taskResult for operation "${operationId}" has unexpected status "${String(
              resultStatus,
            )}" — treating as failed`,
          );
          resolvedStatus = 'failed';
        }
        transitionInflightToResolved(options.engine.storage, operationId, resolvedStatus).catch(
          (error) => {
            console.error(
              `[weft] Failed to transition task "${operationId}" to resolved — inflight record may leak:`,
              error,
            );
          },
        );
      } else {
        // Fallback: decrement counter by worker ID when operationId is missing.
        // This path leaks the inflight tracking record — log a warning.
        const workerId = ws.data.workerId;
        if (workerId) {
          console.warn(
            `[weft] taskResult from worker "${workerId}" is missing operationId — inflight tracking record will leak`,
          );
          context.registry.taskCompleted(workerId);
        }
      }
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
