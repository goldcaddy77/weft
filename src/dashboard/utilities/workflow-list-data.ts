import type {
  ApiClient,
  RetentionOverview,
  WorkflowStatus,
  WorkflowSummary,
} from '../api-client.ts';

export interface WorkflowListFilters {
  status: WorkflowStatus | 'all';
  type: string;
  offset: number;
}

export interface WorkflowListData {
  workflows: WorkflowSummary[];
  total: number;
  retentionOverview: RetentionOverview | null;
}

export async function loadWorkflowListData(
  apiClient: Pick<ApiClient, 'listWorkflows' | 'getRetentionOverview'>,
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

  const workflowListPromise = apiClient.listWorkflows(listFilter);
  const retentionOverviewPromise = apiClient.getRetentionOverview().catch(() => null);

  const workflowList = await workflowListPromise;
  const retentionOverview = await retentionOverviewPromise;

  return {
    workflows: workflowList.items,
    total: workflowList.total,
    retentionOverview,
  };
}
