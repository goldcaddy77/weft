/**
 * `engine.aggregate()` — group-by counts over a {@link ListFilter}.
 * Shares the candidate-resolution path with `engine.list()` so the
 * watermark gate, scan cap, and indexed narrowing behave identically.
 *
 * @module core/engine/aggregate
 */

import { KEYS } from '../../storage/interface.ts';
import {
  AGGREGATE_DEFAULT_LIMIT,
  AggregateDistinctKeyCapExceededError,
  MAX_AGGREGATE_DISTINCT_KEYS,
  normalizeAggregateOptions,
  type AggregateGroupBy,
  type AggregateOptions,
} from '../aggregate-validation.ts';
import { decode } from '../codec.ts';
import { normalizeListFilter } from '../list-filter-validation.ts';
import type { ListFilter, SearchAttributeValue, WorkflowState } from '../types.ts';
import { normalizeWorkflowTags } from '../workflow-tags.ts';
import type { EngineInternals } from './internals.ts';
import { resolveListCandidateIds } from './list-candidate-resolution.ts';
import { intersectIdentifierSets, matchesListFilter } from './state-utilities.ts';
import { decodeWorkflowState } from './validation.ts';
import { MAX_LIST_SCAN_ROWS, WorkflowListScanCapExceededError } from './workflow-indexes.ts';
import { isTopLevelWorkflowStateKey, resolveConstrainedIds } from './workflow-state-stream.ts';

/** One group in an {@link AggregateResult}. `key === null` collects workflows missing the dimension. */
export type AggregateGroup = {
  key: string | null;
  count: number;
};

/**
 * Result of `engine.aggregate()`. `total` is the count of candidates that
 * passed filtering; `groups` is sorted by `count desc, key asc` and
 * truncated to the caller's `limit`. `truncated` is `true` when there
 * were more groups than `limit` allowed.
 */
export type AggregateResult = {
  total: number;
  groups: AggregateGroup[];
  truncated: boolean;
};

const ATTRIBUTE_VALUE_TO_KEY = (value: SearchAttributeValue | undefined): string | null => {
  if (value === undefined || value === null) return null;
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.join(',');
  return String(value);
};

/**
 * Resolve the dimension key for one workflow. For attribute-backed
 * dimensions (failureCategory, `{ attribute }`), reads the attribute
 * record; missing entries bucket as `null`. For structural dimensions,
 * reads directly off the loaded state.
 */
async function resolveDimensionKey(
  internals: EngineInternals,
  state: WorkflowState,
  groupBy: AggregateGroupBy,
): Promise<string | null> {
  if (groupBy === 'status') return state.status;
  if (groupBy === 'type') return state.type;
  if (groupBy === 'tenant') return state.tenant?.id ?? null;

  const attributeName = groupBy === 'failureCategory' ? 'failureCategory' : groupBy.attribute;
  const attributeBytes = await internals.storage.get(KEYS.attribute(state.id));
  if (!attributeBytes) return null;
  const attributes = decode(attributeBytes) as Record<string, SearchAttributeValue>;
  return ATTRIBUTE_VALUE_TO_KEY(attributes[attributeName]);
}

/**
 * Validate an attribute-name `groupBy` against the engine's
 * `SearchAttributeSchema` (when configured). Runs before any storage
 * access so unknown attributes fail fast with a validation error.
 */
function validateAttributeDimension(internals: EngineInternals, attributeName: string): void {
  // When at least one registration declares a search-attribute schema, the
  // requested attribute must be declared somewhere — otherwise the result
  // would always be all-null and silently mislead the caller.
  let anySchemaDeclared = false;
  let attributeFound = false;
  for (const registration of internals.registrations.values()) {
    if (registration.searchAttributes !== undefined) {
      anySchemaDeclared = true;
      if (attributeName in registration.searchAttributes) {
        attributeFound = true;
        break;
      }
    }
  }
  if (anySchemaDeclared && !attributeFound) {
    throw new Error(
      `Unknown search attribute "${attributeName}". Aggregate groupBy requires a declared attribute.`,
    );
  }
}

/**
 * Aggregate workflows by a single dimension. The filter shape matches
 * `engine.list()`; `limit` and `offset` on the filter are ignored
 * (aggregation always considers every candidate that passes the rest of
 * the filter). The aggregate `limit` bounds the returned groups instead.
 */
// oxlint-disable-next-line complexity -- ID:core-engine-aggregate-complexity
export async function aggregate(
  internals: EngineInternals,
  filter: ListFilter | undefined,
  options: AggregateOptions,
): Promise<AggregateResult> {
  // Re-validate so in-process callers receive the same diagnostics as the
  // server operation, even when they construct the input by hand.
  const normalizedFilter = normalizeListFilter({ ...filter, limit: undefined, offset: undefined });
  const normalizedOptions = normalizeAggregateOptions(options);
  const { groupBy } = normalizedOptions;
  const requestedLimit = normalizedOptions.limit ?? AGGREGATE_DEFAULT_LIMIT;

  if (typeof groupBy === 'object') {
    validateAttributeDimension(internals, groupBy.attribute);
  }

  const normalizedTagFilters = normalizeWorkflowTags(normalizedFilter.tags);
  // The aggregate path resolves candidates exactly like `list()`. Reuse the
  // shared helper so the watermark gate, idPrefix scan, and new visibility
  // indexes apply consistently across both surfaces.
  const constrainedIds = await resolveListCandidateIds(
    internals,
    normalizedFilter,
    normalizedTagFilters,
  );

  const counts = new Map<string | null, number>();
  let total = 0;

  const accumulate = async (state: WorkflowState): Promise<void> => {
    const key = await resolveDimensionKey(internals, state, groupBy);
    const current = counts.get(key);
    if (current === undefined) {
      if (counts.size >= MAX_AGGREGATE_DISTINCT_KEYS) {
        throw new AggregateDistinctKeyCapExceededError(MAX_AGGREGATE_DISTINCT_KEYS);
      }
      counts.set(key, 1);
    } else {
      counts.set(key, current + 1);
    }
    total += 1;
  };

  if (constrainedIds !== null) {
    if (constrainedIds.size > MAX_LIST_SCAN_ROWS) {
      throw new WorkflowListScanCapExceededError(MAX_LIST_SCAN_ROWS);
    }
    for (const workflowId of constrainedIds) {
      const stateBytes = await internals.storage.get(KEYS.workflow(workflowId));
      if (!stateBytes) continue;
      const state = decodeWorkflowState(stateBytes);
      if (!matchesListFilter(state, normalizedFilter, constrainedIds, normalizedTagFilters)) {
        continue;
      }
      await accumulate(state);
    }
  } else {
    let scanned = 0;
    for await (const [key, value] of internals.storage.scan('wf:')) {
      if (!isTopLevelWorkflowStateKey(key)) continue;
      scanned += 1;
      if (scanned > MAX_LIST_SCAN_ROWS) {
        throw new WorkflowListScanCapExceededError(MAX_LIST_SCAN_ROWS);
      }
      const state = decodeWorkflowState(value);
      if (!matchesListFilter(state, normalizedFilter, null, normalizedTagFilters)) continue;
      await accumulate(state);
    }
  }

  const sortedGroups: AggregateGroup[] = [...counts.entries()]
    .map(([groupKey, count]) => ({ key: groupKey, count }))
    .toSorted((left, right) => {
      if (left.count !== right.count) return right.count - left.count;
      const leftKey = left.key ?? '';
      const rightKey = right.key ?? '';
      if (leftKey < rightKey) return -1;
      if (leftKey > rightKey) return 1;
      return 0;
    });

  const truncated = sortedGroups.length > requestedLimit;
  const groups = truncated ? sortedGroups.slice(0, requestedLimit) : sortedGroups;
  return { total, groups, truncated };
}

// Re-exports for callers that only need to discriminate result shape.
export type { AggregateGroupBy, AggregateOptions };
// Re-export so callers can attach `intersectIdentifierSets` to the public
// surface alongside the aggregate function if needed; harmless if unused.
export { intersectIdentifierSets, resolveConstrainedIds };
