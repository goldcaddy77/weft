import type {
  AggregateFilter,
  AggregateGroupBy,
  AggregateResult,
  ApiClient,
  FailureCategory,
  ListFilter,
  RetentionOverview,
  ScheduleSummary,
  TimeRange,
  WorkflowStatus,
  WorkflowSummary,
} from '../api-client.ts';

export interface WorkflowListFilters {
  status: WorkflowStatus | 'all';
  type: string;
  tags: string[];
  offset: number;
  idPrefix?: string;
  createdAt?: TimeRange;
  updatedAt?: TimeRange;
  executionDeadline?: TimeRange;
  tenantId?: string[];
  failureCategory?: FailureCategory[];
}

export interface WorkflowListData {
  workflows: WorkflowSummary[];
  schedules: ScheduleSummary[];
  total: number;
  retentionOverview: RetentionOverview | null;
}

/**
 * Build the `ListFilter` shape sent to `apiClient.listWorkflows`.
 * Only round-trips fields that are actually set, mirroring the legacy
 * behavior so empty / whitespace inputs don't surface to the server.
 */
// oxlint-disable-next-line complexity -- ID:dashboard-build-workflow-list-filter
export function buildWorkflowListFilter(
  filters: WorkflowListFilters,
  pageSize: number,
): ListFilter {
  const listFilter: ListFilter = {
    limit: pageSize,
    offset: filters.offset,
  };

  if (filters.status !== 'all') listFilter.status = filters.status;
  if (filters.type.length > 0) listFilter.type = filters.type;
  if (filters.tags.length > 0) listFilter.tags = filters.tags;
  if (filters.idPrefix !== undefined && filters.idPrefix.length > 0) {
    listFilter.idPrefix = filters.idPrefix;
  }
  if (filters.createdAt !== undefined && hasTimeRangeBound(filters.createdAt)) {
    listFilter.createdAt = filters.createdAt;
  }
  if (filters.updatedAt !== undefined && hasTimeRangeBound(filters.updatedAt)) {
    listFilter.updatedAt = filters.updatedAt;
  }
  if (filters.executionDeadline !== undefined && hasTimeRangeBound(filters.executionDeadline)) {
    listFilter.executionDeadline = filters.executionDeadline;
  }
  if (filters.tenantId !== undefined && filters.tenantId.length > 0) {
    listFilter.tenantId = filters.tenantId.length === 1 ? filters.tenantId[0]! : filters.tenantId;
  }
  if (filters.failureCategory !== undefined && filters.failureCategory.length > 0) {
    listFilter.failureCategory =
      filters.failureCategory.length === 1 ? filters.failureCategory[0]! : filters.failureCategory;
  }

  return listFilter;
}

function hasTimeRangeBound(range: TimeRange): boolean {
  return (
    range.gte !== undefined ||
    range.gt !== undefined ||
    range.lte !== undefined ||
    range.lt !== undefined
  );
}

export async function loadWorkflowListData(
  apiClient: Pick<ApiClient, 'listWorkflows' | 'listSchedules' | 'getRetentionOverview'>,
  filters: WorkflowListFilters,
  pageSize: number,
): Promise<WorkflowListData> {
  const listFilter = buildWorkflowListFilter(filters, pageSize);

  const workflowListPromise = apiClient.listWorkflows(listFilter);
  const schedulesPromise = apiClient.listSchedules({ limit: pageSize }).catch(() => ({
    items: [],
    total: 0,
    offset: 0,
    limit: pageSize,
  }));
  const retentionOverviewPromise = apiClient.getRetentionOverview().catch(() => null);

  const workflowList = await workflowListPromise;
  const schedules = await schedulesPromise;
  const retentionOverview = await retentionOverviewPromise;

  return {
    workflows: workflowList.items,
    schedules: schedules.items,
    total: workflowList.total,
    retentionOverview,
  };
}

/**
 * Call the aggregate endpoint with the same filter shape used by the
 * list view (sans pagination). The dashboard uses this to populate the
 * status-counts panel and the tenant-suggestion list.
 */
export async function loadWorkflowAggregate(
  apiClient: Pick<ApiClient, 'aggregateWorkflows'>,
  filters: WorkflowListFilters,
  groupBy: AggregateGroupBy,
  limit?: number,
): Promise<AggregateResult> {
  // Aggregate intentionally omits limit + offset — the filter is the
  // population, the limit caps the returned groups.
  const { limit: _drop1, offset: _drop2, ...aggregateFilter } = buildWorkflowListFilter(filters, 0);
  void _drop1;
  void _drop2;
  return apiClient.aggregateWorkflows(aggregateFilter as AggregateFilter, groupBy, limit);
}
