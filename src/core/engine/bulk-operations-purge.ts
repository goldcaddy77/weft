import type { BatchOperation } from '../../storage/interface.ts';
import {
  KEYS,
  storageDeletePrefix,
  storageHas,
  tryDecodeStorageKeyComponent,
} from '../../storage/interface.ts';
import type {
  ListFilter,
  NormalizedRetentionPolicy,
  PurgeResult,
  WorkflowState,
} from '../types.ts';
import {
  buildWorkflowPurgeRemainderDeleteOperations,
  collectWorkflowPrefixSweepDeleteOperations,
  workflowPurgePrefixes,
} from './bulk-operations-purge-keys.ts';
import { forgetCommittedCheckpointBytes } from './checkpoint-commit-snapshots.ts';
import { commitFencedEngineWrite } from './fenced-write.ts';
import type { EngineInternals } from './internals.ts';
import { EngineDeposedError } from './lease-errors.ts';
import { streamWorkflowStates } from './listing.ts';
import {
  decodeWorkflowState,
  isTerminalWorkflowStatus,
  resolveRetentionForStatus,
} from './validation.ts';
import { buildWorkflowVisibilityIndexTransition } from './workflow-indexes.ts';

export const TERMINAL_CLEANUP_DELAY_MS = 60_000;
export type PurgeParameters = {
  expiredOnly: boolean;
  now: number;
  limit?: number;
  /**
   * Invoked when a single workflow fails to purge. Per-run isolation continues
   * the sweep past the failure (the failure is also counted in
   * {@link PurgeResult.failed}); this hook lets the retention sweep route the
   * error into the engine's existing cleanup-error path. A deposition is NOT
   * reported here — it re-throws and halts the sweep.
   */
  onWorkflowPurgeError?: (workflowId: string, error: unknown) => void;
};
export type CleanupWaiters = (workflowId: string) => void;

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
  let failed = 0;

  for await (const state of selectPurgeWorkflowStateStream(internals, filter, parameters)) {
    if (
      !(await shouldPurgeWorkflowState(internals, state, parameters.expiredOnly, parameters.now))
    ) {
      continue;
    }

    if (remainingOffset > 0) {
      remainingOffset -= 1;
      continue;
    }

    if (await purgeWorkflowWithIsolation(internals, state, parameters, cleanupWaiters)) {
      deleted += 1;
    } else {
      failed += 1;
    }

    if (effectiveLimit !== undefined && deleted >= effectiveLimit) {
      break;
    }
  }

  return failed > 0 ? { deleted, failed } : { deleted };
}

/**
 * Choose the workflow-state stream a purge walks: the expiry-ordered terminal
 * index for an unfiltered retention sweep, or a filtered listing otherwise.
 */
function selectPurgeWorkflowStateStream(
  internals: EngineInternals,
  filter: ListFilter | undefined,
  parameters: PurgeParameters,
): AsyncGenerator<WorkflowState> | AsyncIterable<WorkflowState> {
  return parameters.expiredOnly && filter === undefined
    ? streamExpiredRetentionWorkflowStates(internals, parameters.now)
    : streamWorkflowStates(internals, filter);
}

/**
 * Purge one workflow with per-run isolation: a failure does NOT abort the sweep
 * and strand every older run behind it (the exact failure the batch-cap defect
 * produced — the oldest oversized run threw and nothing was ever deleted).
 * Returns `true` on success and `false` on a handled failure (reported via
 * `onWorkflowPurgeError`). A deposition is NOT isolated — the engine no longer
 * owns the store, so it re-throws and halts the whole sweep.
 */
async function purgeWorkflowWithIsolation(
  internals: EngineInternals,
  state: WorkflowState,
  parameters: PurgeParameters,
  cleanupWaiters: CleanupWaiters,
): Promise<boolean> {
  try {
    await purgeWorkflow(internals, state, cleanupWaiters);
    return true;
  } catch (error) {
    if (error instanceof EngineDeposedError) throw error;
    parameters.onWorkflowPurgeError?.(state.id, error);
    return false;
  }
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

function resolvePurgeWindow(
  _internals: EngineInternals,
  filter: ListFilter | undefined,
  fallbackLimit: number | undefined,
): { effectiveLimit: number | undefined; manualOffset: number } {
  return {
    manualOffset: normalizePurgeOffset(filter?.offset),
    effectiveLimit: resolvePurgeLimit(normalizePurgeLimit(filter?.limit), fallbackLimit),
  };
}

function normalizePurgeOffset(offset: number | undefined): number {
  if (offset === undefined) return 0;
  if (!Number.isFinite(offset)) return 0;
  if (offset <= 0) return 0;
  return Math.floor(offset);
}

function normalizePurgeLimit(limit: number | undefined): number | undefined {
  if (limit === undefined) return undefined;
  if (!Number.isFinite(limit)) return undefined;
  if (limit < 0) return undefined;
  return Math.floor(limit);
}

function resolvePurgeLimit(
  manualLimit: number | undefined,
  fallbackLimit: number | undefined,
): number | undefined {
  if (manualLimit === undefined) return fallbackLimit;
  if (fallbackLimit === undefined) return manualLimit;
  return Math.min(manualLimit, fallbackLimit);
}

async function shouldPurgeWorkflowState(
  internals: EngineInternals,
  state: WorkflowState,
  expiredOnly: boolean,
  now: number,
): Promise<boolean> {
  if (!isTerminalWorkflowStatus(state.status)) return false;

  // A workflow that still owes an engine-driven finalizer (#446) must not be
  // purged: purge deletes the `finalizerState` payload the finalizer needs as its
  // input, so purging first would silently abandon the teardown of a paid external
  // resource — the exact leak #446 prevents. The finalizer deletes this marker on
  // success or when it dead-letters, which is what unblocks purge. The dead-letter
  // record (`teardownDeadLetter`) is deliberately NOT a gate — it is a terminal
  // audit trail, not outstanding work, and is excluded from the purge delete-set.
  if (await storageHas(internals.storage, KEYS.teardownOwed(state.id))) return false;

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

export async function purgeWorkflow(
  internals: EngineInternals,
  state: WorkflowState,
  cleanupWaiters: CleanupWaiters,
): Promise<void> {
  // A single production run can carry tens of thousands of keys (a checkpoint +
  // event row per loop iteration; up to 48,215 observed), which blows past
  // MAX_BATCH_OPERATIONS if the whole delete-set is committed as one batch. The
  // single batch was buying atomicity, so we preserve what it bought instead of
  // naively chunking the whole set:
  //
  //   Phase A — server-side range deletes for the high-cardinality history
  //   (`wf:{id}:ckpt:`, `wf:{id}:timeline:`, `ev:{id}:`, and the other
  //   per-workflow prefixes). One SQL DELETE each on Postgres; a cap-chunked
  //   scan-and-delete on adapters without native range delete. This bulk is
  //   never enumerated into a batch.
  //
  //   Phase B — ONE fenced atomic commit for the small decisive remainder (the
  //   state row, current ckpt, headers, timers, attr/tag indexes, updates,
  //   fleet-event links, and the visibility-index removal), preserving the
  //   lease-epoch fence.
  //
  // Ordering is interruption-safe: history first, the state-row-bearing commit
  // LAST. A crash between the phases leaves a terminal, still-listed,
  // re-purgeable run — Phase A deletes are idempotent, and no orphan timers or
  // index rows survive without their state row because they live in Phase B
  // beside it. All keys are computed from `state` up front (timer keys are
  // derived FROM the state), before any delete runs.
  const remainderOperations = await collectWorkflowPurgeRemainderOperations(internals, state);

  // Phase A: history range deletes.
  for (const prefix of workflowPurgePrefixes(state.id)) {
    await storageDeletePrefix(internals.storage, prefix);
  }

  // Phase B: the decisive remainder, fenced and atomic, state row deleted last.
  await commitFencedEngineWrite(
    internals,
    remainderOperations,
    [],
    () => new Error(`Purge commit for workflow "${state.id}" lost its precondition.`),
  );
  clearPurgedWorkflowInMemoryState(internals, state.id, cleanupWaiters);
}

/**
 * Collect every storage delete operation that removing a workflow id entails —
 * index deletes (search attributes + tags), the explicit key set (state,
 * checkpoint, headers, services marker, update requests/responses, and the
 * `wf:`/`ev:`/`sig:`/... prefix sweeps), and the visibility-index transition to
 * `null`. Pure: it reads storage to discover keys but writes nothing, so a caller
 * can fold the returned ops into a larger atomic batch instead of committing them
 * standalone. {@link purgeWorkflow} commits them on their own; the
 * `onTerminalConflict: 'start-new'` restart path prepends them to the create batch
 * so purge-and-recreate land as one atomic unit (no window where the prior run is
 * gone but the new one has not committed). Keep this the single source of truth
 * for "what a purge deletes" — do not fork the delete-set.
 */
export async function collectWorkflowPurgeDeleteOperations(
  internals: EngineInternals,
  state: WorkflowState,
): Promise<BatchOperation[]> {
  const remainderOperations = await collectWorkflowPurgeRemainderOperations(internals, state);
  const prefixOperations = await collectWorkflowPrefixSweepDeleteOperations(
    internals.storage,
    state.id,
  );
  remainderOperations.push(...prefixOperations);
  return remainderOperations;
}

/**
 * The purge delete-set EXCEPT the high-cardinality history prefixes
 * ({@link workflowPurgePrefixes}). This is the "small decisive remainder" the
 * retention purge commits as one fenced atomic batch after range-deleting the
 * history: the state row, current checkpoint, headers, timers, search-attribute
 * and tag index rows, update requests/responses, fleet-event links (and their
 * scattered `fleet-event:{seq}` payloads, which are NOT contiguous so cannot be
 * range-deleted), and the visibility-index transition to `null`.
 *
 * Pure: reads storage to discover keys but writes nothing.
 * {@link collectWorkflowPurgeDeleteOperations} re-adds the prefix sweep on top
 * of this so the `onTerminalConflict: 'start-new'` restart path still gets the
 * complete delete-set to fold atomically into its create batch. Keep the split
 * here the single source of truth for "history vs. remainder" — do not fork it.
 */
export async function collectWorkflowPurgeRemainderOperations(
  internals: EngineInternals,
  state: WorkflowState,
): Promise<BatchOperation[]> {
  const deleteOperations = await buildWorkflowPurgeRemainderDeleteOperations(internals, state);
  deleteOperations.push(
    ...buildWorkflowVisibilityIndexTransition(state.id, state, null).batchOps,
  );
  return deleteOperations;
}

/**
 * Drop every in-memory cache entry a purged workflow id owns (checkpoints,
 * heartbeat details, event-log heads, version tuples, handle cache, result
 * resolvers, headers, nesting depths, type map, pending async activities) and run
 * `cleanupWaiters` to settle any pending signal/update/sleep waiters. Split from
 * the storage batch in {@link collectWorkflowPurgeDeleteOperations} so the restart
 * path can clear the OLD run's in-memory state up front — before the new run's
 * caches are written under the reused id — while the durable delete still commits
 * atomically with the create.
 */
export function clearPurgedWorkflowInMemoryState(
  internals: EngineInternals,
  workflowId: string,
  cleanupWaiters: CleanupWaiters,
): void {
  forgetCommittedCheckpointBytes(internals, workflowId);
  internals.checkpoints.delete(workflowId);
  internals.heartbeatDetails.delete(workflowId);
  internals.lastHeartbeatDetailsByStep.delete(workflowId);
  for (const [token, pending] of internals.pendingAsyncActivities) {
    if (pending.workflowId === workflowId) {
      internals.pendingAsyncActivities.delete(token);
    }
  }
  internals.pendingAsyncActivityResolutions.delete(workflowId);
  internals.eventLogHeads.delete(workflowId);
  internals.workflowVersionTuples.delete(workflowId);
  internals.handleCache.delete(workflowId);
  internals.resultResolvers.delete(workflowId);
  internals.workflowHeaders.delete(workflowId);
  internals.workflowNestingDepths.delete(workflowId);
  internals.workflowTypeByWorkflowId.delete(workflowId);
  cleanupWaiters(workflowId);
}
