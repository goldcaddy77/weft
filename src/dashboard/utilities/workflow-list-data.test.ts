import { describe, expect, it, mock } from 'bun:test';

import type { ApiClient } from '../api-client.ts';
import { loadWorkflowListData } from './workflow-list-data.ts';

describe('loadWorkflowListData', () => {
  it('returns workflows even when the retention overview request fails', async () => {
    const apiClient = {
      listWorkflows: mock(async () => ({
        items: [
          {
            id: 'workflow-1',
            type: 'echo',
            status: 'completed' as const,
            version: '1.0.0',
            createdAt: 1,
            updatedAt: 2,
          },
        ],
        total: 1,
        offset: 0,
        limit: 20,
      })),
      getRetentionOverview: mock(async () => {
        throw new Error('retention unavailable');
      }),
    } satisfies Pick<ApiClient, 'listWorkflows' | 'getRetentionOverview'>;

    const result = await loadWorkflowListData(
      apiClient,
      {
        status: 'all',
        type: '',
        tags: [],
        offset: 0,
      },
      20,
    );

    expect(result.workflows).toHaveLength(1);
    expect(result.total).toBe(1);
    expect(result.retentionOverview).toBeNull();
  });

  it('passes filters through to the workflow list request and keeps retention data when available', async () => {
    const apiClient = {
      listWorkflows: mock(async (filter) => ({
        items: [],
        total: 0,
        offset: filter?.offset ?? 0,
        limit: filter?.limit ?? 0,
      })),
      getRetentionOverview: mock(async () => ({
        defaultRetention: { completed: 300_000 },
        sweepIntervalMs: 300_000,
        sweepBatchSize: 1000,
        nextSweepAt: 123_456,
        workflowTypes: [],
      })),
    } satisfies Pick<ApiClient, 'listWorkflows' | 'getRetentionOverview'>;

    const result = await loadWorkflowListData(
      apiClient,
      {
        status: 'completed',
        type: 'echo',
        tags: ['nightly', 'v2'],
        offset: 40,
      },
      20,
    );

    expect(apiClient.listWorkflows).toHaveBeenCalledWith({
      status: 'completed',
      type: 'echo',
      tags: ['nightly', 'v2'],
      limit: 20,
      offset: 40,
    });
    expect(result.retentionOverview?.nextSweepAt).toBe(123_456);
  });
});
