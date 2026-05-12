import type { BatchOperation, Storage as WeftStorage } from '../../storage/interface.ts';
import {
  KEYS,
  encodeStorageKeyComponent,
  storageKeys,
  tryDecodeStorageKeyComponent,
} from '../../storage/interface.ts';
import { assertScopedBulkWorkflowFilter } from '../bulk-workflow-filter.ts';
import { decode } from '../codec.ts';
import { buildIndexOperations } from '../search-attributes.ts';
import type {
  BulkCancelResult,
  BulkDeleteResult,
  BulkOperationError,
  BulkSignalResult,
  BulkTagResult,
  ListFilter,
  NormalizedRetentionPolicy,
  PurgeResult,
  SearchAttributeValue,
  WorkflowState,
  WorkflowStatus,
} from '../types.ts';
import { buildWorkflowTagIndexOperations, normalizeWorkflowTags } from '../workflow-tags.ts';
import { bulkMutateWorkflowTags } from './attributes-tags.ts';
import { BulkDeleteRequiresTerminalWorkflowsError } from './errors.ts';
import type { EngineInternals } from './internals.ts';
import {
  BULK_OPERATION_BATCH_SIZE,
  streamWorkflowStateBatches,
  streamWorkflowStates,
} from './listing.ts';
import { createTerminalCleanupTimerId } from './state-utilities.ts';
import { loadWorkflowState } from './storage-io.ts';
import {
  decodeWorkflowState,
  isTerminalWorkflowStatus,
  resolveRetentionForStatus,
} from './validation.ts';
import { buildWorkflowVisibilityIndexTransition } from './workflow-indexes.ts';

export const TERMINAL_CLEANUP_DELAY_MS = 60_000;

type PurgeParameters = {
  expiredOnly: boolean;
  now: number;
  limit?: number;
};

type CleanupWaiters = (workflowId: string) => void;

const ACTIVE_WORKFLOW_STATUSES: WorkflowStatus[] = ['pending', 'running'];

export async function purge(
  internals: EngineInternals,
  filter: ListFilter | undefined,
  cleanupWaiters: CleanupWaiters,
): Promise<PurgeResult> {
  return purgeInternal(
    internals,
    filter,
    { expiredOnly: false, now: internals.options.getNow() },
    cleanupWaiters,
  );
}

export async function cancelAll(
  internals: EngineInternals,
  filter: ListFilter,
): Promise<BulkCancelResult> {
  assertScopedBulkWorkflowFilter(filter);
  const actionableFilter = buildActionableBulkWorkflowFilter(
    internals,
    filter,
    ACTIVE_WORKFLOW_STATUSES,
  );
  const workflowIdsToCancel = await snapshotMatchingWorkflowIds(internals, actionableFilter);
  let cancelled = 0;
  const errors: BulkOperationError[] = [];

  for (const workflowId of workflowIdsToCancel) {
    try {
      await internals.engine.cancel(workflowId);
      const refreshedState = await loadWorkflowState(internals, workflowId);
      if (refreshedState?.status === 'cancelled') {
        cancelled += 1;
        continue;
      }

      errors.push({ id: workflowId, error: 'Workflow no longer cancellable' });
    } catch (error) {
      errors.push(toBulkOperationError(internals, workflowId, error));
    }
  }

  return { cancelled, failed: errors.length, errors };
}

export async function signalAll(
  internals: EngineInternals,
  filter: ListFilter,
  name: string,
  payload?: unknown,
): Promise<BulkSignalResult> {
  assertScopedBulkWorkflowFilter(filter);
  if (name.length === 0) throw new Error('Field "name" must be a non-empty string');
  const actionableFilter = buildActionableBulkWorkflowFilter(
    internals,
    filter,
    ACTIVE_WORKFLOW_STATUSES,
  );
  const workflowIdsToSignal = await snapshotMatchingWorkflowIds(internals, actionableFilter);
  let signalled = 0;
  let failed = 0;

  for (const workflowId of workflowIdsToSignal) {
    try {
      await internals.engine.signal(workflowId, name, payload);
      signalled += 1;
    } catch {
      failed += 1;
    }
  }

  return { signalled, failed };
}

export async function deleteAll(
  internals: EngineInternals,
  filter: ListFilter,
  cleanupWaiters: CleanupWaiters,
): Promise<BulkDeleteResult> {
  assertScopedBulkWorkflowFilter(filter);
  const candidateWorkflowIds: string[] = [];

  for await (const batch of streamWorkflowStateBatches(internals, filter)) {
    for (const state of batch) {
      if (!isTerminalWorkflowStatus(state.status))
        throw new BulkDeleteRequiresTerminalWorkflowsError();

      candidateWorkflowIds.push(state.id);
    }
  }

  let deleted = 0;
  for (
    let batchStart = 0;
    batchStart < candidateWorkflowIds.length;
    batchStart += BULK_OPERATION_BATCH_SIZE
  ) {
    const batchWorkflowIds = candidateWorkflowIds.slice(
      batchStart,
      batchStart + BULK_OPERATION_BATCH_SIZE,
    );
    const workflowStatesToDelete: WorkflowState[] = [];

    for (const workflowId of batchWorkflowIds) {
      const refreshedState = await loadWorkflowState(internals, workflowId);
      if (refreshedState === null) continue;
      if (!isTerminalWorkflowStatus(refreshedState.status))
        throw new BulkDeleteRequiresTerminalWorkflowsError();

      workflowStatesToDelete.push(refreshedState);
    }

    for (const workflowState of workflowStatesToDelete) {
      await purgeWorkflow(internals, workflowState, cleanupWaiters);
      deleted += 1;
    }
  }

  return { deleted };
}

export async function tagAll(
  internals: EngineInternals,
  filter: ListFilter,
  tags: string[],
): Promise<BulkTagResult> {
  return bulkMutateWorkflowTags(internals, filter, tags, 'add');
}

export async function untagAll(
  internals: EngineInternals,
  filter: ListFilter,
  tags: string[],
): Promise<BulkTagResult> {
  return bulkMutateWorkflowTags(internals, filter, tags, 'remove');
}

export async function purgeInternal(
  internals: EngineInternals,
  filter: ListFilter | undefined,
  parameters: PurgeParameters,
  cleanupWaiters: CleanupWaiters,
): Promise<PurgeResult> {
  const { effectiveLimit, manualOffset } = resolvePurgeWindow(internals, filter, parameters.limit);

  if (effectiveLimit === 0) return { deleted: 0 };

  let remainingOffset = manualOffset;
  let deleted = 0;

  const workflowStateStream =
    parameters.expiredOnly && filter === undefined
      ? streamExpiredRetentionWorkflowStates(internals, parameters.now)
      : streamWorkflowStates(internals, filter);

  for await (const state of workflowStateStream) {
    if (!shouldPurgeWorkflowState(internals, state, parameters.expiredOnly, parameters.now)) {
      continue;
    }

    if (remainingOffset > 0) {
      remainingOffset -= 1;
      continue;
    }

    await purgeWorkflow(internals, state, cleanupWaiters);
    deleted += 1;

    if (effectiveLimit !== undefined && deleted >= effectiveLimit) {
      break;
    }
  }

  return { deleted };
}

function buildActionableBulkWorkflowFilter(
  _internals: EngineInternals,
  filter: ListFilter,
  actionableStatuses: WorkflowStatus[],
): ListFilter {
  const requestedStatuses =
    filter.status === undefined
      ? actionableStatuses
      : Array.isArray(filter.status)
        ? filter.status
        : [filter.status];
  const effectiveStatuses = requestedStatuses.filter((status) =>
    actionableStatuses.includes(status),
  );

  if (effectiveStatuses.length === 0) {
    return { ...filter, status: [] };
  }

  if (effectiveStatuses.length !== 1) {
    return { ...filter, status: effectiveStatuses };
  }

  const [effectiveStatus] = effectiveStatuses;
  return { ...filter, status: effectiveStatus ?? [] };
}

function toBulkOperationError(
  _internals: EngineInternals,
  workflowId: string,
  error: unknown,
): BulkOperationError {
  return {
    id: workflowId,
    error: error instanceof Error ? error.message : String(error),
  };
}

function getMinimumRetentionMs(internals: EngineInternals): number | null {
  let minimumRetentionMs: number | null = null;

  const considerRetentionPolicy = (policy: NormalizedRetentionPolicy | null | undefined): void => {
    for (const retentionMs of [
      policy?.completed,
      policy?.failed,
      policy?.cancelled,
      policy?.timedOut,
    ]) {
      if (retentionMs === undefined) continue;

      minimumRetentionMs =
        minimumRetentionMs === null ? retentionMs : Math.min(minimumRetentionMs, retentionMs);
    }
  };

  considerRetentionPolicy(internals.options.retention);
  for (const registration of internals.registrations.values()) {
    considerRetentionPolicy(registration.retention);
  }

  return minimumRetentionMs;
}

async function* streamExpiredRetentionWorkflowStates(
  internals: EngineInternals,
  now: number,
): AsyncGenerator<WorkflowState> {
  const minimumRetentionMs = getMinimumRetentionMs(internals);
  if (minimumRetentionMs === null) return;

  const terminalWorkflowPrefix = KEYS.terminalWorkflowPrefix();
  const newestPossibleExpiredUpdatedAt = now - minimumRetentionMs;
  const upperBound = `${terminalWorkflowPrefix}${String(newestPossibleExpiredUpdatedAt).padStart(16, '0')}:\xff`;

  for await (const [key] of internals.storage.scan(terminalWorkflowPrefix, {
    lte: upperBound,
  })) {
    const encodedWorkflowId = key.slice(key.lastIndexOf(':') + 1);
    const workflowId = tryDecodeStorageKeyComponent(encodedWorkflowId);
    if (workflowId === null) continue;

    const stateBytes = await internals.storage.get(KEYS.workflow(workflowId));
    if (!stateBytes) {
      await internals.storage.delete(key);
      continue;
    }

    const state = decodeWorkflowState(stateBytes);
    if (!isTerminalWorkflowStatus(state.status)) continue;

    yield state;
  }
}

async function snapshotMatchingWorkflowIds(
  internals: EngineInternals,
  filter?: ListFilter,
): Promise<string[]> {
  const workflowIds: string[] = [];

  // Snapshot ids before mutating workflow state entries so storage scans
  // cannot skip or re-visit workflows when backends reorder after writes.
  for await (const batch of streamWorkflowStateBatches(internals, filter))
    for (const state of batch) workflowIds.push(state.id);

  return workflowIds;
}

// oxlint-disable-next-line complexity -- ID:core-engine-resolve-purge-window-complexity
function resolvePurgeWindow(
  _internals: EngineInternals,
  filter: ListFilter | undefined,
  fallbackLimit: number | undefined,
): { effectiveLimit: number | undefined; manualOffset: number } {
  const manualOffset =
    filter?.offset !== undefined && Number.isFinite(filter.offset) && filter.offset > 0
      ? Math.floor(filter.offset)
      : 0;
  const manualLimit =
    filter?.limit !== undefined && Number.isFinite(filter.limit) && filter.limit >= 0
      ? Math.floor(filter.limit)
      : undefined;

  return {
    manualOffset,
    effectiveLimit:
      manualLimit !== undefined && fallbackLimit !== undefined
        ? Math.min(manualLimit, fallbackLimit)
        : (manualLimit ?? fallbackLimit),
  };
}

function shouldPurgeWorkflowState(
  internals: EngineInternals,
  state: WorkflowState,
  expiredOnly: boolean,
  now: number,
): boolean {
  if (!isTerminalWorkflowStatus(state.status)) return false;

  if (!expiredOnly) return true;

  const deadline = getWorkflowRetentionDeadline(internals, state);
  return deadline !== null && deadline <= now;
}

function getWorkflowRetentionDeadline(
  internals: EngineInternals,
  state: WorkflowState,
): number | null {
  if (!isTerminalWorkflowStatus(state.status)) return null;

  const policy = internals.registrations.get(state.type)?.retention ?? internals.options.retention;
  const retentionMs = resolveRetentionForStatus(policy, state.status);
  if (retentionMs === undefined) return null;

  return state.updatedAt + retentionMs;
}

// oxlint-disable-next-line complexity -- ID:core-engine-purge-workflow-complexity
async function purgeWorkflow(
  internals: EngineInternals,
  state: WorkflowState,
  cleanupWaiters: CleanupWaiters,
): Promise<void> {
  const workflowId = state.id;
  const encodedWorkflowId = encodeStorageKeyComponent(workflowId);
  const attributeBytes = await internals.storage.get(KEYS.attribute(workflowId));
  const deleteOperations: BatchOperation[] = [];
  const deleteKeys = new Set<string>([
    KEYS.workflow(workflowId),
    KEYS.checkpoint(workflowId),
    KEYS.workflowHeaders(workflowId),
    KEYS.terminalCleanupNeeded(workflowId),
    KEYS.attribute(workflowId),
    KEYS.terminalWorkflow(state.updatedAt, workflowId),
  ]);

  if (state.executionDeadline !== undefined) {
    deleteKeys.add(KEYS.deadline(state.executionDeadline, workflowId));
    deleteKeys.add(`timer-idx:deadline:${workflowId}`);
  }

  const cleanupIncludesOutputArtifacts =
    state.status === 'cancelled' || state.status === 'timed-out';
  if (state.terminalCleanupToken !== undefined) {
    const terminalCleanupTimerId = createTerminalCleanupTimerId(
      cleanupIncludesOutputArtifacts,
      state.terminalCleanupToken,
    );
    deleteKeys.add(
      KEYS.terminalCleanup(state.updatedAt + TERMINAL_CLEANUP_DELAY_MS, terminalCleanupTimerId),
    );
  }

  if (attributeBytes) {
    const currentAttributes = decode(attributeBytes) as Record<string, SearchAttributeValue>;
    for (const operation of buildIndexOperations(workflowId, currentAttributes, {})) {
      if (operation.type === 'delete') deleteOperations.push(operation);
    }
  }

  for (const operation of buildWorkflowTagIndexOperations(
    workflowId,
    normalizeWorkflowTags(state.tags),
    undefined,
  )) {
    if (operation.type === 'delete') deleteOperations.push(operation);
  }

  const updateRequestPrefix = KEYS.updatePrefix(workflowId);
  const updateRequestKeys = await collectKeysForPrefix(internals.storage, updateRequestPrefix);
  for (const key of updateRequestKeys) {
    deleteKeys.add(key);
    const updateId = key.slice(updateRequestPrefix.length);
    if (updateId.length > 0) deleteKeys.add(KEYS.updateResponse(updateId));
  }

  for (const prefix of [
    `wf:${encodedWorkflowId}:ckpt:`,
    `ev:${encodedWorkflowId}:`,
    `sig:${encodedWorkflowId}:`,
    `review:${encodedWorkflowId}:`,
    `offload:${encodedWorkflowId}:`,
    `archive:${encodedWorkflowId}:`,
    `blob:${encodedWorkflowId}:`,
    `state:execution:${encodedWorkflowId}:`,
    `tool-effect:${encodedWorkflowId}:`,
    `upk:${encodedWorkflowId}:`,
  ]) {
    const keys = await collectKeysForPrefix(internals.storage, prefix);
    for (const key of keys) deleteKeys.add(key);
  }

  for (const key of deleteKeys) deleteOperations.push({ type: 'delete', key });
  deleteOperations.push(
    ...buildWorkflowVisibilityIndexTransition(workflowId, state, null).batchOps,
  );
  await internals.storage.batch(deleteOperations);
  internals.checkpoints.delete(workflowId);
  internals.heartbeatDetails.delete(workflowId);
  internals.eventLogHeads.delete(workflowId);
  internals.workflowVersionTuples.delete(workflowId);
  internals.handleCache.delete(workflowId);
  internals.resultResolvers.delete(workflowId);
  internals.workflowHeaders.delete(workflowId);
  internals.workflowNestingDepths.delete(workflowId);
  cleanupWaiters(workflowId);
}

async function collectKeysForPrefix(storage: WeftStorage, prefix: string): Promise<string[]> {
  const keys: string[] = [];
  for await (const key of storageKeys(storage, prefix)) keys.push(key);
  return keys;
}
