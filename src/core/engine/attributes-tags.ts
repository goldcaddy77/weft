import type { BatchOperation, ScanOptions } from '../../storage/interface.ts';
import {
  KEYS,
  encodeStorageKeyComponent,
  tryDecodeStorageKeyComponent,
} from '../../storage/interface.ts';
import { assertScopedBulkWorkflowFilter } from '../bulk-workflow-filter.ts';
import { decode, encode } from '../codec.ts';
import {
  buildIndexOperations,
  encodeAttributeValue,
  searchAttributeName,
  validateEncodedValueSize,
} from '../search-attributes.ts';
import { assertWorkflowTagCount, coerceStartWorkflowTags } from '../start-workflow-validation.ts';
import type {
  AttributeFilter,
  BulkTagResult,
  ListFilter,
  SearchAttributeValue,
  WorkflowState,
  WorkflowStatus,
} from '../types.ts';
import { buildWorkflowTagIndexOperations, normalizeWorkflowTags } from '../workflow-tags.ts';
import { WorkflowNotFoundError } from './errors.ts';
import type { EngineInternals } from './internals.ts';
import { intersectIdentifierSets, matchesListFilter } from './state-utilities.ts';
import { commitWorkflowStateOperations, runSerializedWorkflowStateWrite } from './storage-io.ts';
import {
  decodeWorkflowState,
  isTerminalWorkflowStatus,
  normalizeBulkFilterNumber,
} from './validation.ts';
import { buildWorkflowVisibilityIndexTransition } from './workflow-indexes.ts';

const ATTRIBUTE_SCAN_CONCURRENCY = 8;
const EMPTY_STORAGE_VALUE = new Uint8Array(0);

type WorkflowStateUpdateOptions = {
  allowedStatuses?: readonly WorkflowStatus[];
  buildAdditionalOperations?: (previousState: WorkflowState, updatedAt: number) => BatchOperation[];
  releaseTenantQuota?: boolean;
};

type WorkflowStateUpdateResult = {
  previousState: WorkflowState;
  updatedAt: number;
};

/** Resolve the indexed workflow IDs implied by tag and search-attribute filters. */
// oxlint-disable-next-line complexity -- ID:core-engine-resolve-constrained-ids-complexity
export async function resolveConstrainedIds(
  internals: EngineInternals,
  filter: ListFilter | undefined,
  normalizedTagFilters: readonly string[] | undefined,
): Promise<Set<string> | null> {
  const attributeFilters = filter?.attributes;
  const hasAttributeFilters = attributeFilters !== undefined && attributeFilters.length > 0;
  const hasTagFilters = normalizedTagFilters !== undefined && normalizedTagFilters.length > 0;

  if (!hasAttributeFilters && !hasTagFilters) {
    return null;
  }

  // Bound concurrency so a request with many attribute filters can't
  // saturate a connection-limited storage backend with N parallel scans.
  // Inline worker-pool loop: each worker pulls the next unclaimed filter
  // and writes the result into its original index. JavaScript is
  // single-threaded, so the `nextIndex += 1` read-modify-write is atomic
  // across event-loop yields.
  const queries: Array<() => Promise<Set<string>>> = [];
  if (normalizedTagFilters) {
    for (const tag of normalizedTagFilters) {
      queries.push(() => queryTagIndex(internals, tag));
    }
  }
  if (attributeFilters) {
    for (const attributeFilter of attributeFilters) {
      queries.push(() => queryAttributeIndex(internals, attributeFilter));
    }
  }

  const idSets: Array<Set<string> | undefined> = Array.from({ length: queries.length });
  const workerLimit = Math.max(1, Math.min(ATTRIBUTE_SCAN_CONCURRENCY, queries.length));
  let nextIndex = 0;
  const runWorker = async (): Promise<void> => {
    while (true) {
      const currentIndex = nextIndex;
      nextIndex += 1;
      if (currentIndex >= queries.length) return;
      idSets[currentIndex] = await queries[currentIndex]!();
    }
  };
  const workers: Promise<void>[] = [];
  for (let workerIndex = 0; workerIndex < workerLimit; workerIndex += 1) {
    workers.push(runWorker());
  }
  await Promise.all(workers);

  const completedIdSets: Set<string>[] = [];
  for (const idSet of idSets) {
    if (idSet === undefined) {
      throw new Error('Attribute index query did not produce a workflow ID set.');
    }
    completedIdSets.push(idSet);
  }

  return intersectIdentifierSets(completedIdSets);
}

/** Query a single search-attribute index filter and return matching workflow IDs. */
// oxlint-disable-next-line complexity -- ID:core-engine-query-attribute-index-complexity
export async function queryAttributeIndex(
  internals: EngineInternals,
  filter: AttributeFilter,
): Promise<Set<string>> {
  const ids = new Set<string>();
  const attributeName = searchAttributeName(filter.key);
  const prefix = `idx:${attributeName}:`;

  if (filter.value !== undefined) {
    // Exact match: scan idx:{name}:{encodedValue}: prefix
    const encodedValue = encodeAttributeValue(filter.value);
    const exactPrefix = `idx:${attributeName}:${encodedValue}:`;
    for await (const [key] of internals.storage.scan(exactPrefix)) {
      // Key format: idx:{name}:{encodedValue}:{workflowId}
      const workflowId = tryDecodeStorageKeyComponent(key.slice(exactPrefix.length));
      if (workflowId !== null) {
        ids.add(workflowId);
      }
    }
  } else {
    // Range scan with gte/lte/gt/lt boundaries
    const scanOptions: ScanOptions = {};
    if (filter.gte !== undefined) {
      scanOptions.gte = `idx:${attributeName}:${encodeAttributeValue(filter.gte)}:`;
    }
    if (filter.gt !== undefined) {
      scanOptions.gt = `idx:${attributeName}:${encodeAttributeValue(filter.gt)}:\xff`;
    }
    if (filter.lte !== undefined) {
      // Use a boundary that includes all workflow IDs for the lte value
      const encodedLte = encodeAttributeValue(filter.lte);
      // Append a character after the last ':' to ensure we include all IDs under this value
      scanOptions.lte = `idx:${attributeName}:${encodedLte}:\xff`;
    }
    if (filter.lt !== undefined) {
      scanOptions.lt = `idx:${attributeName}:${encodeAttributeValue(filter.lt)}:`;
    }

    for await (const [key] of internals.storage.scan(prefix, scanOptions)) {
      // Key format: idx:{name}:{encodedValue}:{workflowId}
      // Extract workflowId: everything after the last ':'
      const afterPrefix = key.slice(prefix.length);
      const lastColon = afterPrefix.lastIndexOf(':');
      if (lastColon >= 0) {
        const workflowId = tryDecodeStorageKeyComponent(afterPrefix.slice(lastColon + 1));
        if (workflowId !== null) {
          ids.add(workflowId);
        }
      }
    }
  }

  return ids;
}

/** Query the workflow tag index and return matching workflow IDs. */
export async function queryTagIndex(internals: EngineInternals, tag: string): Promise<Set<string>> {
  const ids = new Set<string>();
  const prefix = `tag:${encodeStorageKeyComponent(tag)}:`;

  for await (const [key] of internals.storage.scan(prefix)) {
    const workflowId = tryDecodeStorageKeyComponent(key.slice(prefix.length));
    if (workflowId !== null) {
      ids.add(workflowId);
    }
  }

  return ids;
}

/** Delete a workflow's stored search attributes and their secondary index entries. */
export async function cleanupAttributeIndex(
  internals: EngineInternals,
  workflowId: string,
  currentAttributes?: Record<string, SearchAttributeValue>,
): Promise<void> {
  if (currentAttributes === undefined) {
    const attributeBytes = await internals.storage.get(KEYS.attribute(workflowId));
    if (!attributeBytes) return;

    currentAttributes = decode(attributeBytes) as Record<string, SearchAttributeValue>;
  }

  const deleteOperations = buildIndexOperations(workflowId, currentAttributes, {});

  // Delete the attribute record itself along with all index entries
  deleteOperations.push({ type: 'delete', key: KEYS.attribute(workflowId) });

  if (deleteOperations.length > 0) {
    await internals.storage.batch(deleteOperations);
  }
}

/**
 * Keep engine-managed terminal attributes queryable after the broader
 * attribute cleanup removes user-defined search attributes.
 */
export function buildRetainedTerminalSearchAttributes(
  currentAttributes: Record<string, SearchAttributeValue>,
  additionalAttributes?: Record<string, SearchAttributeValue>,
): Record<string, SearchAttributeValue> {
  const retainedAttributes = Object.fromEntries(
    Object.entries(currentAttributes).filter(([key]) => key.startsWith('weft:')),
  ) as Record<string, SearchAttributeValue>;

  return {
    ...retainedAttributes,
    ...additionalAttributes,
  };
}

/** Write retained terminal search attributes and their index entries. */
export async function writeRetainedTerminalSearchAttributes(
  internals: EngineInternals,
  workflowId: string,
  attributes: Record<string, SearchAttributeValue>,
): Promise<void> {
  if (Object.keys(attributes).length === 0) {
    return;
  }

  const indexOperations = buildIndexOperations(workflowId, {}, attributes);
  await internals.storage.batch([
    { type: 'put', key: KEYS.attribute(workflowId), value: encode(attributes) },
    ...indexOperations,
  ]);
}

/** Build secondary-index updates for terminal workflow state transitions. */
export function buildTerminalWorkflowIndexOperations(
  previousState: WorkflowState,
  nextState: WorkflowState,
): BatchOperation[] {
  const operations: BatchOperation[] = [];

  if (isTerminalWorkflowStatus(previousState.status)) {
    operations.push({
      type: 'delete',
      key: KEYS.terminalWorkflow(previousState.updatedAt, previousState.id),
    });
  }

  if (isTerminalWorkflowStatus(nextState.status)) {
    operations.push({
      type: 'put',
      key: KEYS.terminalWorkflow(nextState.updatedAt, nextState.id),
      value: EMPTY_STORAGE_VALUE,
    });
  }

  return operations;
}

/** Apply a serialized workflow-state update and return the previous state metadata. */
export async function updateWorkflowState(
  internals: EngineInternals,
  workflowId: string,
  updates: Partial<WorkflowState>,
  options: WorkflowStateUpdateOptions = {},
): Promise<WorkflowStateUpdateResult | null> {
  return await runSerializedWorkflowStateWrite(internals, workflowId, async () => {
    const bytes = await internals.storage.get(KEYS.workflow(workflowId));
    if (!bytes) {
      return null;
    }

    const state = decodeWorkflowState(bytes);
    if (options.allowedStatuses && !options.allowedStatuses.includes(state.status)) {
      return null;
    }

    const updatedAt = internals.options.getNow();
    const updated = {
      ...state,
      ...updates,
      updatedAt,
    };
    const additionalOperations = options.buildAdditionalOperations?.(state, updatedAt) ?? [];
    const commitOptions =
      options.releaseTenantQuota === true ? { releaseTenantQuota: true } : undefined;

    await commitWorkflowStateOperations(
      internals,
      state,
      [
        ...buildTerminalWorkflowIndexOperations(state, updated),
        { type: 'put', key: KEYS.workflow(workflowId), value: encode(updated) },
        ...buildWorkflowVisibilityIndexTransition(workflowId, state, updated).batchOps,
        ...additionalOperations,
      ],
      commitOptions,
    );

    return {
      previousState: state,
      updatedAt,
    };
  });
}

/** Add or remove tags for a single workflow under the serialized state-write lock. */
export async function mutateWorkflowTags(
  internals: EngineInternals,
  workflowId: string,
  tags: string[],
  mode: 'add' | 'remove',
): Promise<boolean> {
  // oxlint-disable-next-line complexity -- ID:core-engine-mutate-workflow-tags-complexity
  return await runSerializedWorkflowStateWrite(internals, workflowId, async () => {
    const bytes = await internals.storage.get(KEYS.workflow(workflowId));
    if (!bytes) {
      throw new WorkflowNotFoundError(workflowId);
    }

    const state = decodeWorkflowState(bytes);
    const currentTags = normalizeWorkflowTags(state.tags) ?? [];
    const requestedTags = normalizeStartWorkflowTags(tags, 'Workflow tags') ?? [];
    if (requestedTags.length === 0) {
      return false;
    }

    const nextTagSet = new Set(currentTags);
    for (const tag of requestedTags) {
      if (mode === 'add') {
        nextTagSet.add(tag);
      } else {
        nextTagSet.delete(tag);
      }
    }

    const nextTags = normalizeWorkflowTags([...nextTagSet]);
    if (mode === 'add' && nextTags !== undefined) {
      assertWorkflowTagCount(nextTags, 'Workflow tags');
    }
    const unchanged =
      currentTags.length === (nextTags?.length ?? 0) &&
      currentTags.every((tag, index) => tag === nextTags?.[index]);
    if (unchanged) {
      return false;
    }

    const updatedState: WorkflowState = {
      ...state,
      updatedAt: internals.options.getNow(),
    };
    if (nextTags !== undefined) {
      updatedState.tags = nextTags;
    } else {
      delete updatedState.tags;
    }

    await internals.storage.batch([
      ...buildTerminalWorkflowIndexOperations(state, updatedState),
      { type: 'put', key: KEYS.workflow(workflowId), value: encode(updatedState) },
      ...buildWorkflowVisibilityIndexTransition(workflowId, state, updatedState).batchOps,
      ...buildWorkflowTagIndexOperations(workflowId, currentTags, nextTags),
    ]);

    return true;
  });
}

/** Add or remove tags for every workflow selected by a scoped bulk filter. */
export async function bulkMutateWorkflowTags(
  internals: EngineInternals,
  filter: ListFilter,
  tags: string[],
  mode: 'add' | 'remove',
): Promise<BulkTagResult> {
  assertScopedBulkWorkflowFilter(filter);
  const workflowIdsToMutate = await snapshotMatchingWorkflowIds(internals, filter);

  let modified = 0;
  for (const workflowId of workflowIdsToMutate) {
    let changed = false;
    try {
      changed = await mutateWorkflowTags(internals, workflowId, tags, mode);
    } catch (error) {
      if (!(error instanceof WorkflowNotFoundError)) {
        throw error;
      }
    }

    if (changed) {
      modified += 1;
    }
  }

  return { modified };
}

/** Validate that all attribute values in a record fit within the storage key size limit. */
export function validateAttributeValueSizes(
  attributes: Record<string, SearchAttributeValue>,
): void {
  for (const [key, value] of Object.entries(attributes)) {
    if (Array.isArray(value)) {
      for (const element of value) {
        validateEncodedValueSize(encodeAttributeValue(element), key);
      }
    } else {
      validateEncodedValueSize(encodeAttributeValue(value), key);
    }
  }
}

function normalizeStartWorkflowTags(
  tags: unknown,
  fieldName = 'options.tags',
): string[] | undefined {
  if (tags === undefined) {
    return undefined;
  }

  return normalizeWorkflowTags(coerceStartWorkflowTags(tags, fieldName));
}

function isTopLevelWorkflowStateKey(key: string): boolean {
  const idPart = key.slice(3);
  return !idPart.includes(':');
}

async function* streamWorkflowStatesForSnapshot(
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

async function snapshotMatchingWorkflowIds(
  internals: EngineInternals,
  filter?: ListFilter,
): Promise<string[]> {
  const workflowIds: string[] = [];
  let remainingOffset = normalizeBulkFilterNumber(filter?.offset, 'offset') ?? 0;
  let remainingLimit = normalizeBulkFilterNumber(filter?.limit, 'limit');

  if (remainingLimit === 0) {
    return workflowIds;
  }

  // Snapshot ids before mutating workflow state entries so storage scans
  // cannot skip or re-visit workflows when backends reorder after writes.
  for await (const state of streamWorkflowStatesForSnapshot(internals, filter)) {
    if (remainingOffset > 0) {
      remainingOffset -= 1;
      continue;
    }

    workflowIds.push(state.id);

    if (remainingLimit !== undefined) {
      remainingLimit -= 1;
    }

    if (remainingLimit === 0) {
      break;
    }
  }

  return workflowIds;
}
