<script lang="ts">
  import { getContext } from 'svelte';

  import type { ApiClient, RetentionOverview, WorkflowStatus, WorkflowSummary } from '../api-client.ts';
  import { search, filter, refreshCw } from '../icons.ts';
  import Page from '../components/page.svelte';
  import Button from '../components/button.svelte';
  import Card from '../components/card.svelte';
  import DataList from '../components/data-list.svelte';
  import Skeleton from '../components/skeleton.svelte';
  import EmptyState from '../components/empty-state.svelte';
  import WorkflowTableRow from '../fragments/workflow-table-row.svelte';
  import { loadWorkflowListData } from '../utilities/workflow-list-data.ts';
  import { buildWorkflowRetentionRows } from '../utilities/workflow-retention.ts';

  const apiClient = getContext<ApiClient>('api-client');

  // ---------------------------------------------------------------------------
  // Filter state
  // ---------------------------------------------------------------------------

  let statusFilter: WorkflowStatus | 'all' = $state('all');
  let typeFilter = $state('');
  let currentOffset = $state(0);
  const pageSize = 20;

  // ---------------------------------------------------------------------------
  // Data state
  // ---------------------------------------------------------------------------

  let workflows: WorkflowSummary[] = $state([]);
  let retentionOverview: RetentionOverview | null = $state(null);
  let total = $state(0);
  let loading = $state(true);
  let error: string | null = $state(null);
  let fetchGeneration = 0;

  // ---------------------------------------------------------------------------
  // Fetching
  // ---------------------------------------------------------------------------

  interface FetchFilters {
    status: WorkflowStatus | 'all';
    type: string;
    offset: number;
  }

  async function fetchWorkflows(generation: number, filters: FetchFilters): Promise<void> {
    try {
      const result = await loadWorkflowListData(apiClient, filters, pageSize);
      if (generation !== fetchGeneration) return;
      workflows = result.workflows;
      total = result.total;
      retentionOverview = result.retentionOverview;
      error = null;
    } catch (fetchError) {
      if (generation !== fetchGeneration) return;
      error = fetchError instanceof Error ? fetchError.message : String(fetchError);
    } finally {
      if (generation === fetchGeneration) {
        loading = false;
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Polling
  // ---------------------------------------------------------------------------

  $effect(() => {
    // Read reactive values synchronously so Svelte tracks them as dependencies.
    const filters: FetchFilters = {
      status: statusFilter,
      type: typeFilter,
      offset: currentOffset,
    };

    loading = true;
    const generation = ++fetchGeneration;
    fetchWorkflows(generation, filters);

    let interval: ReturnType<typeof setInterval> | null = null;

    function startPolling(): void {
      interval = setInterval(() => {
        if (!document.hidden) {
          fetchWorkflows(generation, filters);
        }
      }, 5_000);
    }

    function handleVisibility(): void {
      if (!document.hidden && interval === null) {
        fetchWorkflows(generation, filters);
        startPolling();
      } else if (document.hidden && interval !== null) {
        clearInterval(interval);
        interval = null;
      }
    }

    startPolling();
    document.addEventListener('visibilitychange', handleVisibility);

    return () => {
      if (interval !== null) clearInterval(interval);
      document.removeEventListener('visibilitychange', handleVisibility);
    };
  });

  // ---------------------------------------------------------------------------
  // Pagination
  // ---------------------------------------------------------------------------

  const totalPages = $derived(Math.ceil(total / pageSize));
  const currentPage = $derived(Math.floor(currentOffset / pageSize) + 1);
  const hasPreviousPage = $derived(currentOffset > 0);
  const hasNextPage = $derived(currentOffset + pageSize < total);
  const retentionRows = $derived(
    retentionOverview ? buildWorkflowRetentionRows(retentionOverview) : null,
  );

  function goToNextPage(): void {
    currentOffset += pageSize;
  }

  function goToPreviousPage(): void {
    currentOffset = Math.max(0, currentOffset - pageSize);
  }

  function handleRefresh(): void {
    fetchWorkflows(fetchGeneration, {
      status: statusFilter,
      type: typeFilter,
      offset: currentOffset,
    });
  }

  const STATUS_OPTIONS: Array<{ value: WorkflowStatus | 'all'; label: string }> = [
    { value: 'all', label: 'All Statuses' },
    { value: 'pending', label: 'Pending' },
    { value: 'running', label: 'Running' },
    { value: 'completed', label: 'Completed' },
    { value: 'failed', label: 'Failed' },
    { value: 'cancelled', label: 'Cancelled' },
    { value: 'timed-out', label: 'Timed Out' },
  ];
</script>

<Page title="Workflows">
  {#snippet actions()}
    <Button variant="ghost" size="sm" icon={refreshCw(14)} label="Refresh" onclick={handleRefresh} />
  {/snippet}

  <div class="workflow-list-filters">
    <div class="workflow-list-filter-group">
      <span class="workflow-list-filter-icon" aria-hidden="true">{@html filter(14)}</span>
      <select
        class="control"
        bind:value={statusFilter}
        onchange={() => { currentOffset = 0; }}
      >
        {#each STATUS_OPTIONS as option (option.value)}
          <option value={option.value}>{option.label}</option>
        {/each}
      </select>
    </div>
    <div class="workflow-list-filter-group">
      <span class="workflow-list-filter-icon" aria-hidden="true">{@html search(14)}</span>
      <input
        class="control"
        type="text"
        placeholder="Filter by type..."
        bind:value={typeFilter}
        oninput={() => { currentOffset = 0; }}
      />
    </div>
  </div>

  {#if retentionRows}
    <Card
      title="Retention"
      subtitle={`Next sweep ${retentionRows.nextSweepAt}`}
    >
      <DataList
        variant="compact"
        items={retentionRows.workflowTypes}
        getKey={(item) => item.type}
      >
        {#snippet item(item)}
          <div class="workflow-retention-row">
            <div class="workflow-retention-row-header">
              <span class="workflow-retention-type">{item.type}</span>
              <span class="workflow-retention-source text-muted">{item.source}</span>
            </div>
            <div class="workflow-retention-value text-muted">{item.retention}</div>
          </div>
        {/snippet}
      </DataList>
    </Card>
  {/if}

  {#if loading && workflows.length === 0}
    <div class="workflow-list-skeleton">
      {#each [0, 1, 2, 3, 4] as skeletonRow (skeletonRow)}
        <Skeleton variant="text" height="2.5rem" />
      {/each}
    </div>
  {:else if error}
    <div class="workflow-list-error">
      <p class="text-muted">Failed to load workflows: {error}</p>
    </div>
  {:else if workflows.length === 0}
    <EmptyState
      icon={search(32)}
      title="No workflows found"
      description="There are no workflows matching the current filters."
    />
  {:else}
    <div class="workflow-list-table-wrapper">
      <table class="workflow-table">
        <thead>
          <tr>
            <th>ID</th>
            <th>Type</th>
            <th>Status</th>
            <th>Version</th>
            <th>Created</th>
            <th>Updated</th>
          </tr>
        </thead>
        <tbody>
          {#each workflows as workflow (workflow.id)}
            <WorkflowTableRow {workflow} />
          {/each}
        </tbody>
      </table>
    </div>

    {#if totalPages > 1}
      <div class="workflow-list-pagination">
        <Button
          variant="secondary"
          size="xs"
          label="Previous"
          disabled={!hasPreviousPage}
          onclick={goToPreviousPage}
        />
        <span class="workflow-list-pagination-info text-muted">
          Page {currentPage} of {totalPages}
        </span>
        <Button
          variant="secondary"
          size="xs"
          label="Next"
          disabled={!hasNextPage}
          onclick={goToNextPage}
        />
      </div>
    {/if}
  {/if}
</Page>

<style>
  .workflow-list-filters {
    display: flex;
    gap: var(--space-3, 0.75rem);
    flex-wrap: wrap;
  }

  .workflow-retention-row {
    display: flex;
    flex-direction: column;
    gap: var(--space-1, 0.25rem);
  }

  .workflow-retention-row-header {
    display: flex;
    justify-content: space-between;
    gap: var(--space-2, 0.5rem);
    align-items: baseline;
  }

  .workflow-retention-type {
    font-weight: 600;
  }

  .workflow-retention-source,
  .workflow-retention-value {
    font-size: var(--text-xs, 0.75rem);
  }

  .workflow-list-filter-group {
    display: flex;
    align-items: center;
    gap: var(--space-2, 0.5rem);
    flex: 1;
    min-width: 10rem;
  }

  .workflow-list-filter-icon {
    display: inline-flex;
    flex-shrink: 0;
    color: var(--text-muted, #6b7280);
  }

  .workflow-list-filter-group select,
  .workflow-list-filter-group input {
    flex: 1;
  }

  .workflow-list-skeleton {
    display: flex;
    flex-direction: column;
    gap: var(--space-2, 0.5rem);
  }

  .workflow-list-error {
    padding: var(--space-4, 1rem);
    text-align: center;
  }

  .workflow-list-table-wrapper {
    overflow-x: auto;
  }

  .workflow-list-pagination {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: var(--space-3, 0.75rem);
  }

  .workflow-list-pagination-info {
    font-size: var(--text-sm, 0.875rem);
  }
</style>
