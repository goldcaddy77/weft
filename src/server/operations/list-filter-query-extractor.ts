/**
 * Shared REST query-parameter extractor for the `ListFilter` shape. Both
 * `GET /v1/workflows` and `GET /v1/workflows/aggregate` accept the same
 * filter dimensions, so the parsing lives here to keep the two endpoints
 * in lock-step.
 *
 * @module server/operations/list-filter-query-extractor
 */

import type { FailureCategory, ListFilter, TimeRange, WorkflowStatus } from '../../core/types.ts';
import { parseAttributeFilters } from '../attribute-filters.ts';

/**
 * Extract every supported `ListFilter` dimension from a request URL's
 * query string. `limit` and `offset` are NOT extracted — callers that
 * support pagination layer them on top.
 */
// oxlint-disable-next-line complexity -- ID:server-operations-extract-list-filter-from-query
export function extractListFilterFromQuery(url: URL): ListFilter {
  const filter: ListFilter = {};
  const params = url.searchParams;

  const statuses = params.getAll('status') as WorkflowStatus[];
  if (statuses.length === 1) {
    filter.status = statuses[0]!;
  } else if (statuses.length > 1) {
    filter.status = statuses;
  }

  const type = params.get('type');
  if (type !== null) {
    filter.type = type;
  }

  const tags = params.getAll('tag');
  if (tags.length > 0) {
    filter.tags = tags;
  }

  const attributeFilters = parseAttributeFilters(params);
  if (attributeFilters.length > 0) {
    filter.attributes = attributeFilters.map((attribute) => ({
      key: attribute.key,
      ...(attribute.value === undefined ? {} : { value: attribute.value }),
      ...(attribute.gt === undefined ? {} : { gt: attribute.gt }),
      ...(attribute.lt === undefined ? {} : { lt: attribute.lt }),
      ...(attribute.gte === undefined ? {} : { gte: attribute.gte }),
      ...(attribute.lte === undefined ? {} : { lte: attribute.lte }),
    }));
  }

  const idPrefix = params.get('id_prefix');
  if (idPrefix !== null) {
    filter.idPrefix = idPrefix;
  }

  const tenantIds = params.getAll('tenant_id');
  if (tenantIds.length === 1) {
    filter.tenantId = tenantIds[0]!;
  } else if (tenantIds.length > 1) {
    filter.tenantId = tenantIds;
  }

  const failureCategories = params.getAll('failure_category') as FailureCategory[];
  if (failureCategories.length === 1) {
    filter.failureCategory = failureCategories[0]!;
  } else if (failureCategories.length > 1) {
    filter.failureCategory = failureCategories;
  }

  const createdAt = extractTimeRangeFromQuery(params, 'created_at');
  if (createdAt !== undefined) filter.createdAt = createdAt;
  const updatedAt = extractTimeRangeFromQuery(params, 'updated_at');
  if (updatedAt !== undefined) filter.updatedAt = updatedAt;
  const executionDeadline = extractTimeRangeFromQuery(params, 'execution_deadline');
  if (executionDeadline !== undefined) filter.executionDeadline = executionDeadline;

  return filter;
}

/**
 * Parse one of the three `*_at` time-range filters from the query
 * string. The four bounds map to `{prefix}_gte`, `{prefix}_gt`,
 * `{prefix}_lte`, `{prefix}_lt`. Returns `undefined` when none of the
 * bounds were specified so the omitted-vs-empty distinction is preserved
 * for the downstream `normalizeListFilter` validation.
 */
export function extractTimeRangeFromQuery(
  params: URLSearchParams,
  prefix: 'created_at' | 'updated_at' | 'execution_deadline',
): TimeRange | undefined {
  const range: TimeRange = {};
  const gte = params.get(`${prefix}_gte`);
  if (gte !== null && Number.isFinite(Number(gte))) range.gte = Number(gte);
  const gt = params.get(`${prefix}_gt`);
  if (gt !== null && Number.isFinite(Number(gt))) range.gt = Number(gt);
  const lte = params.get(`${prefix}_lte`);
  if (lte !== null && Number.isFinite(Number(lte))) range.lte = Number(lte);
  const lt = params.get(`${prefix}_lt`);
  if (lt !== null && Number.isFinite(Number(lt))) range.lt = Number(lt);
  return Object.keys(range).length > 0 ? range : undefined;
}
