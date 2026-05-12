<script lang="ts">
  import { getContext } from 'svelte';

  import type {
    ApiClient,
    BulkOperationDryRunResult,
    BulkTagMutationOperation,
    ListFilter,
    RetentionOverview,
    ScheduleSummary,
    TenantQuotaMetricUsage,
    TenantQuotaUsage,
    WorkflowStatus,
    WorkflowSummary,
  } from '../api-client.ts';
  import { activity, ban, check, refreshCw, search } from '../icons.ts';
  import Alert from '../components/alert.svelte';
  import Input from '../components/input.svelte';
  import Page from '../components/page.svelte';
  import Button from '../components/button.svelte';
  import Card from '../components/card.svelte';
  import DataList from '../components/data-list.svelte';
  import Select from '../components/select.svelte';
  import Skeleton from '../components/skeleton.svelte';
  import EmptyState from '../components/empty-state.svelte';
  import WorkflowTableRow from '../fragments/workflow-table-row.svelte';
  import ScheduleList from '../fragments/schedule-list.svelte';
  import {
    computeTenantQuotaMeter,
    formatTenantQuotaBytes,
    formatTenantQuotaWindow,
  } from '../utilities/tenant-quota.ts';
  import { loadWorkflowListData } from '../utilities/workflow-list-data.ts';
  import { buildWorkflowRetentionRows } from '../utilities/workflow-retention.ts';
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
  let schedules: ScheduleSummary[] = $state([]);
  let retentionOverview: RetentionOverview | null = $state(null);
  let total = $state(0);
  let loading = $state(true);
  let error: string | null = $state(null);
  let fetchGeneration = 0;
  let tenantQuotaId = $state('');
  let tenantQuotaUsage = $state.raw<TenantQuotaUsage | null>(null);
  let tenantQuotaLoading = $state(false);
  let tenantQuotaError: string | null = $state(null);
  type BulkWorkflowAction = 'cancel' | 'signal' | 'delete' | 'tag:add' | 'tag:remove';
  type BulkSignalPayloadParseResult =
    | { ok: true; value: unknown }
    | { ok: false; message: string };
  type BulkPreviewedOperation = {
    action: BulkWorkflowAction;
    filter: ListFilter;
    requestId: string;
    confirmationToken: string;
    signalName?: string;
    signalPayload?: unknown;
    tags?: string[];
    tagOperation?: BulkTagMutationOperation;
  };
  type BulkPreviewDetail = {
    label: string;
    value: string;
  };
  type BulkActionErrorPhase = 'preview' | 'commit';
  let bulkAction: BulkWorkflowAction = $state('cancel');
  let bulkTagInput = $state('');
  let bulkSignalNameInput = $state('');
  let bulkSignalPayloadInput = $state('');
  let bulkPreview: BulkOperationDryRunResult | null = $state.raw(null);
  let bulkPreviewedOperation: BulkPreviewedOperation | null = $state.raw(null);
  let bulkPreviewRequestId: string | null = $state(null);
  let bulkPreviewLoading = $state(false);
  let bulkCommitLoading = $state(false);
  let bulkActionError: string | null = $state(null);
  let bulkActionErrorPhase: BulkActionErrorPhase | null = $state(null);
  let bulkActionMessage: string | null = $state(null);
  let bulkPreviewGeneration = 0;

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
    invalidateBulkPreview({ clearMessages: false });
    try {
      const result = await loadWorkflowListData(apiClient, filters, pageSize);
      if (generation !== fetchGeneration) return;
      workflows = result.workflows;
      schedules = result.schedules;
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
      tags: selectedTags,
      offset: currentOffset,
    });
  }

  function invalidateBulkPreview(options: { clearMessages?: boolean } = {}): void {
    bulkPreviewGeneration += 1;
    bulkPreview = null;
    bulkPreviewedOperation = null;
    bulkPreviewRequestId = null;
    bulkPreviewLoading = false;
    if (options.clearMessages === false) {
      return;
    }
    bulkActionError = null;
    bulkActionErrorPhase = null;
    bulkActionMessage = null;
  }

  function resetBulkPreview(): void {
    invalidateBulkPreview();
  }

  function resetFiltersAndBulkPreview(): void {
    currentOffset = 0;
    resetBulkPreview();
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
    resetBulkPreview();
  }

  const bulkFilter = $derived.by((): ListFilter => {
    const filter: ListFilter = {};
    if (statusFilter !== 'all') filter.status = statusFilter;
    const normalizedType = typeFilter.trim();
    if (normalizedType.length > 0) filter.type = normalizedType;
    if (selectedTags.length > 0) filter.tags = [...selectedTags];
    return filter;
  });

  const bulkFilterIsScoped = $derived(
    bulkFilter.status !== undefined ||
      bulkFilter.type !== undefined ||
      (bulkFilter.tags?.length ?? 0) > 0,
  );
  const bulkTags = $derived.by(() =>
    bulkTagInput
      .split(',')
      .map((tag) => tag.trim())
      .filter((tag) => tag.length > 0),
  );
  const bulkSignalName = $derived(bulkSignalNameInput.trim());
  const bulkSignalPayloadParseResult = $derived.by((): BulkSignalPayloadParseResult => {
    const payload = bulkSignalPayloadInput.trim();
    if (payload.length === 0) return { ok: true, value: undefined };

    try {
      return { ok: true, value: JSON.parse(payload) as unknown };
    } catch {
      return { ok: false, message: 'Signal payload must be valid JSON.' };
    }
  });
  const bulkActionNeedsTags = $derived(bulkAction === 'tag:add' || bulkAction === 'tag:remove');
  const bulkActionNeedsSignal = $derived(bulkAction === 'signal');
  const canPreviewBulkAction = $derived(
    bulkFilterIsScoped &&
      (!bulkActionNeedsTags || bulkTags.length > 0) &&
      (!bulkActionNeedsSignal ||
        (bulkSignalName.length > 0 && bulkSignalPayloadParseResult.ok)),
  );
  const BULK_ACTION_OPTIONS: Array<{ value: BulkWorkflowAction; label: string }> = [
    { value: 'cancel', label: 'Cancel' },
    { value: 'signal', label: 'Signal' },
    { value: 'delete', label: 'Delete' },
    { value: 'tag:add', label: 'Add Tags' },
    { value: 'tag:remove', label: 'Remove Tags' },
  ];
  const bulkSignalPayloadPlaceholder = '{"approved":true}';
  const bulkActionLabel = $derived(
    BULK_ACTION_OPTIONS.find((option) => option.value === bulkAction)?.label ?? 'Bulk action',
  );
  const bulkConfirmLabel = $derived.by(() => {
    if (bulkPreview === null) return 'Confirm';

    const workflowCount = `${bulkPreview.matched} workflow${bulkPreview.matched === 1 ? '' : 's'}`;
    if (bulkPreviewedOperation?.action === 'cancel') return `Cancel ${workflowCount}`;
    if (bulkPreviewedOperation?.action === 'delete') return `Delete ${workflowCount}`;
    if (bulkPreviewedOperation?.action === 'signal') return `Signal ${workflowCount}`;
    if (bulkPreviewedOperation?.action === 'tag:add') return `Add tags to ${workflowCount}`;
    if (bulkPreviewedOperation?.action === 'tag:remove') {
      return `Remove tags from ${workflowCount}`;
    }
    return `Confirm ${workflowCount}`;
  });
  const bulkActionErrorTitle = $derived.by(() => {
    if (bulkActionErrorPhase === 'preview') return 'Bulk preview failed';
    if (bulkActionErrorPhase === 'commit') return 'Bulk confirmation failed';
    return 'Bulk action failed';
  });
  const bulkPreviewAnnouncement = $derived(
    bulkPreview === null
      ? ''
      : `Preview ready: ${bulkActionLabel.toLowerCase()} will affect ${bulkPreview.matched} workflow${bulkPreview.matched === 1 ? '' : 's'}.`,
  );
  const bulkPreviewScopeDetails = $derived.by((): BulkPreviewDetail[] => {
    if (bulkPreview === null) return [];
    const filter = bulkPreview.scope.filter;
    const details: BulkPreviewDetail[] = [];
    details.push({
      label: 'Status filter',
      value:
        filter.status === undefined
          ? 'Any'
          : Array.isArray(filter.status)
            ? filter.status.join(', ')
            : filter.status,
    });
    details.push({ label: 'Type filter', value: filter.type ?? 'Any' });
    details.push({ label: 'Tag filter', value: filter.tags?.join(', ') ?? 'Any' });
    if (filter.attributes !== undefined && filter.attributes.length > 0) {
      details.push({
        label: 'Attribute filters',
        value: `${filter.attributes.length} filter${filter.attributes.length === 1 ? '' : 's'}`,
      });
    }
    if (filter.limit !== undefined) {
      details.push({ label: 'Limit', value: String(filter.limit) });
    }
    if (filter.offset !== undefined) {
      details.push({ label: 'Offset', value: String(filter.offset) });
    }
    details.push({
      label: 'Matched statuses',
      value: bulkPreview.scope.statuses.join(', ') || 'None',
    });
    details.push({
      label: 'Matched types',
      value: bulkPreview.scope.workflowTypes.join(', ') || 'None',
    });
    details.push({
      label: 'Matched tenants',
      value: bulkPreview.scope.tenantIds.join(', ') || 'Unscoped',
    });
    return details;
  });
  const bulkPreviewActionDetails = $derived.by((): BulkPreviewDetail[] => {
    if (bulkPreviewedOperation === null) return [];
    if (bulkPreviewedOperation.action === 'signal') {
      return [
        { label: 'Signal', value: bulkPreviewedOperation.signalName ?? '' },
        { label: 'Payload', value: summarizeBulkPreviewValue(bulkPreviewedOperation.signalPayload) },
      ];
    }
    if (
      bulkPreviewedOperation.action === 'tag:add' ||
      bulkPreviewedOperation.action === 'tag:remove'
    ) {
      return [
        {
          label: bulkPreviewedOperation.action === 'tag:add' ? 'Tags to add' : 'Tags to remove',
          value: bulkPreviewedOperation.tags?.join(', ') ?? '',
        },
      ];
    }
    return [];
  });

  function createBulkRequestId(action: BulkWorkflowAction): string {
    return `dashboard:${action}:${Date.now().toString(36)}`;
  }

  function cloneBulkFilter(filter: ListFilter): ListFilter {
    return {
      ...(filter.status === undefined ? {} : { status: filter.status }),
      ...(filter.type === undefined ? {} : { type: filter.type }),
      ...(filter.tags === undefined ? {} : { tags: [...filter.tags] }),
      ...(filter.limit === undefined ? {} : { limit: filter.limit }),
      ...(filter.offset === undefined ? {} : { offset: filter.offset }),
    };
  }

  function summarizeBulkPreviewValue(value: unknown): string {
    if (value === undefined) return 'None';
    const serialized = JSON.stringify(value);
    if (serialized === undefined) return String(value);
    return serialized.length > 160 ? `${serialized.slice(0, 157)}...` : serialized;
  }

  async function handleBulkPreview(): Promise<void> {
    if (!canPreviewBulkAction || bulkPreviewLoading) return;

    const previewGeneration = bulkPreviewGeneration + 1;
    bulkPreviewGeneration = previewGeneration;
    const requestId = createBulkRequestId(bulkAction);
    const previewAction = bulkAction;
    const previewFilter = cloneBulkFilter(bulkFilter);
    const previewTags = [...bulkTags];
    const previewSignalName = bulkSignalName;
    const previewSignalPayloadResult = bulkSignalPayloadParseResult;
    bulkPreviewLoading = true;
    bulkPreview = null;
    bulkPreviewedOperation = null;
    bulkPreviewRequestId = null;
    bulkActionError = null;
    bulkActionErrorPhase = null;
    bulkActionMessage = null;

    try {
      let preview: BulkOperationDryRunResult;
      let previewedOperation: BulkPreviewedOperation;
      if (previewAction === 'cancel') {
        preview = await apiClient.previewBulkCancelWorkflows(previewFilter, requestId);
        previewedOperation = {
          action: previewAction,
          filter: previewFilter,
          requestId,
          confirmationToken: preview.confirmationToken,
        };
      } else if (previewAction === 'signal') {
        if (!previewSignalPayloadResult.ok) {
          if (previewGeneration === bulkPreviewGeneration) {
            bulkActionError = previewSignalPayloadResult.message;
            bulkActionErrorPhase = 'preview';
          }
          return;
        }
        preview = await apiClient.previewBulkSignalWorkflows(
          previewFilter,
          previewSignalName,
          previewSignalPayloadResult.value,
          requestId,
        );
        previewedOperation = {
          action: previewAction,
          filter: previewFilter,
          requestId,
          confirmationToken: preview.confirmationToken,
          signalName: previewSignalName,
          signalPayload: previewSignalPayloadResult.value,
        };
      } else if (previewAction === 'delete') {
        preview = await apiClient.previewBulkDeleteWorkflows(previewFilter, requestId);
        previewedOperation = {
          action: previewAction,
          filter: previewFilter,
          requestId,
          confirmationToken: preview.confirmationToken,
        };
      } else {
        const operation: BulkTagMutationOperation = previewAction === 'tag:add' ? 'add' : 'remove';
        preview = await apiClient.previewBulkTagWorkflows(
          previewFilter,
          previewTags,
          operation,
          requestId,
        );
        previewedOperation = {
          action: previewAction,
          filter: previewFilter,
          requestId,
          confirmationToken: preview.confirmationToken,
          tags: previewTags,
          tagOperation: operation,
        };
      }
      if (previewGeneration !== bulkPreviewGeneration) {
        return;
      }
      bulkPreview = preview;
      bulkPreviewedOperation = previewedOperation;
      bulkPreviewRequestId = requestId;
    } catch (previewError) {
      if (previewGeneration === bulkPreviewGeneration) {
        bulkActionError =
          previewError instanceof Error ? previewError.message : String(previewError);
        bulkActionErrorPhase = 'preview';
        bulkPreview = null;
        bulkPreviewedOperation = null;
        bulkPreviewRequestId = null;
      }
    } finally {
      if (previewGeneration === bulkPreviewGeneration) {
        bulkPreviewLoading = false;
      }
    }
  }

  async function handleBulkCommit(): Promise<void> {
    if (
      bulkPreview === null ||
      bulkPreviewedOperation === null ||
      bulkPreviewRequestId === null ||
      bulkPreviewLoading ||
      bulkCommitLoading
    ) {
      return;
    }

    bulkCommitLoading = true;
    bulkActionError = null;
    bulkActionErrorPhase = null;
    try {
      if (bulkPreviewedOperation.action === 'cancel') {
        const result = await apiClient.commitBulkCancelWorkflows(
          bulkPreviewedOperation.filter,
          bulkPreviewedOperation.confirmationToken,
          bulkPreviewedOperation.requestId,
        );
        bulkActionMessage = `Cancelled ${result.cancelled} workflow${result.cancelled === 1 ? '' : 's'}.`;
      } else if (bulkPreviewedOperation.action === 'signal') {
        const result = await apiClient.commitBulkSignalWorkflows(
          bulkPreviewedOperation.filter,
          bulkPreviewedOperation.signalName ?? '',
          bulkPreviewedOperation.signalPayload,
          bulkPreviewedOperation.confirmationToken,
          bulkPreviewedOperation.requestId,
        );
        bulkActionMessage = `Signalled ${result.signalled} workflow${result.signalled === 1 ? '' : 's'}.`;
      } else if (bulkPreviewedOperation.action === 'delete') {
        const result = await apiClient.commitBulkDeleteWorkflows(
          bulkPreviewedOperation.filter,
          bulkPreviewedOperation.confirmationToken,
          bulkPreviewedOperation.requestId,
        );
        bulkActionMessage = `Deleted ${result.deleted} workflow${result.deleted === 1 ? '' : 's'}.`;
      } else {
        const result = await apiClient.commitBulkTagWorkflows(
          bulkPreviewedOperation.filter,
          bulkPreviewedOperation.tags ?? [],
          bulkPreviewedOperation.tagOperation ?? 'add',
          bulkPreviewedOperation.confirmationToken,
          bulkPreviewedOperation.requestId,
        );
        bulkActionMessage = `Updated tags on ${result.modified} workflow${result.modified === 1 ? '' : 's'}.`;
      }
      bulkPreview = null;
      bulkPreviewedOperation = null;
      bulkPreviewRequestId = null;
      handleRefresh();
    } catch (commitError) {
      const message = commitError instanceof Error ? commitError.message : String(commitError);
      if (message.includes('confirmation token')) {
        bulkActionError = 'Preview expired. Run preview again before committing.';
        bulkPreview = null;
        bulkPreviewedOperation = null;
        bulkPreviewRequestId = null;
      } else {
        bulkActionError = message;
      }
      bulkActionErrorPhase = 'commit';
    } finally {
      bulkCommitLoading = false;
    }
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
      <span class="workflow-list-filter-icon" aria-hidden="true">
        <svg
          xmlns="http://www.w3.org/2000/svg"
          width="14"
          height="14"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="2"
          stroke-linecap="round"
          stroke-linejoin="round"
        >
          <polygon points="22 3 2 3 10 12.46 10 19 14 21 14 12.46 22 3" />
        </svg>
      </span>
      <select
        class="control"
        bind:value={statusFilter}
        onchange={resetFiltersAndBulkPreview}
      >
        {#each STATUS_OPTIONS as option (option.value)}
          <option value={option.value}>{option.label}</option>
        {/each}
      </select>
    </div>
    <div class="workflow-list-filter-group">
      <span class="workflow-list-filter-icon" aria-hidden="true">
        <svg
          xmlns="http://www.w3.org/2000/svg"
          width="14"
          height="14"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="2"
          stroke-linecap="round"
          stroke-linejoin="round"
        >
          <circle cx="11" cy="11" r="8" />
          <line x1="21" y1="21" x2="16.65" y2="16.65" />
        </svg>
      </span>
      <input
        class="control"
        type="text"
        placeholder="Filter by type..."
        bind:value={typeFilter}
        oninput={resetFiltersAndBulkPreview}
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

  <Card
    title="Bulk actions"
    subtitle={bulkFilterIsScoped ? `${total} workflow${total === 1 ? '' : 's'} in current scope` : 'Scope required'}
    icon={ban(14)}
  >
    <div class="bulk-actions">
      <div class="bulk-action-controls">
        <Select
          id="bulk-action"
          label="Action"
          bind:value={bulkAction}
          onchange={resetBulkPreview}
        >
          {#each BULK_ACTION_OPTIONS as option (option.value)}
            <option value={option.value}>{option.label}</option>
          {/each}
        </Select>

        {#if bulkActionNeedsSignal}
          <Input
            id="bulk-signal-name"
            label="Signal"
            placeholder="approve"
            bind:value={bulkSignalNameInput}
            oninput={resetBulkPreview}
          />
          <Input
            id="bulk-signal-payload"
            label="Payload JSON"
            placeholder={bulkSignalPayloadPlaceholder}
            bind:value={bulkSignalPayloadInput}
            oninput={resetBulkPreview}
          />
        {/if}

        {#if bulkActionNeedsTags}
          <Input
            id="bulk-action-tags"
            label="Tags"
            placeholder="nightly, archived"
            bind:value={bulkTagInput}
            oninput={resetBulkPreview}
          />
        {/if}

        <div class="bulk-action-buttons">
          <Button
            variant="secondary"
            size="md"
            icon={search(14)}
            label="Preview"
            disabled={!canPreviewBulkAction}
            loading={bulkPreviewLoading}
            onclick={handleBulkPreview}
          />
          <Button
            variant={bulkAction === 'delete' || bulkAction === 'cancel' ? 'danger' : 'primary'}
            size="md"
            icon={check(14)}
            label={bulkConfirmLabel}
            disabled={bulkPreview === null || bulkPreviewedOperation === null || bulkPreviewLoading}
            loading={bulkCommitLoading}
            onclick={handleBulkCommit}
          />
        </div>
      </div>

      {#if bulkActionError}
        <Alert
          variant="danger"
          title={bulkActionErrorTitle}
          description={bulkActionError}
        />
      {/if}

      {#if bulkActionNeedsSignal && !bulkSignalPayloadParseResult.ok}
        <Alert
          variant="warning"
          title="Invalid signal payload"
          description={bulkSignalPayloadParseResult.message}
        />
      {/if}

      {#if bulkActionMessage}
        <Alert
          variant="success"
          title="Bulk action committed"
          description={bulkActionMessage}
        />
      {/if}

      {#if bulkPreview}
        <div class="bulk-preview" role="status" aria-live="polite">
          <div class="bulk-preview-header">
            <div>
              <span class="bulk-preview-label">{bulkActionLabel}</span>
              <strong>{bulkPreview.matched}</strong>
              <p>{bulkPreviewAnnouncement}</p>
            </div>
            <span class="bulk-preview-token">{bulkPreview.requestId}</span>
          </div>

          {#if bulkPreviewActionDetails.length > 0}
            <dl class="bulk-preview-grid" aria-label="Bulk action details">
              {#each bulkPreviewActionDetails as detail (detail.label)}
                <div>
                  <dt>{detail.label}</dt>
                  <dd>{detail.value}</dd>
                </div>
              {/each}
            </dl>
          {/if}

          <dl class="bulk-preview-grid" aria-label="Bulk action scope">
            {#each bulkPreviewScopeDetails as detail (detail.label)}
              <div>
                <dt>{detail.label}</dt>
                <dd>{detail.value}</dd>
              </div>
            {/each}
          </dl>

          <div class="bulk-preview-samples" aria-label="Sample workflow IDs">
            {#each bulkPreview.sampleWorkflowIds as workflowId (workflowId)}
              <span>{workflowId}</span>
            {/each}
          </div>
        </div>
      {:else if !bulkFilterIsScoped}
        <div class="bulk-preview-empty">
          <span aria-hidden="true">
            <svg
              xmlns="http://www.w3.org/2000/svg"
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="2"
              stroke-linecap="round"
              stroke-linejoin="round"
            >
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </span>
          <span>Select a status, type, or tag filter before previewing.</span>
        </div>
      {/if}
    </div>
  </Card>

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

  {#if schedules.length > 0}
    <Card
      title="Schedules"
      subtitle={`${schedules.length} recurring workflow${schedules.length === 1 ? '' : 's'}`}
    >
      <ScheduleList {schedules} />
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

  .bulk-actions {
    display: flex;
    flex-direction: column;
    gap: var(--space-4, 1rem);
  }

  .bulk-action-controls {
    display: grid;
    gap: var(--space-3, 0.75rem);
    align-items: end;
  }

  @media (min-width: 860px) {
    .bulk-action-controls {
      grid-template-columns: minmax(10rem, 0.7fr) repeat(2, minmax(0, 1fr)) auto;
    }
  }

  .bulk-action-buttons {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-2, 0.5rem);
  }

  .bulk-preview {
    display: flex;
    flex-direction: column;
    gap: var(--space-3, 0.75rem);
    padding: var(--space-3, 0.75rem);
    border: 1px solid var(--border-muted, #e5e7eb);
    border-radius: var(--radius-md, 0.375rem);
    background: var(--surface-inset, #f9fafb);
  }

  .bulk-preview-header,
  .bulk-preview-grid {
    display: grid;
    gap: var(--space-3, 0.75rem);
  }

  @media (min-width: 720px) {
    .bulk-preview-header {
      grid-template-columns: minmax(0, 1fr) auto;
      align-items: center;
    }

    .bulk-preview-grid {
      grid-template-columns: repeat(3, minmax(0, 1fr));
    }
  }

  .bulk-preview-label,
  .bulk-preview-grid dt,
  .bulk-preview-token {
    display: block;
    font-size: var(--text-xs, 0.75rem);
    color: var(--text-muted, #6b7280);
  }

  .bulk-preview-header strong,
  .bulk-preview-grid dd {
    font-size: var(--text-sm, 0.875rem);
    color: var(--text, #111827);
  }

  .bulk-preview-header p,
  .bulk-preview-grid dd {
    margin: 0;
  }

  .bulk-preview-header p {
    color: var(--text-muted, #6b7280);
    font-size: var(--text-sm, 0.875rem);
  }

  .bulk-preview-token {
    font-family: var(--font-mono, ui-monospace, SFMono-Regular, Menlo, monospace);
    overflow-wrap: anywhere;
  }

  .bulk-preview-samples {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-2, 0.5rem);
  }

  .bulk-preview-samples span {
    max-width: 100%;
    padding: var(--space-1, 0.25rem) var(--space-2, 0.5rem);
    border-radius: var(--radius-sm, 0.25rem);
    background: var(--surface, #fff);
    border: 1px solid var(--border-muted, #e5e7eb);
    font-family: var(--font-mono, ui-monospace, SFMono-Regular, Menlo, monospace);
    font-size: var(--text-xs, 0.75rem);
    overflow-wrap: anywhere;
  }

  .bulk-preview-empty {
    display: flex;
    align-items: center;
    gap: var(--space-2, 0.5rem);
    color: var(--text-muted, #6b7280);
    font-size: var(--text-sm, 0.875rem);
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
