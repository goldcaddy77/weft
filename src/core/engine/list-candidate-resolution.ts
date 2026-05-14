/**
 * Shared candidate-id resolver used by both `engine.list()` and
 * `engine.aggregate()`. Reads the visibility-index watermark once,
 * fans every supported filter dimension out to its query helper when
 * the watermark is current, and intersects the results with the
 * existing tag/attribute resolution.
 *
 * Returns `null` when no filter narrows the candidate set — the caller
 * falls back to a full `wf:` prefix scan with post-filtering.
 *
 * @module core/engine/list-candidate-resolution
 */

import type { FailureCategory, ListFilter } from '../types.ts';
import type { EngineInternals } from './internals.ts';
import { intersectIdentifierSets } from './state-utilities.ts';
import { getWorkflowVisibilityWatermark } from './workflow-indexes.ts';
import { queryAttributeIndex, resolveConstrainedIds } from './workflow-state-stream.ts';
import {
  queryWorkflowIdPrefixCandidates,
  queryWorkflowStatusIndex,
  queryWorkflowTenantIndex,
  queryWorkflowTimeRangeIndex,
  queryWorkflowTypeIndex,
} from './workflow-visibility-queries.ts';

// oxlint-disable-next-line complexity -- ID:core-engine-resolve-list-candidate-ids
export async function resolveListCandidateIds(
  internals: EngineInternals,
  filter: ListFilter | undefined,
  normalizedTagFilters: readonly string[] | undefined,
): Promise<Set<string> | null> {
  const [baseConstrainedIds, failureCategoryCandidateIds] = await Promise.all([
    resolveConstrainedIds(internals, filter, normalizedTagFilters),
    resolveFailureCategoryCandidateIds(internals, filter?.failureCategory),
  ]);

  const watermark = await getWorkflowVisibilityWatermark(internals.storage);
  if (watermark === 'stale') {
    // idPrefix is independent of the watermark — primary-key scan is always available.
    if (filter?.idPrefix !== undefined) {
      const candidates = await queryWorkflowIdPrefixCandidates(internals.storage, filter.idPrefix);
      return combineCandidateSets([baseConstrainedIds, failureCategoryCandidateIds, candidates]);
    }
    return combineCandidateSets([baseConstrainedIds, failureCategoryCandidateIds]);
  }

  const visibilityQueries: Array<Promise<Set<string>>> = [];

  if (filter?.status !== undefined) {
    const statuses = Array.isArray(filter.status) ? filter.status : [filter.status];
    visibilityQueries.push(queryWorkflowStatusIndex(internals.storage, statuses));
  }
  if (filter?.type !== undefined) {
    visibilityQueries.push(queryWorkflowTypeIndex(internals.storage, filter.type));
  }
  if (filter?.tenantId !== undefined) {
    visibilityQueries.push(queryWorkflowTenantIndex(internals.storage, filter.tenantId));
  }
  if (filter?.createdAt !== undefined) {
    visibilityQueries.push(
      queryWorkflowTimeRangeIndex(internals.storage, 'created', filter.createdAt),
    );
  }
  if (filter?.updatedAt !== undefined) {
    visibilityQueries.push(
      queryWorkflowTimeRangeIndex(internals.storage, 'updated', filter.updatedAt),
    );
  }
  if (filter?.executionDeadline !== undefined) {
    visibilityQueries.push(
      queryWorkflowTimeRangeIndex(internals.storage, 'deadline', filter.executionDeadline),
    );
  }
  if (filter?.idPrefix !== undefined) {
    visibilityQueries.push(queryWorkflowIdPrefixCandidates(internals.storage, filter.idPrefix));
  }

  if (visibilityQueries.length === 0) {
    return combineCandidateSets([baseConstrainedIds, failureCategoryCandidateIds]);
  }

  const visibilitySets = await Promise.all(visibilityQueries);
  return combineCandidateSets([baseConstrainedIds, failureCategoryCandidateIds, ...visibilitySets]);
}

async function resolveFailureCategoryCandidateIds(
  internals: EngineInternals,
  failureCategory: FailureCategory | readonly FailureCategory[] | undefined,
): Promise<Set<string> | null> {
  if (failureCategory === undefined) return null;

  const categories = Array.isArray(failureCategory) ? failureCategory : [failureCategory];
  const categorySets = await Promise.all(
    categories.map((category) =>
      queryAttributeIndex(internals, { key: 'failureCategory', value: category }),
    ),
  );

  const ids = new Set<string>();
  for (const categorySet of categorySets) {
    for (const workflowId of categorySet) {
      ids.add(workflowId);
    }
  }
  return ids;
}

function combineCandidateSets(candidateSets: readonly (Set<string> | null)[]): Set<string> | null {
  const presentSets = candidateSets.filter((set): set is Set<string> => set !== null);
  if (presentSets.length === 0) return null;
  return intersectIdentifierSets(presentSets);
}
