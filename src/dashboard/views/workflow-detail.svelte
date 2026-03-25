<script lang="ts" module>
  export type WorkflowDetailProps = {
    id: string;
  };
</script>

<script lang="ts">
  import { getContext, untrack } from 'svelte';

  import type { ApiClient, WorkflowState, WorkflowEvent } from '../api-client.ts';
  import { WebSocketClient } from '../websocket-client.ts';
  import { chevronLeft, xCircle } from '../icons.ts';
  import { navigate } from '../router.ts';
  import { formatRelativeTime, formatTimestamp } from '../utilities/format-date.ts';
  import { formatDuration } from '../utilities/format-duration.ts';
  import Page from '../components/page.svelte';
  import Card from '../components/card.svelte';
  import Button from '../components/button.svelte';
  import Alert from '../components/alert.svelte';
  import Skeleton from '../components/skeleton.svelte';
  import WorkflowStatusBadge from '../fragments/workflow-status-badge.svelte';
  import JsonViewer from '../fragments/json-viewer.svelte';
  import EventTimeline from '../fragments/event-timeline.svelte';
  import ExecutionDeadline from '../fragments/execution-deadline.svelte';
  import SearchAttributesTable from '../fragments/search-attributes-table.svelte';

  let { id }: WorkflowDetailProps = $props();

  const apiClient = getContext<ApiClient>('api-client');

  // ---------------------------------------------------------------------------
  // Data state
  // ---------------------------------------------------------------------------

  let workflow: WorkflowState | null = $state(null);
  let events: WorkflowEvent[] = $state([]);
  let attributes: Record<string, unknown> = $state({});
  let loading = $state(true);
  let error: string | null = $state(null);
  let cancelling = $state(false);

  // ---------------------------------------------------------------------------
  // Derived
  // ---------------------------------------------------------------------------

  const pageTitle = $derived(workflow?.type ?? 'Workflow');
  const pageSubtitle = $derived(id);
  const isRunning = $derived(workflow?.status === 'running' || workflow?.status === 'pending');
  const duration = $derived.by(() => {
    if (!workflow) return '-';
    return formatDuration(workflow.createdAt, workflow.updatedAt);
  });

  // ---------------------------------------------------------------------------
  // Fetching
  // ---------------------------------------------------------------------------

  async function fetchAll(): Promise<void> {
    try {
      const [workflowResult, eventsResult] = await Promise.all([
        apiClient.getWorkflow(id),
        apiClient.getWorkflowEvents(id),
      ]);

      workflow = workflowResult;
      events = Array.isArray(eventsResult) ? eventsResult : [];

      try {
        attributes = await apiClient.getWorkflowAttributes(id);
      } catch {
        attributes = {};
      }

      error = null;
    } catch (fetchError) {
      error = fetchError instanceof Error ? fetchError.message : String(fetchError);
    } finally {
      loading = false;
    }
  }

  // ---------------------------------------------------------------------------
  // WebSocket subscription
  // ---------------------------------------------------------------------------

  const websocketClient = new WebSocketClient();

  $effect(() => {
    fetchAll();

    const unsubscribe = websocketClient.subscribe(id, (event: WorkflowEvent) => {
      untrack(() => {
        events = [...events, event];

        // Re-fetch workflow state on terminal events
        if (
          event.type === 'workflow:completed' ||
          event.type === 'workflow:failed' ||
          event.type === 'workflow:cancelled' ||
          event.type === 'workflow:timed-out'
        ) {
          void apiClient.getWorkflow(id).then(
            (updated) => {
              workflow = updated;
              return undefined;
            },
            () => undefined,
          );
        }
      });
    });

    return () => {
      unsubscribe();
      websocketClient.dispose();
    };
  });

  // ---------------------------------------------------------------------------
  // Actions
  // ---------------------------------------------------------------------------

  async function handleCancel(): Promise<void> {
    cancelling = true;
    try {
      await apiClient.cancelWorkflow(id);
      workflow = await apiClient.getWorkflow(id);
    } catch (cancelError) {
      error = cancelError instanceof Error ? cancelError.message : String(cancelError);
    } finally {
      cancelling = false;
    }
  }

  function handleBackClick(): void {
    navigate('/ui/workflows');
  }
</script>

{#if loading}
  <div class="workflow-detail-loading">
    <Skeleton variant="text" width="12rem" height="2rem" />
    <Skeleton variant="text" width="20rem" height="1rem" />
    <div style="display: flex; gap: var(--space-4, 1rem); margin-top: var(--space-4, 1rem);">
      <div style="flex: 2; display: flex; flex-direction: column; gap: var(--space-4, 1rem);">
        <Skeleton variant="rounded" height="10rem" />
        <Skeleton variant="rounded" height="10rem" />
      </div>
      <div style="flex: 1; display: flex; flex-direction: column; gap: var(--space-4, 1rem);">
        <Skeleton variant="rounded" height="6rem" />
        <Skeleton variant="rounded" height="8rem" />
      </div>
    </div>
  </div>
{:else if error && !workflow}
  <Page title="Error">
    <Alert variant="danger" title="Failed to load workflow" description={error} />
    <Button variant="secondary" size="sm" icon={chevronLeft(14)} label="Back to Workflows" onclick={handleBackClick} />
  </Page>
{:else if workflow}
  <Page title={pageTitle} subtitle={pageSubtitle}>
    {#snippet actions()}
      <Button variant="ghost" size="sm" icon={chevronLeft(14)} label="Back" onclick={handleBackClick} />
      {#if isRunning}
        <Button
          variant="danger"
          size="sm"
          icon={xCircle(14)}
          label="Cancel"
          loading={cancelling}
          onclick={handleCancel}
        />
      {/if}
    {/snippet}

    <div class="workflow-detail-layout">
      <div class="workflow-detail-main">
        <Card title="Input">
          <JsonViewer data={workflow.input} />
        </Card>

        {#if workflow.status === 'completed'}
          <Card title="Result">
            <JsonViewer data={workflow.result} />
          </Card>
        {:else if workflow.status === 'failed' && workflow.error}
          <Card title="Error">
            <Alert variant="danger" title="Workflow Failed" description={workflow.error} />
          </Card>
        {/if}

        <Card title="Timeline" count={events.length}>
          <EventTimeline {events} />
        </Card>
      </div>

      <div class="workflow-detail-sidebar">
        <Card title="Status">
          <div class="workflow-detail-status-section">
            <div class="workflow-detail-status-badge">
              <WorkflowStatusBadge status={workflow.status} />
            </div>

            <div class="workflow-detail-info-list">
              <div class="workflow-detail-info-row">
                <span class="workflow-detail-info-label">Version</span>
                <span class="workflow-detail-info-value font-mono">{workflow.version}</span>
              </div>
              <div class="workflow-detail-info-row">
                <span class="workflow-detail-info-label">Created</span>
                <span class="workflow-detail-info-value">{formatTimestamp(workflow.createdAt)}</span>
              </div>
              <div class="workflow-detail-info-row">
                <span class="workflow-detail-info-label">Updated</span>
                <span class="workflow-detail-info-value">{formatRelativeTime(workflow.updatedAt)}</span>
              </div>
              <div class="workflow-detail-info-row">
                <span class="workflow-detail-info-label">Duration</span>
                <span class="workflow-detail-info-value font-mono">{duration}</span>
              </div>
            </div>

            {#if workflow.executionDeadline !== undefined}
              <ExecutionDeadline deadline={workflow.executionDeadline} />
            {/if}
          </div>
        </Card>

        {#if Object.keys(attributes).length > 0}
          <Card title="Search Attributes">
            <SearchAttributesTable {attributes} />
          </Card>
        {/if}
      </div>
    </div>
  </Page>
{/if}

<style>
  .workflow-detail-loading {
    display: flex;
    flex-direction: column;
    gap: var(--space-3, 0.75rem);
  }

  .workflow-detail-layout {
    display: grid;
    grid-template-columns: 1fr;
    gap: var(--space-4, 1rem);
  }

  @media (min-width: 768px) {
    .workflow-detail-layout {
      grid-template-columns: 2fr 1fr;
    }
  }

  .workflow-detail-main {
    display: flex;
    flex-direction: column;
    gap: var(--space-4, 1rem);
  }

  .workflow-detail-sidebar {
    display: flex;
    flex-direction: column;
    gap: var(--space-4, 1rem);
  }

  .workflow-detail-status-section {
    display: flex;
    flex-direction: column;
    gap: var(--space-3, 0.75rem);
  }

  .workflow-detail-status-badge {
    display: flex;
  }

  .workflow-detail-info-list {
    display: flex;
    flex-direction: column;
    gap: var(--space-1-5, 0.375rem);
  }

  .workflow-detail-info-row {
    display: flex;
    justify-content: space-between;
    align-items: baseline;
    font-size: var(--text-sm, 0.875rem);
  }

  .workflow-detail-info-label {
    color: var(--text-muted, #6b7280);
    font-size: var(--text-xs, 0.75rem);
  }

  .workflow-detail-info-value {
    font-size: var(--text-xs, 0.75rem);
  }
</style>
