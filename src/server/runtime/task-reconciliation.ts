import { decode } from '../../core/codec.ts';
import { ActivityFailedEvent } from '../../core/events.ts';
import { calculateBackoff } from '../../core/scheduler.ts';
import { KEYS } from '../../storage/interface.ts';
import type { ServeOptions, TaskDispatch } from '../index.ts';
import { restoreExtendedDeadlineIfStillActive } from '../runtime-helpers.ts';
import type { InflightRecord, QueuedRecord } from '../task-state.ts';
import { transitionInflightToQueued, transitionInflightToResolved } from '../task-state.ts';
import type { ServerContext } from './context.ts';
import { dispatchTaskImpl, scheduleDelayedDispatch } from './task-dispatch.ts';
import { isInflightRecord } from './websocket-worker.ts';

/**
 * Given a persisted inflight record, either permanently fail the task (if
 * retry attempts are exhausted) or transition it back to queued and
 * re-dispatch with backoff. Both the worker-disconnect handler and the
 * visibility-timeout scanner share this logic.
 */
export async function reassignOrExpireTask(
  context: ServerContext,
  options: ServeOptions,
  operationId: string,
  record: InflightRecord,
): Promise<void> {
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
    scheduleDelayedDispatch(context, options, taskDispatch, delay);
  } else {
    void dispatchTaskImpl(context, options, taskDispatch).catch((err) =>
      console.error(`[weft] Redispatch failed for "${record.operationId}":`, err),
    );
  }
}

/**
 * Drain expired entries from the in-memory deadline heap and reassign
 * their tasks. Only touches storage for the specific operations whose
 * deadlines have actually passed — no full `op:inflight:*` scan.
 */
export async function scanExpiredTasks(
  context: ServerContext,
  options: ServeOptions,
  cleanupWorkflowIndex: (operationId: string) => void,
): Promise<void> {
  if (context.scanRunning) return;
  context.scanRunning = true;
  try {
    const now = Date.now();
    const expired = context.deadlineTracker.drainExpired(now);

    for (const { operationId, deadline } of expired) {
      // Skip if the reconciliation scanner (or a previous iteration) is
      // already acting on this operation — re-queue the heap entry so the
      // fast path will revisit it on the next tick once the other worker
      // has released the claim.
      if (context.processingOperations.has(operationId)) {
        context.deadlineTracker.add({ operationId, deadline });
        continue;
      }
      context.processingOperations.add(operationId);
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
        if (
          restoreExtendedDeadlineIfStillActive(
            context.deadlineTracker,
            operationId,
            decoded.deadline,
            now,
          )
        ) {
          continue;
        }

        // Expired — remove from registry, clean up workflow index, and reassign or permanently fail.
        context.registry.completeTask(decoded.operationId);
        cleanupWorkflowIndex(decoded.operationId);
        await reassignOrExpireTask(context, options, decoded.operationId, decoded);
      } catch (error) {
        // Re-add to the heap so it will be retried on the next tick
        // instead of waiting for the slower reconciliation scan.
        context.deadlineTracker.add({ operationId, deadline });
        console.error(
          `[weft] Failed to process expired task "${operationId}" — will retry:`,
          error,
        );
      } finally {
        context.processingOperations.delete(operationId);
      }
    }
  } catch (error) {
    console.error('[weft] Visibility timeout scanner error:', error);
  } finally {
    context.scanRunning = false;
  }
}

export async function reconcileOrphanedRecords(
  context: ServerContext,
  options: ServeOptions,
  cleanupWorkflowIndex: (operationId: string) => void,
): Promise<void> {
  if (context.reconciliationRunning) return;
  context.reconciliationRunning = true;
  try {
    const now = Date.now();
    for await (const [, value] of options.engine.storage.scan('op:inflight:')) {
      try {
        const decoded = decode(value);
        if (!isInflightRecord(decoded)) continue;

        if (decoded.deadline > now) {
          // Still valid — ensure it is tracked in the heap so the fast path
          // can handle it when it expires. Skip the heap rewrite if another
          // path is currently mid-process on this id — its `finally` block
          // will leave the heap in a consistent state.
          if (context.processingOperations.has(decoded.operationId)) continue;
          context.deadlineTracker.remove(decoded.operationId);
          context.deadlineTracker.add({
            operationId: decoded.operationId,
            deadline: decoded.deadline,
          });
          continue;
        }

        // Expired orphan — claim the id so `scanExpiredTasks` cannot race
        // us on `completeTask`/`reassignOrExpireTask`. If the fast path is
        // already processing it, skip and let the next reconciliation tick
        // revisit any remaining orphans.
        if (context.processingOperations.has(decoded.operationId)) continue;
        context.processingOperations.add(decoded.operationId);
        try {
          // Expired orphan — remove from heap, registry, and workflow index, then reassign.
          context.deadlineTracker.remove(decoded.operationId);
          context.registry.completeTask(decoded.operationId);
          cleanupWorkflowIndex(decoded.operationId);
          await reassignOrExpireTask(context, options, decoded.operationId, decoded);
        } finally {
          context.processingOperations.delete(decoded.operationId);
        }
      } catch (error) {
        console.error('[weft] Failed to reconcile inflight record — skipping:', error);
      }
    }
  } catch (error) {
    console.error('[weft] Reconciliation scanner error:', error);
  } finally {
    context.reconciliationRunning = false;
  }
}
