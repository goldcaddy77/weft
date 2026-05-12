import { searchAttributeName } from './search-attributes.ts';
import type { ListFilter } from './types.ts';
import { normalizeWorkflowTags } from './workflow-tags.ts';

const ID_PREFIX_MIN_LENGTH = 3;

export const BULK_WORKFLOW_FILTER_ERROR_MESSAGE =
  'Field "filter" must include at least one of status, type, tags, attributes, tenantId, idPrefix (≥3 chars), or failureCategory paired with status';

function hasScopedStatusFilter(filter: ListFilter): boolean {
  if (filter.status === undefined) return false;
  if (Array.isArray(filter.status)) return filter.status.length > 0;
  return filter.status.length > 0;
}

function hasScopedTenantFilter(filter: ListFilter): boolean {
  if (filter.tenantId === undefined) return false;
  if (Array.isArray(filter.tenantId)) {
    return filter.tenantId.some((tenantId) => tenantId.trim().length > 0);
  }
  return filter.tenantId.trim().length > 0;
}

function hasScopedIdPrefix(filter: ListFilter): boolean {
  return filter.idPrefix !== undefined && filter.idPrefix.length >= ID_PREFIX_MIN_LENGTH;
}

/**
 * Returns `true` when the filter narrows destructive bulk operations
 * to a scoped subset rather than every workflow on the engine.
 *
 * Valid scopes:
 * - `status` (non-empty after normalization).
 * - `type` (non-empty after trim).
 * - `tags` (at least one tag after normalization).
 * - `attributes` (at least one attribute predicate with a non-empty key).
 * - `tenantId` (non-empty string or non-empty array with at least one non-empty value).
 * - `idPrefix` (length ≥ 3 — short prefixes match too much to be a safe scope).
 * - `failureCategory` is **not** a valid scope on its own — it must be
 *   combined with a non-empty status filter. The engine doesn't enforce
 *   the "failureCategory implies failed status" invariant (the attribute
 *   could theoretically be set on a non-failed workflow), so deleting on
 *   the attribute alone would be a footgun.
 * - Time ranges (`createdAt`, `updatedAt`, `executionDeadline`) are
 *   **not** valid scopes on their own — they must combine with another
 *   dimension from the list above.
 */
// oxlint-disable-next-line complexity -- ID:core-bulk-workflow-filter-has-scoped-complexity
export function hasScopedBulkWorkflowFilter(filter: ListFilter): boolean {
  const scopedStatus = hasScopedStatusFilter(filter);
  const scopedType = filter.type !== undefined && filter.type.trim().length > 0;
  const scopedTags = (normalizeWorkflowTags(filter.tags)?.length ?? 0) > 0;
  const scopedAttributes =
    filter.attributes?.some((attribute) => searchAttributeName(attribute.key).trim().length > 0) ??
    false;
  const scopedTenant = hasScopedTenantFilter(filter);
  const scopedIdPrefix = hasScopedIdPrefix(filter);

  // failureCategory is *not* listed as an independent scope: the attribute
  // can in theory be set on workflows that are not in a failed status, so
  // deleting "every workflow whose failureCategory is X" is a footgun.
  // Combining failureCategory with status is fine — but that case is
  // already covered by the scopedStatus branch above.
  return (
    scopedStatus || scopedType || scopedTags || scopedAttributes || scopedTenant || scopedIdPrefix
  );
}

export function assertScopedBulkWorkflowFilter(filter: ListFilter): ListFilter {
  if (!hasScopedBulkWorkflowFilter(filter)) {
    throw new Error(BULK_WORKFLOW_FILTER_ERROR_MESSAGE);
  }

  return filter;
}
