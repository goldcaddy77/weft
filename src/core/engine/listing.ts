import { KEYS } from '../../storage/interface.ts';
import { decode, encode } from '../codec.ts';
import { buildIndexOperations, validateAttributeType } from '../search-attributes.ts';
import type {
  ListFilter,
  PaginatedResult,
  SearchAttributeValue,
  WorkflowState,
  WorkflowSummary,
} from '../types.ts';
import { normalizeWorkflowTags } from '../workflow-tags.ts';
import {
  mutateWorkflowTags,
  resolveConstrainedIds,
  validateAttributeValueSizes,
} from './attributes-tags.ts';
import type { EngineInternals } from './internals.ts';
import { resolveListCandidateIds } from './list-candidate-resolution.ts';
import { matchesListFilter, paginateWorkflowSummaries } from './state-utilities.ts';
import { decodeWorkflowState, normalizeBulkFilterNumber } from './validation.ts';
import { MAX_LIST_SCAN_ROWS, WorkflowListScanCapExceededError } from './workflow-indexes.ts';

export const BULK_OPERATION_BATCH_SIZE = 1000;

/** List workflow summaries that match a filter, using indexes when available. */
// oxlint-disable-next-line complexity -- ID:core-engine-list-complexity
export async function list(
  internals: EngineInternals,
  filter?: ListFilter,
): Promise<PaginatedResult<WorkflowSummary>> {
  const normalizedTagFilters = normalizeWorkflowTags(filter?.tags);
  const constrainedIds = await resolveListCandidateIds(internals, filter, normalizedTagFilters);

  const items: WorkflowSummary[] = [];

  if (constrainedIds !== null) {
    const orderedIds = [...constrainedIds];
    if (orderedIds.length > MAX_LIST_SCAN_ROWS) {
      throw new WorkflowListScanCapExceededError(MAX_LIST_SCAN_ROWS);
    }
    const stateBytesList = await Promise.all(
      orderedIds.map((workflowId) => internals.storage.get(KEYS.workflow(workflowId))),
    );

    for (const stateBytes of stateBytesList) {
      if (!stateBytes) continue;

      const state = decodeWorkflowState(stateBytes);
      if (!matchesListFilter(state, filter, constrainedIds, normalizedTagFilters)) continue;

      items.push(summaryFromState(state));
    }
    return paginateWorkflowSummaries(sortSummariesByCreatedAtDescending(items), filter);
  }

  let scanned = 0;
  for await (const [key, value] of internals.storage.scan('wf:')) {
    if (!isTopLevelWorkflowStateKey(key)) continue;

    scanned += 1;
    if (scanned > MAX_LIST_SCAN_ROWS) {
      throw new WorkflowListScanCapExceededError(MAX_LIST_SCAN_ROWS);
    }

    const state = decodeWorkflowState(value);
    if (!matchesListFilter(state, filter, constrainedIds, normalizedTagFilters)) continue;

    items.push(summaryFromState(state));
  }

  return paginateWorkflowSummaries(sortSummariesByCreatedAtDescending(items), filter);
}

function summaryFromState(state: WorkflowState): WorkflowSummary {
  return {
    id: state.id,
    type: state.type,
    status: state.status,
    ...(state.tags !== undefined && { tags: state.tags }),
    version: state.version,
    createdAt: state.createdAt,
    updatedAt: state.updatedAt,
    ...(state.tenant?.id !== undefined && { tenantId: state.tenant.id }),
    ...(state.executionDeadline !== undefined && { executionDeadline: state.executionDeadline }),
    ...(state.failureCategory !== undefined &&
      state.failureCategory !== null && { failureCategory: state.failureCategory }),
  };
}

/**
 * Stable canonical ordering: `createdAt` descending with `id` ascending as
 * the tiebreaker. Applied after the constrained-id intersection and before
 * pagination slices the page out.
 */
function sortSummariesByCreatedAtDescending(items: WorkflowSummary[]): WorkflowSummary[] {
  return items.toSorted((left, right) => {
    if (left.createdAt !== right.createdAt) return right.createdAt - left.createdAt;
    if (left.id < right.id) return -1;
    if (left.id > right.id) return 1;
    return 0;
  });
}

/** Stream decoded workflow states that match a list filter. */
export async function* streamWorkflowStates(
  internals: EngineInternals,
  filter?: ListFilter,
): AsyncGenerator<WorkflowState> {
  const normalizedTagFilters = normalizeWorkflowTags(filter?.tags);
  const constrainedIds = await resolveConstrainedIds(internals, filter, normalizedTagFilters);

  if (constrainedIds !== null) {
    for (const workflowId of constrainedIds) {
      const stateBytes = await internals.storage.get(KEYS.workflow(workflowId));
      if (!stateBytes) continue;

      const state = decodeWorkflowState(stateBytes);
      if (!matchesListFilter(state, filter, constrainedIds, normalizedTagFilters)) continue;
      yield state;
    }

    return;
  }

  for await (const [key, value] of internals.storage.scan('wf:')) {
    if (!isTopLevelWorkflowStateKey(key)) continue;

    const state = decodeWorkflowState(value);
    if (!matchesListFilter(state, filter, constrainedIds, normalizedTagFilters)) continue;
    yield state;
  }
}

/** Stream decoded workflow states in fixed-size batches for bulk operations. */
// oxlint-disable-next-line complexity -- ID:core-engine-line-3045-complexity
export async function* streamWorkflowStateBatches(
  internals: EngineInternals,
  filter?: ListFilter,
): AsyncGenerator<WorkflowState[]> {
  let remainingOffset = normalizeBulkFilterNumber(filter?.offset, 'offset') ?? 0;
  let remainingLimit = normalizeBulkFilterNumber(filter?.limit, 'limit');

  if (remainingLimit === 0) {
    return;
  }

  let batch: WorkflowState[] = [];

  for await (const state of streamWorkflowStates(internals, filter)) {
    if (remainingOffset > 0) {
      remainingOffset -= 1;
      continue;
    }

    batch.push(state);

    if (remainingLimit !== undefined) {
      remainingLimit -= 1;
    }

    if (batch.length === BULK_OPERATION_BATCH_SIZE) {
      yield batch;
      batch = [];
    }

    if (remainingLimit === 0) {
      break;
    }
  }

  if (batch.length > 0) {
    yield batch;
  }
}

/** Retrieve search attributes for a workflow. */
export async function getAttributes(
  internals: EngineInternals,
  workflowId: string,
): Promise<Record<string, SearchAttributeValue> | null> {
  const bytes = await internals.storage.get(KEYS.attribute(workflowId));
  if (!bytes) return null;
  return decode(bytes) as Record<string, SearchAttributeValue>;
}

/** Merge search attributes into a workflow's existing attributes, updating the index. */
export async function setAttributes(
  internals: EngineInternals,
  workflowId: string,
  attributes: Record<string, SearchAttributeValue>,
): Promise<void> {
  // Validate against the registration's schema if one exists
  const stateBytes = await internals.storage.get(KEYS.workflow(workflowId));
  if (stateBytes) {
    const state = decodeWorkflowState(stateBytes);
    const registration = internals.registrations.get(state.type);
    if (registration?.searchAttributes) {
      const schema = registration.searchAttributes;
      for (const [key, value] of Object.entries(attributes)) {
        if (!(key in schema)) {
          throw new Error(
            `Unknown search attribute "${key}". Registered attributes: ${Object.keys(schema).join(', ')}`,
          );
        }
        validateAttributeType(key, value, schema[key]!);
      }
    }
  }

  validateAttributeValueSizes(attributes);

  const existingBytes = await internals.storage.get(KEYS.attribute(workflowId));
  const existing: Record<string, SearchAttributeValue> = existingBytes
    ? (decode(existingBytes) as Record<string, SearchAttributeValue>)
    : {};

  const merged: Record<string, SearchAttributeValue> = { ...existing, ...attributes };

  const indexOperations = buildIndexOperations(workflowId, existing, merged);

  const operations = [
    { type: 'put' as const, key: KEYS.attribute(workflowId), value: encode(merged) },
    ...indexOperations,
  ];

  await internals.storage.batch(operations);
}

/** Add one or more tags to a workflow. */
export async function addTags(
  internals: EngineInternals,
  workflowId: string,
  ...tags: string[]
): Promise<void> {
  await mutateWorkflowTags(internals, workflowId, tags, 'add');
}

/** Remove one or more tags from a workflow. */
export async function removeTags(
  internals: EngineInternals,
  workflowId: string,
  ...tags: string[]
): Promise<void> {
  await mutateWorkflowTags(internals, workflowId, tags, 'remove');
}

function isTopLevelWorkflowStateKey(key: string): boolean {
  const idPart = key.slice(3);
  return !idPart.includes(':');
}
