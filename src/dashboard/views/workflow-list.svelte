<script lang="ts">
  import { getContext } from 'svelte';

  import type { ApiClient, WorkflowStatus, WorkflowSummary } from '../api-client.ts';
  import { search, filter, refreshCw } from '../icons.ts';
  import Page from '../components/page.svelte';
  import Button from '../components/button.svelte';
  import Skeleton from '../components/skeleton.svelte';
  import EmptyState from '../components/empty-state.svelte';
  import WorkflowTableRow from '../fragments/workflow-table-row.svelte';
  import { collectWorkflowTags, toggleWorkflowTagSelection } from '../utilities/workflow-tags.ts';

  const apiClient = getContext<ApiClient>('api-client');

  // ---------------------------------------------------------------------------
  // Filter state
  // ---------------------------------------------------------------------------

  let statusFilter: WorkflowStatus | 'all' = $state('all');
  let typeFilter = $state('');
  let selectedTags = $state<string[]>([]);
  let currentOffset = $state(0);
  const pageSize = 20;

  // ---------------------------------------------------------------------------
  // Data state
  // ---------------------------------------------------------------------------

  let workflows: WorkflowSummary[] = $state([]);
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
    tags: string[];
    offset: number;
  }

  async function fetchWorkflows(generation: number, filters: FetchFilters): Promise<void> {
    try {
      const result = await apiClient.listWorkflows({
        status: filters.status === 'all' ? undefined : filters.status,
        type: filters.type || undefined,
        tags: filters.tags.length > 0 ? filters.tags : undefined,
        limit: pageSize,
        offset: filters.offset,
      });
      if (generation !== fetchGeneration) return;
      workflows = result.items;
      total = result.total;
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
      tags: selectedTags,
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
      tags: selectedTags,
      offset: currentOffset,
    });
  }

  const availableTagFilters = $derived.by(() => {
    const tags = new Set([...collectWorkflowTags(workflows), ...selectedTags]);
    return [...tags].toSorted((left, right) => left.localeCompare(right));
  });

  function toggleTagFilter(tag: string): void {
    selectedTags = toggleWorkflowTagSelection(selectedTags, tag);
    currentOffset = 0;
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
        {#each STATUS_OPTIONS as option}
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

  {#if availableTagFilters.length > 0}
    <div class="workflow-tag-filters" aria-label="Workflow tag filters">
      {#each availableTagFilters as tag (tag)}
        <button
          type="button"
          class="workflow-tag-chip"
          data-selected={selectedTags.includes(tag)}
          onclick={() => toggleTagFilter(tag)}
        >
          {tag}
        </button>
      {/each}
    </div>
  {/if}

  {#if loading && workflows.length === 0}
    <div class="workflow-list-skeleton">
      {#each Array(5) as _}
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

  .workflow-tag-filters {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-2, 0.5rem);
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

  .workflow-tag-chip {
    appearance: none;
    border: 1px solid var(--border-muted, #d1d5db);
    background: var(--surface, #ffffff);
    color: var(--text, #111827);
    border-radius: 999px;
    padding: 0.35rem 0.7rem;
    font-size: var(--text-xs, 0.75rem);
    font-weight: 600;
    cursor: pointer;
    transition:
      background-color var(--duration-fast, 150ms) var(--ease-standard, ease),
      border-color var(--duration-fast, 150ms) var(--ease-standard, ease),
      color var(--duration-fast, 150ms) var(--ease-standard, ease);
  }

  .workflow-tag-chip[data-selected='true'] {
    background: color-mix(in oklch, var(--secondary, #2563eb), transparent 84%);
    border-color: color-mix(in oklch, var(--secondary, #2563eb), transparent 52%);
    color: var(--secondary, #2563eb);
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
