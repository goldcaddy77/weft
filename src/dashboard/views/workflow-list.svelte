<script lang="ts">
  import { getContext } from 'svelte';

  import type {
    ApiClient,
    TenantQuotaMetricUsage,
    TenantQuotaUsage,
    WorkflowStatus,
    WorkflowSummary,
  } from '../api-client.ts';
  import { activity, filter, refreshCw, search } from '../icons.ts';
  import Alert from '../components/alert.svelte';
  import Card from '../components/card.svelte';
  import Input from '../components/input.svelte';
  import Page from '../components/page.svelte';
  import Button from '../components/button.svelte';
  import Skeleton from '../components/skeleton.svelte';
  import EmptyState from '../components/empty-state.svelte';
  import WorkflowTableRow from '../fragments/workflow-table-row.svelte';
  import {
    computeTenantQuotaMeter,
    formatTenantQuotaBytes,
    formatTenantQuotaWindow,
  } from '../utilities/tenant-quota.ts';
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
  let tenantQuotaId = $state('');
  let tenantQuotaUsage = $state.raw<TenantQuotaUsage | null>(null);
  let tenantQuotaLoading = $state(false);
  let tenantQuotaError: string | null = $state(null);

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

  function formatTenantQuotaLimit(metric: TenantQuotaMetricUsage): string {
    return metric.limit === null ? 'No limit' : String(metric.limit);
  }

  const availableTagFilters = $derived.by(() => {
    const tags = new Set([...collectWorkflowTags(workflows), ...selectedTags]);
    return [...tags].toSorted((left, right) => left.localeCompare(right));
  });

  function toggleTagFilter(tag: string): void {
    selectedTags = toggleWorkflowTagSelection(selectedTags, tag);
    currentOffset = 0;
  }

  async function handleTenantQuotaSubmit(event: SubmitEvent): Promise<void> {
    event.preventDefault();

    if (tenantQuotaLoading) {
      return;
    }

    const normalizedTenantId = tenantQuotaId.trim();
    if (normalizedTenantId.length === 0) {
      tenantQuotaError = 'Enter a tenant ID to inspect quota usage.';
      tenantQuotaUsage = null;
      return;
    }

    tenantQuotaLoading = true;
    try {
      tenantQuotaUsage = await apiClient.getTenantQuotaUsage(normalizedTenantId);
      tenantQuotaError = null;
    } catch (fetchError) {
      tenantQuotaError = fetchError instanceof Error ? fetchError.message : String(fetchError);
      tenantQuotaUsage = null;
    } finally {
      tenantQuotaLoading = false;
    }
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

  {#if availableTagFilters.length > 0}
    <div class="workflow-tag-filters" aria-label="Workflow tag filters">
      {#each availableTagFilters as tag (tag)}
        <button
          type="button"
          class="workflow-tag-chip"
          data-selected={selectedTags.includes(tag)}
          aria-pressed={selectedTags.includes(tag)}
          onclick={() => toggleTagFilter(tag)}
        >
          {tag}
        </button>
      {/each}
    </div>
  {/if}

  <Card
    title="Tenant quota inspector"
    description="Check current tenant usage against configured workflow admission limits."
    icon={activity(14)}
  >
    <form class="tenant-quota-form" onsubmit={handleTenantQuotaSubmit}>
      <Input
        id="tenant-quota-id"
        label="Tenant ID"
        placeholder="acme"
        bind:value={tenantQuotaId}
        description="Use a resolved tenant identifier to inspect active workflows, durable bytes, and workflow creation rate."
      />
      <div class="tenant-quota-actions">
        <Button
          type="submit"
          variant="secondary"
          size="md"
          label="Inspect quotas"
          loading={tenantQuotaLoading}
        />
      </div>
    </form>

    {#if tenantQuotaError}
      <div class="tenant-quota-alert">
        <Alert
          variant="danger"
          title="Quota lookup failed"
          description={tenantQuotaError}
        />
      </div>
    {/if}

    {#if tenantQuotaUsage}
      {@const activeWorkflowMeter = computeTenantQuotaMeter(tenantQuotaUsage.activeWorkflows)}
      {@const storageBytesMeter = computeTenantQuotaMeter(tenantQuotaUsage.storageBytes)}
      {@const workflowCreationRateMeter = computeTenantQuotaMeter(tenantQuotaUsage.workflowCreationRate)}

      <div class="tenant-quota-grid" aria-live="polite">
        <div class="tenant-quota-metric">
          <div class="tenant-quota-metric-header">
            <span class="tenant-quota-metric-label">Active workflows</span>
            <span class="tenant-quota-metric-value">
              {tenantQuotaUsage.activeWorkflows.used} / {formatTenantQuotaLimit(tenantQuotaUsage.activeWorkflows)}
            </span>
          </div>
          <div class="tenant-quota-meter" aria-hidden="true">
            <div
              class="tenant-quota-meter-fill"
              data-severity={activeWorkflowMeter.severity}
              style={`width: ${activeWorkflowMeter.percentage}%`}
            ></div>
          </div>
          <p class="tenant-quota-metric-note">
            Currently active tenant workflows across pending and running states.
          </p>
        </div>

        <div class="tenant-quota-metric">
          <div class="tenant-quota-metric-header">
            <span class="tenant-quota-metric-label">Durable storage</span>
            <span class="tenant-quota-metric-value">
              {formatTenantQuotaBytes(tenantQuotaUsage.storageBytes.used)} / {tenantQuotaUsage.storageBytes.limit === null
                ? 'No limit'
                : formatTenantQuotaBytes(tenantQuotaUsage.storageBytes.limit)}
            </span>
          </div>
          <div class="tenant-quota-meter" aria-hidden="true">
            <div
              class="tenant-quota-meter-fill"
              data-severity={storageBytesMeter.severity}
              style={`width: ${storageBytesMeter.percentage}%`}
            ></div>
          </div>
          <p class="tenant-quota-metric-note">
            Durable bytes currently attributed to this tenant’s workflows.
          </p>
        </div>

        <div class="tenant-quota-metric">
          <div class="tenant-quota-metric-header">
            <span class="tenant-quota-metric-label">Workflow creation rate</span>
            <span class="tenant-quota-metric-value">
              {tenantQuotaUsage.workflowCreationRate.used} / {formatTenantQuotaLimit(tenantQuotaUsage.workflowCreationRate)}
            </span>
          </div>
          <div class="tenant-quota-meter" aria-hidden="true">
            <div
              class="tenant-quota-meter-fill"
              data-severity={workflowCreationRateMeter.severity}
              style={`width: ${workflowCreationRateMeter.percentage}%`}
            ></div>
          </div>
          <p class="tenant-quota-metric-note">
            {formatTenantQuotaWindow(tenantQuotaUsage.workflowCreationRate)}
          </p>
        </div>
      </div>
    {/if}
  </Card>

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

  .tenant-quota-form {
    display: grid;
    gap: var(--space-3, 0.75rem);
    align-items: end;
  }

  @media (min-width: 720px) {
    .tenant-quota-form {
      grid-template-columns: minmax(0, 1fr) auto;
    }
  }

  .tenant-quota-actions {
    display: flex;
    align-items: center;
    justify-content: flex-start;
  }

  .tenant-quota-alert {
    margin-top: var(--space-3, 0.75rem);
  }

  .tenant-quota-grid {
    margin-top: var(--space-4, 1rem);
    display: grid;
    gap: var(--space-4, 1rem);
  }

  @media (min-width: 960px) {
    .tenant-quota-grid {
      grid-template-columns: repeat(3, minmax(0, 1fr));
    }
  }

  .tenant-quota-metric {
    display: flex;
    flex-direction: column;
    gap: var(--space-2, 0.5rem);
    padding: var(--space-3, 0.75rem);
    border-radius: var(--radius-md, 0.375rem);
    border: 1px solid var(--border-muted, #e5e7eb);
    background: var(--surface, #fff);
  }

  .tenant-quota-metric-header {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: var(--space-3, 0.75rem);
  }

  .tenant-quota-metric-label {
    font-size: var(--text-xs, 0.75rem);
    font-weight: var(--font-medium, 500);
    color: var(--text-muted, #6b7280);
  }

  .tenant-quota-metric-value {
    font-size: var(--text-sm, 0.875rem);
    font-weight: var(--font-medium, 500);
    color: var(--text, #111827);
  }

  .tenant-quota-meter {
    height: 0.5rem;
    border-radius: 999px;
    background: var(--surface-inset, #f3f4f6);
    overflow: hidden;
  }

  .tenant-quota-meter-fill {
    height: 100%;
    border-radius: inherit;
    background: var(--success, #16a34a);
    transition: width var(--duration-fast, 150ms) var(--ease-standard, ease);
  }

  .tenant-quota-meter-fill[data-severity='warning'] {
    background: var(--warning, #d97706);
  }

  .tenant-quota-meter-fill[data-severity='danger'] {
    background: var(--error, #dc2626);
  }

  .tenant-quota-metric-note {
    font-size: var(--text-xs, 0.75rem);
    color: var(--text-muted, #6b7280);
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
