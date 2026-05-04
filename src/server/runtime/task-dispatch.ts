import { encode } from '../../core/codec.ts';
import { KEYS } from '../../storage/interface.ts';
import type { RoutingOptions } from '../../worker/registry.ts';
import type { ServeOptions, TaskDispatch } from '../index.ts';
import { evictOldestAffinityEntries } from '../runtime-helpers.ts';
import type { InflightRecord, QueuedRecord } from '../task-state.ts';
import { markQueued } from '../task-state.ts';
import type { ServerContext } from './context.ts';

const MAX_AFFINITY_ENTRIES = 10_000;
const DEFAULT_VISIBILITY_TIMEOUT = 30_000;
const MIN_VISIBILITY_TIMEOUT = 10;
const MAX_VISIBILITY_TIMEOUT = 3_600_000;

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

/** Schedule a delayed dispatch, tracking the timer for cleanup on shutdown. */
export function scheduleDelayedDispatch(
  context: ServerContext,
  options: ServeOptions,
  task: TaskDispatch,
  delay: number,
): void {
  const timer = setTimeout(() => {
    context.pendingTimers.delete(timer);
    void dispatchTaskImpl(context, options, task).catch((err) =>
      console.error(`[weft] Delayed redispatch failed for "${task.operationId}":`, err),
    );
  }, delay);
  context.pendingTimers.add(timer);
}

export function resolveTaskPriority(
  _context: ServerContext,
  options: ServeOptions,
  task: TaskDispatch,
): number | undefined {
  if (task.priority !== undefined) return task.priority;
  if (task.workflowId && options.engine.isAgentWorkflow(task.workflowId)) return 10;
  return undefined;
}

// oxlint-disable-next-line complexity -- ID:server-index-dispatch-task-impl-complexity
export async function dispatchTaskImpl(
  context: ServerContext,
  options: ServeOptions,
  task: TaskDispatch,
): Promise<boolean> {
  const queue = task.queue ?? 'default';
  const visibilityTimeout = clampVisibilityTimeout(task.visibilityTimeout);
  const resolvedPriority = resolveTaskPriority(context, options, task);

  // Each task assigned to exactly one worker — reject duplicates.
  if (
    context.registry.isAssigned(task.operationId) ||
    context.taskQueue.isTracked(task.operationId)
  ) {
    return false;
  }

  // Resolve sticky preference: look up the last worker for this workflow.
  let stickyWorkerId: string | undefined;
  if (task.sticky && task.workflowId) {
    stickyWorkerId = context.workerAffinity.get(task.workflowId);
  }

  // Try WebSocket workers first (lowest latency). Build routing options
  // with `exactOptionalPropertyTypes` in mind — only attach optional fields
  // when they are actually defined.
  const routingOptions: RoutingOptions = { queue };
  if (stickyWorkerId !== undefined) {
    routingOptions.sticky = stickyWorkerId;
  }
  if (task.fairShareKey !== undefined) {
    routingOptions.fairShareKey = task.fairShareKey;
  }
  const worker = context.registry.findWorker(task.activityName, routingOptions);
  if (worker) {
    const ws = context.workerSockets.get(worker.id);
    if (ws) {
      ws.send(
        JSON.stringify({
          type: 'task',
          operationId: task.operationId,
          activityName: task.activityName,
          input: task.input,
          attempt: task.attempt ?? 1,
          ...(task.headers ? { headers: task.headers } : {}),
        }),
      );
      context.registry.assignTask(
        worker.id,
        task.operationId,
        visibilityTimeout,
        task.fairShareKey,
      );

      // Persist in-flight record to storage so it survives server restart.
      // Uses a batch to atomically remove any stale queued record and write the inflight record.
      const deadline = Date.now() + visibilityTimeout;
      context.deadlineTracker.add({ operationId: task.operationId, deadline });
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
        context.workerAffinity.set(task.workflowId, worker.id);
        evictOldestAffinityEntries(context.workerAffinity, MAX_AFFINITY_ENTRIES);

        // Track operation in the workflow→operations reverse index for cancel propagation.
        let operationIds = context.workflowOperations.get(task.workflowId);
        if (!operationIds) {
          operationIds = new Set();
          context.workflowOperations.set(task.workflowId, operationIds);
        }
        operationIds.add(task.operationId);
        context.operationToWorkflow.set(task.operationId, task.workflowId);
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
  return context.taskQueue.enqueue(queue, {
    operationId: task.operationId,
    activityName: task.activityName,
    input: task.input,
    attempt: task.attempt ?? 1,
    retryPolicy: task.retryPolicy,
    visibilityTimeout,
    ...(task.headers ? { headers: task.headers } : {}),
    ...(resolvedPriority !== undefined ? { priority: resolvedPriority } : {}),
  });
}

/** Send a cancel message to the worker handling a specific operation. */
export function cancelTask(context: ServerContext, operationId: string): boolean {
  // O(1) lookup via the registry's in-flight task map.
  const task = context.registry.getTask(operationId);
  if (!task) return false;

  const ws = context.workerSockets.get(task.workerId);
  if (!ws) return false;

  ws.send(JSON.stringify({ type: 'cancel', operationId }));
  return true;
}
