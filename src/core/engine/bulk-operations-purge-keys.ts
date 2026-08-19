/**
 * The pure key/operation collection helpers behind a workflow purge: what keys a
 * purge owns, split into the high-cardinality history prefixes (range-deleted)
 * and the small individual-key remainder (committed atomically). Extracted from
 * `bulk-operations-purge.ts` so that file stays under the implementation
 * file-size limit; the execution/orchestration (the two-phase purge, the sweep
 * loop, the fenced commit) stays there. Everything here reads storage to
 * discover keys but writes nothing.
 *
 * @module core/engine/bulk-operations-purge-keys
 */

import type { BatchOperation, Storage as WeftStorage } from '../../storage/interface.ts';
import { KEYS, encodeStorageKeyComponent, storageKeys } from '../../storage/interface.ts';
import { decode } from '../codec.ts';
import { buildIndexOperations } from '../search-attributes.ts';
import type { SearchAttributeValue, WorkflowState } from '../types.ts';
import { buildWorkflowTagIndexOperations, normalizeWorkflowTags } from '../workflow-tags.ts';
import { asyncActivityWorkflowPrefix } from './async-activity-records.ts';
import type { EngineInternals } from './internals.ts';
import { decodeScheduleRunMetadata } from './schedule-run-metadata.ts';
import { createTerminalCleanupTimerId } from './state-utilities.ts';

const TERMINAL_CLEANUP_DELAY_MS = 60_000;

/**
 * The purge delete operations EXCEPT the high-cardinality history prefixes
 * ({@link workflowPurgePrefixes}) — the "small decisive remainder" the retention
 * purge commits as one fenced atomic batch after range-deleting the history: the
 * state row, current checkpoint, headers, timers, search-attribute and tag index
 * rows, update requests/responses, fleet-event links (and their scattered
 * `fleet-event:{seq}` payloads, which are NOT contiguous so cannot be
 * range-deleted). The visibility-index transition is appended by the caller.
 */
export async function buildWorkflowPurgeRemainderDeleteOperations(
  internals: EngineInternals,
  state: WorkflowState,
): Promise<BatchOperation[]> {
  const attributeBytes = await internals.storage.get(KEYS.attribute(state.id));
  const deleteOperations = buildWorkflowIndexDeleteOperations(state, attributeBytes);
  const deleteKeys = await collectWorkflowPurgeRemainderDeleteKeys(internals, state);
  appendKeyDeleteOperations(deleteOperations, deleteKeys);
  return deleteOperations;
}

/**
 * The keys under the high-cardinality history prefixes
 * ({@link workflowPurgePrefixes}), enumerated. Used only to reassemble the
 * complete delete-set for the atomic `onTerminalConflict: 'start-new'` restart
 * path; the retention purge range-deletes these prefixes instead of enumerating
 * them.
 */
export async function collectWorkflowPrefixSweepDeleteOperations(
  storage: WeftStorage,
  workflowId: string,
): Promise<BatchOperation[]> {
  const operations: BatchOperation[] = [];
  for (const prefix of workflowPurgePrefixes(workflowId)) {
    for (const key of await collectKeysForPrefix(storage, prefix)) {
      operations.push({ type: 'delete', key });
    }
  }
  return operations;
}

/**
 * The high-cardinality, contiguous, workflow-owned key prefixes a purge deletes.
 * The retention purge range-deletes each of these (one SQL DELETE on Postgres);
 * the restart path enumerates them via
 * {@link collectWorkflowPrefixSweepDeleteOperations}.
 */
export function workflowPurgePrefixes(workflowId: string): string[] {
  const encodedWorkflowId = encodeStorageKeyComponent(workflowId);
  return [
    `wf:${encodedWorkflowId}:ckpt:`,
    // Compacted-checkpoint timeline entries (`wf:{id}:timeline:{step}`). These
    // are read back during checkpoint reconstruction (checkpoint-reads.ts), so a
    // stale entry left behind after purge would let a reused id — e.g. an
    // `onTerminalConflict: 'start-new'` restart — read the prior run's timeline.
    `wf:${encodedWorkflowId}:timeline:`,
    `ev:${encodedWorkflowId}:`,
    `sig:${encodedWorkflowId}:`,
    `review:${encodedWorkflowId}:`,
    `offload:${encodedWorkflowId}:`,
    `archive:${encodedWorkflowId}:`,
    `blob:${encodedWorkflowId}:`,
    `state:execution:${encodedWorkflowId}:`,
    `tool-effect:${encodedWorkflowId}:`,
    `upk:${encodedWorkflowId}:`,
    `actrec:v1:${encodedWorkflowId}:`,
    asyncActivityWorkflowPrefix(workflowId),
    `sigres:v1:${encodedWorkflowId}:`,
  ];
}

function buildWorkflowIndexDeleteOperations(
  state: WorkflowState,
  attributeBytes: Uint8Array | null,
): BatchOperation[] {
  return [
    ...buildSearchAttributeDeleteOperations(state.id, attributeBytes),
    ...buildTagIndexDeleteOperations(state),
  ];
}

function buildSearchAttributeDeleteOperations(
  workflowId: string,
  attributeBytes: Uint8Array | null,
): BatchOperation[] {
  if (!attributeBytes) return [];
  const currentAttributes = decode(attributeBytes) as Record<string, SearchAttributeValue>;
  return buildIndexOperations(workflowId, currentAttributes, {}).filter(isDeleteOperation);
}

function buildTagIndexDeleteOperations(state: WorkflowState): BatchOperation[] {
  return buildWorkflowTagIndexOperations(
    state.id,
    normalizeWorkflowTags(state.tags),
    undefined,
  ).filter(isDeleteOperation);
}

function isDeleteOperation(operation: BatchOperation): operation is BatchOperation {
  return operation.type === 'delete';
}

/**
 * The individual (non-prefix-sweep) delete keys a purge owns: the base workflow
 * keys, execution-deadline and terminal-cleanup timers, schedule-run history,
 * update requests/responses, and the scattered fleet-event payload keys behind
 * the fleet-event links. The high-cardinality `wf:{id}:*` / `ev:{id}:` history
 * prefixes are deliberately EXCLUDED here — they are range-deleted separately
 * (see {@link workflowPurgePrefixes}).
 */
async function collectWorkflowPurgeRemainderDeleteKeys(
  internals: EngineInternals,
  state: WorkflowState,
): Promise<Set<string>> {
  const workflowId = state.id;
  const deleteKeys = buildBaseWorkflowDeleteKeys(state);
  addExecutionDeadlineDeleteKeys(deleteKeys, state);
  addTerminalCleanupDeleteKey(deleteKeys, state);
  await addScheduleRunHistoryDeleteKeys(internals.storage, deleteKeys, workflowId);
  await addUpdateRequestDeleteKeys(internals.storage, deleteKeys, workflowId);
  await addWorkflowLinkedFleetEventDeleteKeys(internals.storage, deleteKeys, workflowId);
  return deleteKeys;
}

async function addScheduleRunHistoryDeleteKeys(
  storage: WeftStorage,
  deleteKeys: Set<string>,
  workflowId: string,
): Promise<void> {
  const linkKey = KEYS.scheduleRunLink(workflowId);
  const linkBytes = await storage.get(linkKey);
  deleteKeys.add(linkKey);
  if (linkBytes === null) return;

  const metadata = decodeScheduleRunMetadata(linkBytes);
  if (metadata !== null) {
    deleteKeys.add(KEYS.scheduleRunBySchedule(metadata.id, workflowId));
  }
}

function buildBaseWorkflowDeleteKeys(state: WorkflowState): Set<string> {
  const keys = new Set([
    KEYS.workflow(state.id),
    KEYS.checkpoint(state.id),
    KEYS.workflowHeaders(state.id),
    KEYS.terminalCleanupNeeded(state.id),
    KEYS.workflowConcurrencyHolder(state.id),
    KEYS.scheduleRun(state.id),
    // The "expects services" marker lives under its own `wf-has-services:`
    // prefix (not `wf:{id}:`), so the prefix sweep below misses it. Delete it
    // explicitly, else a purge + id reuse leaves a stale marker that would make
    // recovery re-provision services for a run that never had them.
    KEYS.workflowHasServices(state.id),
    // The finalizer payload (`wf-finalizer-state:`) and the teardown-owed marker
    // (`wf-teardown-needed:`) live under their own prefixes, not `wf:{id}:`, so the
    // prefix sweep below misses them — delete them explicitly. Purge only reaches a
    // workflow once teardown is done (`shouldPurgeWorkflowState` gates on the owed
    // marker being absent), so by here these are normally already gone; including
    // them is the idempotent backstop for any residue. The dead-letter record
    // (`wf-teardown-deadletter:`) is intentionally NOT listed — it is the durable
    // operator trail for a leaked resource and must outlive purge.
    KEYS.finalizerState(state.id),
    KEYS.teardownOwed(state.id),
    // Successful finalizer outcomes belong to the purged run. Dead-letter records
    // intentionally remain as leak evidence and are run-token qualified on read.
    KEYS.teardownSucceeded(state.id),
    KEYS.attribute(state.id),
    KEYS.terminalWorkflow(state.updatedAt, state.id),
  ]);
  if (state.parentWorkflowId !== undefined) {
    keys.add(
      KEYS.childWorkflowByParent(
        state.parentWorkflowId,
        state.parentWorkflowExecutionToken,
        state.id,
      ),
    );
  }
  return keys;
}

function addExecutionDeadlineDeleteKeys(deleteKeys: Set<string>, state: WorkflowState): void {
  if (state.executionDeadline === undefined) return;
  deleteKeys.add(KEYS.deadline(state.executionDeadline, state.id));
  deleteKeys.add(`timer-idx:deadline:${state.id}`);
}

function addTerminalCleanupDeleteKey(deleteKeys: Set<string>, state: WorkflowState): void {
  if (state.terminalCleanupToken === undefined) return;
  const terminalCleanupTimerId = createTerminalCleanupTimerId(
    shouldCleanupTerminalOutputArtifacts(state),
    state.terminalCleanupToken,
  );
  deleteKeys.add(
    KEYS.terminalCleanup(state.updatedAt + TERMINAL_CLEANUP_DELAY_MS, terminalCleanupTimerId),
  );
}

function shouldCleanupTerminalOutputArtifacts(state: WorkflowState): boolean {
  return state.status === 'cancelled' || state.status === 'timed-out';
}

async function addUpdateRequestDeleteKeys(
  storage: WeftStorage,
  deleteKeys: Set<string>,
  workflowId: string,
): Promise<void> {
  const updateRequestPrefix = KEYS.updatePrefix(workflowId);
  const updateRequestKeys = await collectKeysForPrefix(storage, updateRequestPrefix);
  for (const key of updateRequestKeys) {
    deleteKeys.add(key);
    addUpdateResponseDeleteKey(deleteKeys, updateRequestPrefix, key);
  }
}

function addUpdateResponseDeleteKey(
  deleteKeys: Set<string>,
  updateRequestPrefix: string,
  updateRequestKey: string,
): void {
  const updateId = updateRequestKey.slice(updateRequestPrefix.length);
  if (updateId.length > 0) deleteKeys.add(KEYS.updateResponse(updateId));
}

async function addWorkflowLinkedFleetEventDeleteKeys(
  storage: WeftStorage,
  deleteKeys: Set<string>,
  workflowId: string,
): Promise<void> {
  const prefix = KEYS.fleetEventByWorkflowPrefix(workflowId);
  for await (const [key] of storage.scan(prefix)) {
    deleteKeys.add(key);
    const sequence = parseFleetEventSequenceFromWorkflowIndexKey(prefix, key);
    if (sequence !== null) deleteKeys.add(KEYS.fleetEvent(sequence));
  }
}

function parseFleetEventSequenceFromWorkflowIndexKey(prefix: string, key: string): number | null {
  if (!key.startsWith(prefix)) return null;
  const rawSequence = key.slice(prefix.length);
  if (!/^\d+$/.test(rawSequence)) return null;
  const sequence = Number(rawSequence);
  return Number.isSafeInteger(sequence) ? sequence : null;
}

function appendKeyDeleteOperations(
  deleteOperations: BatchOperation[],
  deleteKeys: Iterable<string>,
): void {
  for (const key of deleteKeys) deleteOperations.push({ type: 'delete', key });
}

async function collectKeysForPrefix(storage: WeftStorage, prefix: string): Promise<string[]> {
  const keys: string[] = [];
  for await (const key of storageKeys(storage, prefix)) keys.push(key);
  return keys;
}
