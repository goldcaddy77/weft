/* oxlint-disable max-lines -- ID:core-engine-termination-file-length */

import type { BatchOperation } from '../../storage/interface.ts';
import { KEYS, encodeStorageKeyComponent } from '../../storage/interface.ts';
import { decode, encode } from '../codec.ts';
import {
  CleanupWarningEvent,
  WorkflowCancelledEvent,
  WorkflowCompletedEvent,
  WorkflowFailedEvent,
  WorkflowTimedOutEvent,
} from '../events.ts';
import { buildTimerBatchOperations, normalizeStorageTimestamp } from '../scheduler.ts';
import { buildIndexOperations } from '../search-attributes.ts';
import { WorkflowTimeoutError } from '../timeouts.ts';
import type {
  FailureCategory,
  SearchAttributeValue,
  WorkflowState,
  WorkflowStatus,
  WorkflowTimelineEntry,
} from '../types.ts';
import {
  buildRetainedTerminalSearchAttributes,
  buildTerminalWorkflowIndexOperations,
  cleanupAttributeIndex,
  updateWorkflowState,
  writeRetainedTerminalSearchAttributes,
} from './attributes-tags.ts';
import { TERMINAL_CLEANUP_DELAY_MS } from './bulk-operations.ts';
import { getWorkflowExecutionStartedAt } from './handles.ts';
import { dropQueuedInlineWorkflowStart } from './inline-launch-queue.ts';
import type { EngineInternals } from './internals.ts';
import { EMPTY_STORAGE_VALUE } from './lifecycle.ts';
import {
  createTerminalCleanupTimerId,
  parseTerminalCleanupTimerId,
  summarizeTimelineValue,
  workflowFeedListenerKey,
} from './state-utilities.ts';

export type TerminationCallbacks = {
  dispatchEvent: (event: Event) => void;
  forwardEventToHandle: (workflowId: string, event: Event) => void;
  broadcast: (message: { type: string; workflowId: string }) => void;
  swallowPromiseRejection: (promise: Promise<unknown> | undefined) => Promise<void>;
  handleCleanupError: (source: string, error: unknown, workflowId?: string) => void;
  handleScheduledWorkflowTerminal: (workflowId: string) => Promise<void>;
  loadWorkflowState: (workflowId: string) => Promise<WorkflowState | null>;
  runSerializedWorkflowStateWrite: <Result>(
    workflowId: string,
    writeOperation: () => Promise<Result>,
  ) => Promise<Result>;
  commitWorkflowStateOperations: (
    state: WorkflowState,
    operations: BatchOperation[],
    options?: { releaseTenantQuota?: boolean },
  ) => Promise<void>;
  cleanupReviews: (workflowId: string) => Promise<void>;
};

const TERMINAL_WORKFLOW_STATUSES: ReadonlySet<WorkflowStatus> = new Set<WorkflowStatus>([
  'completed',
  'failed',
  'cancelled',
  'timed-out',
]);

export async function cancelWorkflow(
  internals: EngineInternals,
  workflowId: string,
  callbacks: TerminationCallbacks,
): Promise<void> {
  await terminateWorkflow(internals, workflowId, 'cancelled', callbacks);
}

export async function timeoutWorkflow(
  internals: EngineInternals,
  workflowId: string,
  callbacks: TerminationCallbacks,
): Promise<void> {
  await terminateWorkflow(internals, workflowId, 'timed-out', callbacks);
}

export async function terminateWorkflow(
  internals: EngineInternals,
  workflowId: string,
  status: 'cancelled' | 'timed-out',
  callbacks: TerminationCallbacks,
): Promise<void> {
  internals.terminalizingWorkflows.add(workflowId);
  dropQueuedInlineWorkflowStart(internals, workflowId);
  internals.strategy.cancelWorkflow(workflowId);

  try {
    const attributeBytes = await internals.storage.get(KEYS.attribute(workflowId));
    const attributes = attributeBytes
      ? (decode(attributeBytes) as Record<string, SearchAttributeValue>)
      : {};
    const retainedAttributes = buildRetainedTerminalSearchAttributes(attributes);
    const terminationMessage = status === 'timed-out' ? 'Workflow timed out' : 'Workflow cancelled';
    const terminationResult = await updateWorkflowState(
      internals,
      workflowId,
      { status },
      {
        allowedStatuses: ['running', 'pending'],
        releaseTenantQuota: true,
        buildAdditionalOperations: (_previousState, updatedAt) => {
          finalizePendingTimelineEntry(
            internals,
            workflowId,
            status,
            terminationMessage,
            updatedAt,
          );
          const pendingTimelineOperation = buildPendingTimelineOperation(internals, workflowId);
          return pendingTimelineOperation ? [pendingTimelineOperation] : [];
        },
      },
    );
    if (!terminationResult) {
      return;
    }

    const { previousState, updatedAt } = terminationResult;
    const elapsed = updatedAt - getWorkflowExecutionStartedAt(previousState);
    await cleanupAttributeIndex(internals, workflowId, attributes);
    await writeRetainedTerminalSearchAttributes(internals, workflowId, retainedAttributes);
    void callbacks.swallowPromiseRejection(
      internals.scheduler.cancel(`deadline:${workflowId}`, workflowId),
    );
    if (previousState.status === 'pending') {
      void callbacks.swallowPromiseRejection(
        internals.scheduler.cancel(`delayed-start:${workflowId}`, workflowId),
      );
    }

    const resolver = internals.resultResolvers.get(workflowId);
    const terminalError =
      status === 'timed-out'
        ? new WorkflowTimeoutError(workflowId, 'execution', elapsed)
        : new Error('Workflow cancelled');

    try {
      await cleanupTerminalWorkflowSynchronously(internals, workflowId, true, callbacks);

      const event =
        status === 'timed-out'
          ? new WorkflowTimedOutEvent(workflowId, 'execution', elapsed)
          : new WorkflowCancelledEvent(workflowId);
      callbacks.dispatchEvent(event);
      callbacks.forwardEventToHandle(workflowId, event);

      if (resolver) resolver.reject(terminalError);
      // Scheduled queue handoff is best-effort cleanup and must not block
      // terminal delivery or handle settlement.
      void finalizeScheduledWorkflowTerminal(internals, workflowId, callbacks);
    } catch (cleanupError) {
      if (resolver) resolver.reject(terminalError);
      throw cleanupError;
    } finally {
      internals.resultResolvers.delete(workflowId);
    }
  } finally {
    internals.terminalizingWorkflows.delete(workflowId);
  }
}

export async function runDeferredTerminalCleanup(
  internals: EngineInternals,
  workflowId: string,
  timerId: string,
  callbacks: TerminationCallbacks,
): Promise<void> {
  const parsedTimer = parseTerminalCleanupTimerId(timerId);
  if (!parsedTimer) {
    callbacks.handleCleanupError(
      'cleanupTerminalWorkflowDurableState',
      new Error(`Ignoring malformed terminal cleanup timer id "${timerId}"`),
      workflowId,
    );
    return;
  }

  const state = await callbacks.loadWorkflowState(workflowId);
  if (!state || !TERMINAL_WORKFLOW_STATUSES.has(state.status)) {
    return;
  }

  if (state.terminalCleanupToken !== parsedTimer.terminalCleanupToken) {
    return;
  }

  try {
    await cleanupTerminalWorkflowDurableState(
      internals,
      workflowId,
      parsedTimer.includeOutputArtifacts,
      callbacks,
    );
  } catch (error) {
    callbacks.handleCleanupError('cleanupTerminalWorkflowDurableState', error, workflowId);
    throw error;
  }
}

/**
 * Remove durable records keyed by `workflowId` that otherwise leak after a
 * workflow reaches a terminal state.
 *
 * - When `includeOutputArtifacts` is `false` (used by `completeWorkflow`
 *   and `failWorkflow`), only internal bookkeeping is swept: pending
 *   signals. Output artifacts - offloaded values, blob stream chunks,
 *   shared state, and event history - are preserved so consumers can
 *   still read them via `getStreamChunks()`, `getOffload()`,
 *   `Engine.getEvents()`, etc. after `handle.result()` resolves.
 * - When `includeOutputArtifacts` is `true` (used by `terminateWorkflow`),
 *   the workflow has been cancelled or timed out and no consumer is
 *   waiting on output artifacts, so everything except `ev:` (preserved
 *   for the events endpoint) is removed.
 *
 * Concurrency note: we assume all writers for a workflow's prefixed keys
 * originate from that workflow's own execution. By the time this runs, the
 * workflow is already terminal and cannot schedule new writes. The
 * persisted `terminal-cleanup` timer invokes this after terminalization, so
 * any write that races the scan must have come from a background task that
 * itself still holds a handle to the terminal workflow. Those are
 * caller-level bugs we don't try to paper over here.
 *
 * Scale note: deletes are flushed in batches of `CLEANUP_BATCH_SIZE` so
 * workflows with many blobs/signals do not allocate a single oversized
 * operation array.
 */
export async function cleanupWorkflowStorage(
  internals: EngineInternals,
  workflowId: string,
  includeOutputArtifacts: boolean,
): Promise<void> {
  const encodedWorkflowId = encodeStorageKeyComponent(workflowId);

  // Always sweep internal state. Signals are workflow-scoped scratch space,
  // and the tool-effect log holds per-tool-call dedup records that have no
  // consumers after the workflow terminates - leaving them behind would
  // leak linearly with tool-call volume across the engine's lifetime.
  const prefixes: string[] = [
    `sig:${encodedWorkflowId}:`,
    `agent-execution:${encodedWorkflowId}:`,
    `tool-effect:${encodedWorkflowId}:`,
  ];

  if (includeOutputArtifacts) {
    // Terminated workflows have no waiting consumers, so drop the output
    // artifacts too. Event history is still preserved via the omission of
    // the `ev:` prefix - callers that want it gone should use a storage
    // TTL or explicit pruning.
    prefixes.push(
      `offload:${encodedWorkflowId}:`,
      `blob:${encodedWorkflowId}:`,
      `shared:${encodedWorkflowId}:`,
    );
  }

  await internals.storage.delete(KEYS.workflowHeaders(workflowId));

  // Use the storage adapter's native prefix deletion when available
  // (e.g., BunSQLiteStorage's prepared DELETE...WHERE key >= ? AND key < ?).
  // This replaces per-key scan-then-delete loops with a single SQL statement
  // per prefix - a significant win on the activity-completion hot path.
  // Deletions are sequential to avoid multiplying memory pressure on adapters
  // that materialize matching keys before deleting.
  if (internals.storage.deletePrefix) {
    for (const prefix of prefixes) {
      await internals.storage.deletePrefix(prefix);
    }
    return;
  }

  // Fallback for storage adapters without deletePrefix: scan and batch-delete.
  const CLEANUP_BATCH_SIZE = 500;
  let deleteOperations: BatchOperation[] = [];
  const flush = async (): Promise<void> => {
    if (deleteOperations.length === 0) return;
    await internals.storage.batch(deleteOperations);
    deleteOperations = [];
  };

  for (const prefix of prefixes) {
    for await (const [key] of internals.storage.scan(prefix)) {
      deleteOperations.push({ type: 'delete', key });
      if (deleteOperations.length >= CLEANUP_BATCH_SIZE) {
        await flush();
      }
    }
  }

  await flush();
}

/**
 * Shared synchronous cleanup invoked from every terminal-state transition
 * before result delivery. Drops only in-memory state so workflow resolution
 * is no longer blocked on storage cleanup. Durable scratch cleanup is
 * retried later through a persisted `terminal-cleanup` timer.
 *
 */
export function cleanupTerminalWorkflowMemory(
  internals: EngineInternals,
  workflowId: string,
  callbacks: Pick<TerminationCallbacks, 'swallowPromiseRejection'>,
): void {
  internals.workflowsNeedingTerminalCleanup.delete(workflowId);
  internals.checkpoints.delete(workflowId);
  internals.heartbeatDetails.delete(workflowId);
  internals.agentWorkflowIds.delete(workflowId);
  internals.eventLogHeads.delete(workflowId);
  internals.pendingTimelineEntries.delete(workflowId);
  internals.parkedInlineWorkflows.delete(workflowId);
  internals.workflowVersionTuples.delete(workflowId);
  // Drop any remaining feed-listener buckets for this workflow.
  // Transports normally unsubscribe when their subscription ends,
  // but a crashed or leaked connection would otherwise retain its
  // closure for the engine's lifetime. Per-workflow cleanup here
  // matches the other maps above and prevents unbounded growth.
  internals.workflowFeedListeners.delete(workflowFeedListenerKey(workflowId, 'events'));
  internals.workflowFeedListeners.delete(workflowFeedListenerKey(workflowId, 'tokens'));
  cleanupWaiters(internals, workflowId, callbacks);
}

export function cleanupTerminalWorkflowImmediately(
  internals: EngineInternals,
  workflowId: string,
  callbacks: TerminationCallbacks,
): void {
  cleanupTerminalWorkflowMemory(internals, workflowId, callbacks);
}

export async function cleanupTerminalWorkflowSynchronously(
  internals: EngineInternals,
  workflowId: string,
  includeOutputArtifacts: boolean,
  callbacks: TerminationCallbacks,
): Promise<void> {
  cleanupTerminalWorkflowMemory(internals, workflowId, callbacks);
  await cleanupTerminalWorkflowDurableState(
    internals,
    workflowId,
    includeOutputArtifacts,
    callbacks,
  );
}

export async function cleanupTerminalWorkflowDurableState(
  internals: EngineInternals,
  workflowId: string,
  includeOutputArtifacts: boolean,
  callbacks: TerminationCallbacks,
): Promise<void> {
  await callbacks.cleanupReviews(workflowId);
  await cleanupWorkflowStorage(internals, workflowId, includeOutputArtifacts);
  await internals.storage.delete(KEYS.terminalCleanupNeeded(workflowId));
}

/**
 * Remove any pending signal, update, and sleep waiters for a workflow. This
 * prevents memory leaks and ensures that cancelled/completed/failed workflows
 * cannot accept new signals, updates, or resolve orphaned sleep timers.
 */
// oxlint-disable-next-line complexity -- ID:core-engine-cleanup-waiters-complexity
export function cleanupWaiters(
  internals: EngineInternals,
  workflowId: string,
  callbacks: Pick<TerminationCallbacks, 'swallowPromiseRejection'>,
): void {
  const signalKeys = internals.signalWaitersByWorkflow.get(workflowId);
  if (signalKeys) {
    if (typeof signalKeys === 'string') {
      internals.signalWaiters.delete(signalKeys);
    } else {
      for (const key of signalKeys) internals.signalWaiters.delete(key);
    }
    internals.signalWaitersByWorkflow.delete(workflowId);
  }
  const updateKeys = internals.updateWaitersByWorkflow.get(workflowId);
  if (updateKeys) {
    if (typeof updateKeys === 'string') {
      internals.updateWaiters.delete(updateKeys);
    } else {
      for (const key of updateKeys) internals.updateWaiters.delete(key);
    }
    internals.updateWaitersByWorkflow.delete(workflowId);
  }
  const reviewKeys = internals.reviewWaitersByWorkflow.get(workflowId);
  if (reviewKeys) {
    if (typeof reviewKeys === 'string') {
      internals.reviewWaiters.delete(reviewKeys);
    } else {
      for (const key of reviewKeys) internals.reviewWaiters.delete(key);
    }
    internals.reviewWaitersByWorkflow.delete(workflowId);
  }
  const sleepOps = internals.sleepResolversByWorkflow.get(workflowId);
  if (sleepOps) {
    for (const operationId of sleepOps) {
      const key = `${workflowId}:${operationId}`;
      const resolver = internals.sleepResolvers.get(key);
      if (resolver) resolver();
      internals.sleepResolvers.delete(key);
    }
    internals.sleepResolversByWorkflow.delete(workflowId);
  }
  // Clean up any review escalation handlers and their scheduled timers
  const reviewIds = internals.workflowReviewIds.get(workflowId);
  if (reviewIds) {
    for (const reviewId of reviewIds) {
      internals.reviewEscalationHandlers.delete(reviewId);
      const timers = internals.reviewTimerIds.get(reviewId);
      if (timers) {
        for (const timerId of timers) {
          void callbacks.swallowPromiseRejection(internals.scheduler.cancel(timerId, workflowId));
        }
        internals.reviewTimerIds.delete(reviewId);
      }
    }
    internals.workflowReviewIds.delete(workflowId);
  }

  internals.workflowNestingDepths.delete(workflowId);
  internals.workflowHeaders.delete(workflowId);
}

export async function completeWorkflow(
  internals: EngineInternals,
  workflowId: string,
  result: unknown,
  callbacks: TerminationCallbacks,
): Promise<void> {
  const completionMetadata = await callbacks.runSerializedWorkflowStateWrite(
    workflowId,
    // oxlint-disable-next-line complexity -- ID:core-engine-complete-workflow-complexity
    async () => {
      const state = await callbacks.loadWorkflowState(workflowId);
      if (!state || state.status !== 'running') {
        return null;
      }

      const now = normalizeStorageTimestamp(
        internals.options.getNow(),
        'Workflow completion timestamp',
      );
      const duration = now - getWorkflowExecutionStartedAt(state);
      const terminalCleanupToken = internals.workflowsNeedingTerminalCleanup.has(workflowId)
        ? crypto.randomUUID()
        : undefined;

      // Batch the completion state write with attribute index cleanup into a
      // single storage transaction to reduce round-trips on the hot path.
      const updatedState = {
        ...state,
        status: 'completed' as const,
        result,
        updatedAt: now,
        ...(terminalCleanupToken !== undefined ? { terminalCleanupToken } : {}),
      };
      const completionOperations: BatchOperation[] = [
        ...buildTerminalWorkflowIndexOperations(state, updatedState),
        { type: 'put', key: KEYS.workflow(workflowId), value: encode(updatedState) },
      ];
      const pendingTimelineOperation = buildPendingTimelineOperation(internals, workflowId);
      if (pendingTimelineOperation) {
        completionOperations.push(pendingTimelineOperation);
      }

      // Prefer the in-memory checkpoint's search attributes when available so
      // the completion hot path avoids an extra storage read in the common
      // case. Recovered workflows still fall back to storage if the checkpoint
      // is unexpectedly absent.
      let currentAttributes = internals.checkpoints.get(workflowId)?.searchAttributes;
      if (currentAttributes === undefined) {
        const attributeBytes = await internals.storage.get(KEYS.attribute(workflowId));
        if (attributeBytes) {
          currentAttributes = decode(attributeBytes) as Record<string, SearchAttributeValue>;
        }
      }
      if (currentAttributes !== undefined && Object.keys(currentAttributes).length > 0) {
        const retainedAttributes = buildRetainedTerminalSearchAttributes(currentAttributes);

        completionOperations.push(
          ...buildIndexOperations(workflowId, currentAttributes, retainedAttributes),
        );
        if (Object.keys(retainedAttributes).length > 0) {
          completionOperations.push({
            type: 'put',
            key: KEYS.attribute(workflowId),
            value: encode(retainedAttributes),
          });
        } else {
          completionOperations.push({ type: 'delete', key: KEYS.attribute(workflowId) });
        }
      }

      if (terminalCleanupToken !== undefined) {
        completionOperations.push(
          ...buildTerminalCleanupTimerOperations(
            internals,
            workflowId,
            false,
            now,
            terminalCleanupToken,
          ),
        );
      }

      await callbacks.commitWorkflowStateOperations(state, completionOperations, {
        releaseTenantQuota: true,
      });
      return { duration };
    },
  );
  if (!completionMetadata) return;

  const { duration } = completionMetadata;

  // Cancel deadline timer - fire-and-forget since the workflow is already
  // terminal and a stale timer firing will see the terminal state and no-op.
  void callbacks.swallowPromiseRejection(
    internals.scheduler.cancel(`deadline:${workflowId}`, workflowId),
  );

  // Drop in-memory state immediately so the hot path releases engine memory
  // before result delivery. Durable scratch cleanup is handled by the
  // persisted terminal-cleanup timer written in the same state batch above.
  const resolver = internals.resultResolvers.get(workflowId);
  try {
    cleanupTerminalWorkflowImmediately(internals, workflowId, callbacks);

    const event = new WorkflowCompletedEvent(workflowId, result, duration);
    callbacks.dispatchEvent(event);
    callbacks.forwardEventToHandle(workflowId, event);

    callbacks.broadcast({ type: 'workflow:completed', workflowId });

    if (resolver) resolver.resolve(result);
    // Scheduled queue handoff is best-effort cleanup and must not block
    // terminal delivery or handle settlement.
    void finalizeScheduledWorkflowTerminal(internals, workflowId, callbacks);
  } catch (completionError) {
    if (resolver) resolver.resolve(result);
    throw completionError;
  } finally {
    internals.resultResolvers.delete(workflowId);
  }
}

export async function failWorkflow(
  internals: EngineInternals,
  workflowId: string,
  error: Error,
  callbacks: TerminationCallbacks,
  failureCategory: FailureCategory = 'system',
): Promise<void> {
  const attributeBytes = await internals.storage.get(KEYS.attribute(workflowId));
  const attributes = attributeBytes
    ? (decode(attributeBytes) as Record<string, SearchAttributeValue>)
    : {};
  const retainedAttributes = buildRetainedTerminalSearchAttributes(attributes, {
    failureCategory,
  });

  const stateUpdate: Partial<WorkflowState> = {
    status: 'failed',
    error: error.message,
    failureCategory,
  };
  if (error.stack !== undefined) {
    stateUpdate.errorStack = error.stack;
  }
  const failureResult = await updateWorkflowState(internals, workflowId, stateUpdate, {
    allowedStatuses: ['running', 'pending'],
    releaseTenantQuota: true,
    buildAdditionalOperations: (_previousState, updatedAt) => {
      finalizePendingTimelineEntry(internals, workflowId, 'failed', error.message, updatedAt);
      const pendingTimelineOperation = buildPendingTimelineOperation(internals, workflowId);
      return pendingTimelineOperation ? [pendingTimelineOperation] : [];
    },
  });
  if (!failureResult) {
    return;
  }

  // Clean up user-set attribute indexes; fire-and-forget the deadline
  // timer cancel since the workflow is terminal.
  await cleanupAttributeIndex(internals, workflowId, attributes);
  void callbacks.swallowPromiseRejection(
    internals.scheduler.cancel(`deadline:${workflowId}`, workflowId),
  );

  // Re-write engine-managed terminal attributes so they remain queryable
  // after the user-defined search attributes have been removed.
  await writeRetainedTerminalSearchAttributes(internals, workflowId, retainedAttributes);

  const resolver = internals.resultResolvers.get(workflowId);
  try {
    await cleanupTerminalWorkflowSynchronously(internals, workflowId, false, callbacks);

    const event = new WorkflowFailedEvent(workflowId, error);
    callbacks.dispatchEvent(event);
    callbacks.forwardEventToHandle(workflowId, event);

    if (resolver) resolver.reject(error);
    // Scheduled queue handoff is best-effort cleanup and must not block
    // terminal delivery or handle settlement.
    void finalizeScheduledWorkflowTerminal(internals, workflowId, callbacks);
  } catch (cleanupError) {
    if (resolver) resolver.reject(error);
    throw cleanupError;
  } finally {
    internals.resultResolvers.delete(workflowId);
  }
}

export function buildTerminalCleanupTimerOperations(
  _internals: EngineInternals,
  workflowId: string,
  includeOutputArtifacts: boolean,
  terminalizedAt: number,
  terminalCleanupToken: string,
): BatchOperation[] {
  return buildTimerBatchOperations({
    id: createTerminalCleanupTimerId(includeOutputArtifacts, terminalCleanupToken),
    workflowId,
    fireAt: terminalizedAt + TERMINAL_CLEANUP_DELAY_MS,
    kind: 'terminal-cleanup',
  });
}

export async function ensureTerminalCleanupTracked(
  internals: EngineInternals,
  workflowId: string,
): Promise<void> {
  if (internals.workflowsNeedingTerminalCleanup.has(workflowId)) {
    return;
  }

  internals.workflowsNeedingTerminalCleanup.add(workflowId);
  await internals.storage.put(KEYS.terminalCleanupNeeded(workflowId), EMPTY_STORAGE_VALUE);
}

export function handleCleanupError(
  _internals: EngineInternals,
  source: string,
  error: unknown,
  workflowId: string | undefined,
  callbacks: Pick<TerminationCallbacks, 'dispatchEvent'>,
): void {
  const normalizedError = error instanceof Error ? error : new Error(String(error));
  callbacks.dispatchEvent(new CleanupWarningEvent(source, normalizedError, workflowId));
}

export async function finalizeScheduledWorkflowTerminal(
  _internals: EngineInternals,
  workflowId: string,
  callbacks: Pick<TerminationCallbacks, 'handleCleanupError' | 'handleScheduledWorkflowTerminal'>,
): Promise<void> {
  try {
    await callbacks.handleScheduledWorkflowTerminal(workflowId);
  } catch (error) {
    callbacks.handleCleanupError('handleScheduledWorkflowTerminal', error, workflowId);
  }
}

export function finalizePendingTimelineEntry(
  internals: EngineInternals,
  workflowId: string,
  status: WorkflowTimelineEntry['status'],
  output: unknown,
  finishedAt = internals.options.getNow(),
): void {
  const pendingEntry = internals.pendingTimelineEntries.get(workflowId);
  if (!pendingEntry) {
    return;
  }

  const currentStatus = pendingEntry.entry.status;
  if (currentStatus === status) {
    return;
  }

  const canOverrideCompletedWithTerminalStatus =
    currentStatus === 'completed' &&
    (status === 'failed' || status === 'cancelled' || status === 'timed-out');
  if (currentStatus !== 'running' && !canOverrideCompletedWithTerminalStatus) {
    return;
  }

  pendingEntry.entry.status = status;
  pendingEntry.entry.outputSummary = summarizeTimelineValue(output);
  pendingEntry.entry.duration = finishedAt - pendingEntry.startedAt;
}

export function buildPendingTimelineOperation(
  internals: EngineInternals,
  workflowId: string,
): BatchOperation | null {
  const pendingEntry = internals.pendingTimelineEntries.get(workflowId);
  if (!pendingEntry) {
    return null;
  }

  return {
    type: 'put',
    key: KEYS.timeline(workflowId, pendingEntry.entry.step),
    value: encode(pendingEntry.entry),
  };
}
