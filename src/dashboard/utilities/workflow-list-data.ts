import type {
  ApiClient,
  RetentionOverview,
  ScheduleSummary,
  WorkflowStatus,
  WorkflowSummary,
} from '../api-client.ts';

export interface WorkflowListFilters {
  status: WorkflowStatus | 'all';
  type: string;
  tags: string[];
  offset: number;
}

export interface WorkflowListData {
  workflows: WorkflowSummary[];
  schedules: ScheduleSummary[];
  total: number;
  retentionOverview: RetentionOverview | null;
}

export async function loadWorkflowListData(
  apiClient: Pick<ApiClient, 'listWorkflows' | 'listSchedules' | 'getRetentionOverview'>,
  filters: WorkflowListFilters,
  pageSize: number,
): Promise<WorkflowListData> {
  const listFilter: Parameters<ApiClient['listWorkflows']>[0] = {
    limit: pageSize,
    offset: filters.offset,
  };

  if (filters.status !== 'all') {
    listFilter.status = filters.status;
  }

  if (filters.type.length > 0) {
    listFilter.type = filters.type;
  }

  if (filters.tags.length > 0) {
    listFilter.tags = filters.tags;
  }

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
