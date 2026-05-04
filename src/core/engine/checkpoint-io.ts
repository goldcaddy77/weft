import type { BatchOperation } from '../../storage/interface.ts';
import { KEYS } from '../../storage/interface.ts';
import {
  advanceCheckpoint,
  deserializeCheckpoint,
  serializeCheckpoint,
  validateCheckpointRoundTrip,
} from '../checkpoint.ts';
import { decode, encode } from '../codec.ts';
import type { ContextOperationRequest } from '../context.ts';
import { sanitizeDebugValueForDisplay } from '../debug-output.ts';
import { EMPTY_EVENT_HEAD, EventLog } from '../event-log.ts';
import {
  AttributesChangedEvent,
  CheckpointSizeWarningEvent,
  DevelopmentWarningEvent,
} from '../events.ts';
import { buildIndexOperations } from '../search-attributes.ts';
import type {
  CheckpointState,
  CheckpointSummary,
  SearchAttributeValue,
  WorkflowEvent,
  WorkflowReplay,
  WorkflowTimelineEntry,
} from '../types.ts';
import type { EngineInternals } from './internals.ts';
import {
  getTimelineInputSummary,
  getTimelineOperationLabel,
  sanitizeCheckpointState,
  sanitizeTimelineSummary,
  sanitizeWorkflowEventPayload,
} from './state-utilities.ts';
import { buildPendingTimelineOperation } from './termination.ts';
import { isWorkflowTimelineEntry } from './validation.ts';
import { notifyWorkflowFeedCommit } from './workflow-feed.ts';

type PendingTimelineEntryValue = {
  startedAt: number;
  entry: WorkflowTimelineEntry;
};

type PersistCheckpointCallbacks = {
  appendTimelineBatchOperations: (
    workflowId: string,
    operation: ContextOperationRequest,
    step: number,
    timestamp: number,
    operations: BatchOperation[],
  ) => PendingTimelineEntryValue;
  swallowPromiseRejection: (promise: Promise<void>) => void;
  validateAttributeValueSizes: (attributes: Record<string, SearchAttributeValue>) => void;
  pruneCheckpointHistory: (workflowId: string, step: number) => Promise<void>;
  dispatchEvent: (event: Event) => void;
};

type DevelopmentCheckpointCallbacks = {
  dispatchEvent: (event: Event) => void;
};

export function appendTimelineBatchOperations(
  internals: EngineInternals,
  workflowId: string,
  operation: ContextOperationRequest,
  step: number,
  timestamp: number,
  operations: BatchOperation[],
): PendingTimelineEntryValue {
  const pendingTimelineOperation = buildPendingTimelineOperation(internals, workflowId);
  const versionTuple = internals.workflowVersionTuples.get(workflowId);

  if (pendingTimelineOperation) {
    operations.push(pendingTimelineOperation);
  }

  const entry: WorkflowTimelineEntry = {
    step,
    operationType: operation.type,
    operationLabel: getTimelineOperationLabel(operation),
    inputSummary: getTimelineInputSummary(operation),
    timestamp,
    status: 'running',
    ...(versionTuple ? { versionTuple } : {}),
  };

  operations.push({
    type: 'put',
    key: KEYS.timeline(workflowId, step),
    value: encode(entry),
  });

  return {
    startedAt: timestamp,
    entry,
  };
}

/** Retrieve the event history for a workflow. */
export async function getEvents(
  internals: EngineInternals,
  workflowId: string,
): Promise<WorkflowEvent[]> {
  const events: WorkflowEvent[] = [];
  const eventLog = new EventLog(internals.storage, workflowId);

  // Use EventLog.scan() instead of scanning the raw prefix so that the head
  // record (ev:{workflowId}:head) is filtered out by the isWorkflowLogEntry
  // guard inside scan(). Previously this method scanned the raw prefix and
  // returned a spurious entry for the head record on every checkpointed workflow.
  for await (const entry of eventLog.scan()) {
    events.push({
      type: entry.type,
      timestamp: entry.timestamp,
      data: sanitizeWorkflowEventPayload(entry.payload),
    });
  }

  return events;
}

/**
 * List checkpoint history entries for a workflow, newest first.
 * Returns summary metadata only — use getCheckpointAt for full state.
 */
export async function listCheckpoints(
  internals: EngineInternals,
  workflowId: string,
): Promise<CheckpointSummary[]> {
  if (internals.options.checkpointHistory <= 0) return [];

  const prefix = `${KEYS.checkpoint(workflowId)}:`;
  const summaries: CheckpointSummary[] = [];

  for await (const [, value] of internals.storage.scan(prefix, {
    reverse: true,
    limit: internals.options.checkpointHistory,
  })) {
    const checkpoint = deserializeCheckpoint(value);
    summaries.push({
      step: checkpoint.step,
      timestamp: checkpoint.createdAt,
      sizeBytes: value.byteLength,
    });
  }

  return summaries;
}

/** Retrieve the full deserialized checkpoint state at a specific step. */
export async function getCheckpointAt(
  internals: EngineInternals,
  workflowId: string,
  step: number,
): Promise<CheckpointState | null> {
  const bytes = await internals.storage.get(KEYS.checkpointHistory(workflowId, step));
  if (!bytes) return null;

  const checkpoint = deserializeCheckpoint(bytes);
  return sanitizeCheckpointState({
    step: checkpoint.step,
    locals: checkpoint.locals,
    searchAttributes: checkpoint.searchAttributes,
    version: checkpoint.version,
    createdAt: checkpoint.createdAt,
  });
}

/** Return the durable per-step execution timeline for a workflow. */
export async function getTimeline(
  internals: EngineInternals,
  workflowId: string,
): Promise<WorkflowTimelineEntry[]> {
  const timeline: WorkflowTimelineEntry[] = [];

  for await (const [, value] of internals.storage.scan(KEYS.timelinePrefix(workflowId))) {
    let decoded: unknown;
    try {
      decoded = decode(value);
    } catch {
      continue;
    }

    if (isWorkflowTimelineEntry(decoded)) {
      timeline.push({
        ...decoded,
        inputSummary: sanitizeTimelineSummary(decoded.inputSummary) ?? decoded.inputSummary,
        ...(decoded.outputSummary !== undefined
          ? {
              outputSummary:
                sanitizeTimelineSummary(decoded.outputSummary) ?? decoded.outputSummary,
            }
          : {}),
      });
    }
  }

  timeline.sort((left, right) => left.step - right.step);
  return timeline;
}

/** Reconstruct workflow state at a historical checkpoint step. */
export async function replayTo(
  internals: EngineInternals,
  workflowId: string,
  step: number,
): Promise<WorkflowReplay | null> {
  const bytes = await internals.storage.get(KEYS.checkpointHistory(workflowId, step));
  if (!bytes) {
    return null;
  }

  const checkpoint = deserializeCheckpoint(bytes);
  const eventLog = new EventLog(internals.storage, workflowId);
  const entries = await eventLog.replay(Math.max(step - 1, -1));

  return {
    checkpoint: sanitizeCheckpointState({
      step: checkpoint.step,
      locals: checkpoint.locals,
      searchAttributes: checkpoint.searchAttributes,
      version: checkpoint.version,
      createdAt: checkpoint.createdAt,
    }),
    accumulatedResults: checkpoint.accumulatedResults.map(([index, value]) => [
      index,
      sanitizeDebugValueForDisplay(value),
    ]),
    events: entries.map((entry) => ({
      type: entry.type,
      timestamp: entry.timestamp,
      data: sanitizeWorkflowEventPayload(entry.payload),
    })),
  };
}

/** Persist a workflow checkpoint, history entry, timeline record, and event log record. */
// oxlint-disable-next-line complexity -- ID:core-engine-persist-checkpoint-complexity
export async function persistCheckpoint(
  internals: EngineInternals,
  workflowId: string,
  operation: ContextOperationRequest,
  workerCheckpointBytes: ArrayBuffer | undefined,
  callbacks: PersistCheckpointCallbacks,
): Promise<void> {
  const context = internals.inlineStrategy?.getContext(workflowId);

  if (context) {
    // Inline strategy: advance checkpoint from context state
    const current = internals.checkpoints.get(workflowId);
    if (!current) return;

    const previousAttributes = { ...current.searchAttributes };
    const hasPendingAttributeChanges = context.hasPendingAttributeChanges;
    const checkpointLocals = context.checkpointLocals;
    const pendingAttributeChanges = context.checkpointPendingAttributeChanges;
    const accumulatedResults = context.checkpointAccumulatedResults;
    const advanced = advanceCheckpoint(current, checkpointLocals, {
      accumulatedResults,
      now: internals.options.getNow(),
      ...(pendingAttributeChanges !== undefined
        ? { searchAttributes: pendingAttributeChanges }
        : {}),
    });

    const serialized = serializeCheckpoint(advanced);

    if (serialized.byteLength >= internals.options.checkpointSizeWarningThreshold) {
      callbacks.dispatchEvent(
        new CheckpointSizeWarningEvent(workflowId, serialized.byteLength, advanced.step),
      );
    }

    const operations: BatchOperation[] = [
      { type: 'put', key: KEYS.checkpoint(workflowId), value: serialized },
    ];

    if (internals.options.checkpointHistory > 0) {
      operations.push({
        type: 'put',
        key: KEYS.checkpointHistory(workflowId, advanced.step),
        value: serialized,
      });
    }

    if (hasPendingAttributeChanges) {
      callbacks.validateAttributeValueSizes(pendingAttributeChanges ?? {});
      operations.push({
        type: 'put',
        key: KEYS.attribute(workflowId),
        value: encode(advanced.searchAttributes),
      });
      operations.push(
        ...buildIndexOperations(workflowId, previousAttributes, advanced.searchAttributes),
      );
    }

    const nextPendingTimelineEntry = callbacks.appendTimelineBatchOperations(
      workflowId,
      operation,
      advanced.step,
      advanced.createdAt,
      operations,
    );

    // Co-write event log entry in the same batch so checkpoint and log never diverge.
    // appendToBatch() is synchronous — no storage reads, no extra await.
    const eventLog = new EventLog(internals.storage, workflowId);
    const { newHead, timestamp } = eventLog.appendToBatch(
      { type: 'workflow:checkpoint', payload: { step: advanced.step } },
      operations,
      internals.eventLogHeads.get(workflowId) ?? EMPTY_EVENT_HEAD,
      internals.workflowVersionTuples.get(workflowId),
    );

    await internals.storage.batch(operations);
    internals.pendingTimelineEntries.set(workflowId, nextPendingTimelineEntry);
    internals.checkpoints.set(workflowId, advanced);
    internals.eventLogHeads.set(workflowId, newHead);
    notifyWorkflowFeedCommit(internals, workflowId, 'events', {
      workflowId,
      selector: 'events',
      kind: 'workflow:checkpoint',
      sequence: newHead.sequence,
      timestamp,
      payload: { step: advanced.step },
    });
    // Fire-and-forget: pruning is idempotent and non-critical, so deferring
    // it avoids blocking the checkpoint persist path.
    callbacks.swallowPromiseRejection(callbacks.pruneCheckpointHistory(workflowId, advanced.step));

    if (hasPendingAttributeChanges) {
      const changedAttributes = pendingAttributeChanges ?? {};
      callbacks.dispatchEvent(new AttributesChangedEvent(workflowId, { ...changedAttributes }));
    }
  } else if (workerCheckpointBytes && workerCheckpointBytes.byteLength > 0) {
    // Worker strategy: persist the checkpoint bytes sent from the worker
    const serialized = new Uint8Array(workerCheckpointBytes);
    const checkpoint = deserializeCheckpoint(serialized);

    if (serialized.byteLength >= internals.options.checkpointSizeWarningThreshold) {
      callbacks.dispatchEvent(
        new CheckpointSizeWarningEvent(workflowId, serialized.byteLength, checkpoint.step),
      );
    }

    const operations: BatchOperation[] = [
      { type: 'put', key: KEYS.checkpoint(workflowId), value: serialized },
    ];

    if (internals.options.checkpointHistory > 0) {
      operations.push({
        type: 'put',
        key: KEYS.checkpointHistory(workflowId, checkpoint.step),
        value: serialized,
      });
    }

    const nextPendingTimelineEntry = callbacks.appendTimelineBatchOperations(
      workflowId,
      operation,
      checkpoint.step,
      checkpoint.createdAt,
      operations,
    );

    // Co-write event log entry in the same batch so checkpoint and log never diverge.
    // appendToBatch() is synchronous — no storage reads, no extra await.
    const eventLog = new EventLog(internals.storage, workflowId);
    const { newHead, timestamp } = eventLog.appendToBatch(
      { type: 'workflow:checkpoint', payload: { step: checkpoint.step } },
      operations,
      internals.eventLogHeads.get(workflowId) ?? EMPTY_EVENT_HEAD,
      internals.workflowVersionTuples.get(workflowId),
    );

    await internals.storage.batch(operations);
    internals.pendingTimelineEntries.set(workflowId, nextPendingTimelineEntry);
    internals.checkpoints.set(workflowId, checkpoint);
    internals.eventLogHeads.set(workflowId, newHead);
    notifyWorkflowFeedCommit(internals, workflowId, 'events', {
      workflowId,
      selector: 'events',
      kind: 'workflow:checkpoint',
      sequence: newHead.sequence,
      timestamp,
      payload: { step: checkpoint.step },
    });
    callbacks.swallowPromiseRejection(
      callbacks.pruneCheckpointHistory(workflowId, checkpoint.step),
    );
  }
}

/** Delete the single checkpoint history entry that overflows the retention limit. */
export async function pruneCheckpointHistory(
  internals: EngineInternals,
  workflowId: string,
  currentStep: number,
): Promise<void> {
  const limit = internals.options.checkpointHistory;
  if (limit <= 0) return;

  const overflowStep = currentStep - limit;
  if (overflowStep < 1) return;

  const key = KEYS.checkpointHistory(workflowId, overflowStep);
  await internals.storage.delete(key);
}

/** Validate checkpoint serialization in development mode and dispatch warnings. */
export function validateDevelopmentCheckpoint(
  internals: EngineInternals,
  workflowId: string,
  callbacks: DevelopmentCheckpointCallbacks,
): void {
  if (!internals.options.development) return;

  const context = internals.inlineStrategy?.getContext(workflowId);
  if (!context) return;

  const step = context.stepIndex;
  const current = internals.checkpoints.get(workflowId);
  if (!current) return;
  const result = validateCheckpointRoundTrip(current);

  if (!result.valid) {
    const fieldPaths = result.divergences.map((divergence) => divergence.path);
    const message = `Checkpoint at step ${step} has ${result.divergences.length} non-serializable field(s)`;
    callbacks.dispatchEvent(new DevelopmentWarningEvent(workflowId, message, fieldPaths));
  }
}
