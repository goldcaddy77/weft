import type { ListFilter } from './types.ts';

export const BULK_WORKFLOW_FILTER_ERROR_MESSAGE =
  'Field "filter" must include at least one of status, type, tags, or attributes';

export function hasScopedBulkWorkflowFilter(filter: ListFilter): boolean {
  const hasScopedStatus =
    filter.status !== undefined &&
    (Array.isArray(filter.status) ? filter.status.length > 0 : filter.status.length > 0);
  const hasScopedType = filter.type !== undefined && filter.type.trim().length > 0;
  const hasScopedTags = (filter.tags?.length ?? 0) > 0;
  const hasScopedAttributes = (filter.attributes?.length ?? 0) > 0;

  return hasScopedStatus || hasScopedType || hasScopedTags || hasScopedAttributes;
}

export function assertScopedBulkWorkflowFilter(filter: ListFilter): ListFilter {
  if (!hasScopedBulkWorkflowFilter(filter)) {
    throw new Error(BULK_WORKFLOW_FILTER_ERROR_MESSAGE);
  }

  return filter;
}
