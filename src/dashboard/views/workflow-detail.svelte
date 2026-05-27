<script lang="ts" module>
  export type WorkflowDetailProps = {
    id: string;
  };
</script>

<script lang="ts">
  import { getContext, untrack } from 'svelte';

  import type {
    ApiClient,
    WorkflowEvent,
    WorkflowReplay,
    WorkflowState,
    WorkflowTimelineEntry,
  } from '../api-client.ts';
  import { WebSocketClient } from '../websocket-client.svelte.ts';
  import { chevronLeft, xCircle } from '../icons.ts';
  import { navigate } from '../router.svelte.ts';
  import { formatRelativeTime, formatTimestamp } from '../utilities/format-date.ts';
  import { formatDuration } from '../utilities/format-duration.ts';
  import {
    clearWorkflowTimelineInspectionState,
    loadTerminalWorkflowDetailRefresh,
    synchronizeWorkflowTimelineInspectionState,
    type SynchronizeWorkflowTimelineInspectionOptions,
    type WorkflowTimelineInspectionState,
  } from '../utilities/workflow-detail-timeline.ts';
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
  import WorkflowExecutionTimeline from '../fragments/workflow-execution-timeline.svelte';
  import {
    buildWorkflowTimelineDiff,
    WorkflowTimelineRequestGuard,
    type WorkflowTimelineDiffRow,
  } from '../fragments/workflow-execution-timeline.ts';

  let { id }: WorkflowDetailProps = $props();

  const apiClient = getContext<ApiClient>('api-client');

  // ---------------------------------------------------------------------------
  // Data state
  // ---------------------------------------------------------------------------

  let workflow: WorkflowState | null = $state(null);
  let events: WorkflowEvent[] = $state([]);
  let attributes: Record<string, unknown> = $state({});
  let timeline: WorkflowTimelineEntry[] = $state([]);
  let selectedTimelineStep: number | null = $state(null);
  let selectedTimelineReplay: WorkflowReplay | null = $state(null);
  let selectedTimelineReplayLoading = $state(false);
  let selectedTimelineReplayError: string | null = $state(null);
  let timelineError: string | null = $state(null);
  let timelineDiffFromStep = $state('');
  let timelineDiffToStep = $state('');
  let timelineDiffRows: WorkflowTimelineDiffRow[] = $state([]);
  let timelineDiffLoading = $state(false);
  let timelineDiffError: string | null = $state(null);
  const timelineReplayRequests = new WorkflowTimelineRequestGuard();
  const timelineDiffRequests = new WorkflowTimelineRequestGuard();
  let loading = $state(true);
  let error: string | null = $state(null);
  let cancelling = $state(false);
  let fetchGeneration = 0;

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

  function readTimelineInspectionState(): WorkflowTimelineInspectionState {
    return {
      selectedStep: selectedTimelineStep,
      diffFromStep: timelineDiffFromStep,
      diffToStep: timelineDiffToStep,
      diffRows: timelineDiffRows,
      diffLoading: timelineDiffLoading,
      diffError: timelineDiffError,
    };
  }

  function applyTimelineInspectionState(state: WorkflowTimelineInspectionState): void {
    selectedTimelineStep = state.selectedStep;
    timelineDiffFromStep = state.diffFromStep;
    timelineDiffToStep = state.diffToStep;
    timelineDiffRows = state.diffRows;
    timelineDiffLoading = state.diffLoading;
    timelineDiffError = state.diffError;
  }

  function resetTimelineInspectionState(): void {
    timelineReplayRequests.createRequestToken();
    timelineDiffRequests.createRequestToken();
    selectedTimelineReplay = null;
    selectedTimelineReplayLoading = false;
    selectedTimelineReplayError = null;
    applyTimelineInspectionState(clearWorkflowTimelineInspectionState());
  }

  function synchronizeTimelineSelection(
    nextTimeline: WorkflowTimelineEntry[],
    options: SynchronizeWorkflowTimelineInspectionOptions = {},
  ): number | null {
    timeline = nextTimeline;

    if (nextTimeline.length === 0 || options.resetDiff === true) {
      timelineReplayRequests.createRequestToken();
      timelineDiffRequests.createRequestToken();
      selectedTimelineReplay = null;
      selectedTimelineReplayLoading = false;
      selectedTimelineReplayError = null;
    }

    const nextState = synchronizeWorkflowTimelineInspectionState(
      nextTimeline,
      readTimelineInspectionState(),
      options,
    );

    applyTimelineInspectionState(nextState);
    return nextState.selectedStep;
  }

  async function loadTimelineReplay(step: number, generation = fetchGeneration): Promise<void> {
    const requestToken = timelineReplayRequests.createRequestToken();
    selectedTimelineStep = step;
    selectedTimelineReplayLoading = true;
    selectedTimelineReplayError = null;

    try {
      const replay = await apiClient.replayWorkflowTo(id, step);
      if (generation !== fetchGeneration || !timelineReplayRequests.isCurrentRequest(requestToken)) {
        return;
      }

      selectedTimelineReplay = replay;
      if (replay === null) {
        selectedTimelineReplayError = `No retained checkpoint state for step ${step}.`;
      }
    } catch (replayError) {
      if (generation !== fetchGeneration || !timelineReplayRequests.isCurrentRequest(requestToken)) {
        return;
      }
      selectedTimelineReplay = null;
      selectedTimelineReplayError =
        replayError instanceof Error ? replayError.message : String(replayError);
    } finally {
      if (generation === fetchGeneration && timelineReplayRequests.isCurrentRequest(requestToken)) {
        selectedTimelineReplayLoading = false;
      }
    }
  }

  async function refreshTimeline(
    generation: number,
    options: SynchronizeWorkflowTimelineInspectionOptions = {},
  ): Promise<void> {
    try {
      const timelineResult = await apiClient.getWorkflowTimeline(id);
      if (generation !== fetchGeneration) return;

      const step = synchronizeTimelineSelection(timelineResult, options);
      timelineError = null;

      if (step !== null) {
        void loadTimelineReplay(step, generation);
      }
    } catch (timelineFetchError) {
      if (generation !== fetchGeneration) return;
      timeline = [];
      resetTimelineInspectionState();
      timelineError =
        timelineFetchError instanceof Error
          ? timelineFetchError.message
          : String(timelineFetchError);
    }
  }

  async function fetchAll(generation: number): Promise<void> {
    try {
      const [workflowResult, eventsResult] = await Promise.all([
        apiClient.getWorkflow(id),
        apiClient.getWorkflowEvents(id),
      ]);

      if (generation !== fetchGeneration) return;

      workflow = workflowResult;
      events = Array.isArray(eventsResult) ? eventsResult : [];
      void refreshTimeline(generation, { resetDiff: true });

      try {
        attributes = await apiClient.getWorkflowAttributes(id);
      } catch {
        if (generation === fetchGeneration) {
          attributes = {};
        }
      }

      if (generation === fetchGeneration) {
        error = null;
      }
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
  // WebSocket subscription
  // ---------------------------------------------------------------------------

  const websocketClient = new WebSocketClient();

  $effect(() => {
    loading = true;
    timeline = [];
    timelineError = null;
    resetTimelineInspectionState();
    const generation = ++fetchGeneration;

    // Buffer WS events that arrive while the initial fetch is in-flight so they
    // are not silently discarded when fetchAll overwrites the events array.
    let fetchSettled = false;
    const pendingWebSocketEvents: WorkflowEvent[] = [];

    function applyEvent(event: WorkflowEvent): void {
      events = [...events, event];

      // Re-fetch workflow state on terminal events
      if (
        event.type === 'workflow:completed' ||
        event.type === 'workflow:failed' ||
        event.type === 'workflow:cancelled' ||
        event.type === 'workflow:timed-out'
      ) {
        const eventGeneration = generation;
        void loadTerminalWorkflowDetailRefresh({
          loadWorkflow: () => apiClient.getWorkflow(id),
          loadTimeline: () => apiClient.getWorkflowTimeline(id),
        }).then(
          (terminalRefresh) => {
            if (eventGeneration !== fetchGeneration) return undefined;

            if (terminalRefresh.status === 'workflow-failed') {
              console.warn(
                '[workflow-detail] Failed to re-fetch workflow on terminal event:',
                terminalRefresh.error,
              );
              return undefined;
            }

            workflow = terminalRefresh.workflow;

            if (terminalRefresh.timeline === null) {
              timeline = [];
              resetTimelineInspectionState();
              timelineError = terminalRefresh.timelineError;
              return undefined;
            }

            const step = synchronizeTimelineSelection(terminalRefresh.timeline);
            timelineError = null;
            if (step !== null) {
              void loadTimelineReplay(step, eventGeneration);
            }
            return undefined;
          },
          (refetchError) => {
            if (eventGeneration !== fetchGeneration) return undefined;
            console.warn(
              '[workflow-detail] Failed to re-fetch workflow on terminal event:',
              refetchError,
            );
            return undefined;
          },
        );
      }
    }

    void fetchAll(generation).then(
      () => {
        if (generation !== fetchGeneration) return undefined;
        fetchSettled = true;
        // Replay any WS events that arrived while the fetch was in-flight.
        for (const buffered of pendingWebSocketEvents) {
          applyEvent(buffered);
        }
        pendingWebSocketEvents.length = 0;
        return undefined;
      },
      () => undefined,
    );

    const unsubscribe = websocketClient.subscribe(id, (event: WorkflowEvent) => {
      untrack(() => {
        if (!fetchSettled) {
          // Fetch hasn't resolved yet — buffer so we can merge after.
          pendingWebSocketEvents.push(event);
        } else {
          applyEvent(event);
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
    navigate('/workflows');
  }

  function handleSelectTimelineStep(step: number): void {
    void loadTimelineReplay(step);
  }

  async function handleCompareTimelineSteps(): Promise<void> {
    const fromStep = Number(timelineDiffFromStep);
    const toStep = Number(timelineDiffToStep);

    if (!Number.isInteger(fromStep) || !Number.isInteger(toStep)) {
      timelineDiffError = 'Choose two checkpoint steps to compare.';
      return;
    }

    if (fromStep === toStep) {
      timelineDiffError = 'Choose two different checkpoint steps to compare.';
      return;
    }

    timelineDiffLoading = true;
    timelineDiffError = null;
    const generation = fetchGeneration;
    const requestToken = timelineDiffRequests.createRequestToken();
    const requestedFromStep = timelineDiffFromStep;
    const requestedToStep = timelineDiffToStep;

    try {
      const [fromReplay, toReplay] = await Promise.all([
        apiClient.replayWorkflowTo(id, fromStep),
        apiClient.replayWorkflowTo(id, toStep),
      ]);

      if (
        generation !== fetchGeneration ||
        !timelineDiffRequests.isCurrentRequest(requestToken) ||
        requestedFromStep !== timelineDiffFromStep ||
        requestedToStep !== timelineDiffToStep
      ) {
        return;
      }

      if (fromReplay === null || toReplay === null) {
        timelineDiffRows = [];
        timelineDiffError = `No retained checkpoint state for diff ${fromStep} -> ${toStep}.`;
        return;
      }

      timelineDiffRows = buildWorkflowTimelineDiff(fromReplay, toReplay);
    } catch (compareError) {
      if (
        generation !== fetchGeneration ||
        !timelineDiffRequests.isCurrentRequest(requestToken) ||
        requestedFromStep !== timelineDiffFromStep ||
        requestedToStep !== timelineDiffToStep
      ) {
        return;
      }
      timelineDiffRows = [];
      timelineDiffError = compareError instanceof Error ? compareError.message : String(compareError);
    } finally {
      if (generation === fetchGeneration && timelineDiffRequests.isCurrentRequest(requestToken)) {
        timelineDiffLoading = false;
      }
    }
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

        <Card title="Execution Trace" count={timeline.length}>
          {#if timelineError}
            <Alert variant="danger" title="Failed to load timeline" description={timelineError} />
          {:else}
            <WorkflowExecutionTimeline
              {timeline}
              selectedStep={selectedTimelineStep}
              selectedReplay={selectedTimelineReplay}
              selectedReplayLoading={selectedTimelineReplayLoading}
              selectedReplayError={selectedTimelineReplayError}
              diffRows={timelineDiffRows}
              diffLoading={timelineDiffLoading}
              diffError={timelineDiffError}
              bind:fromStep={timelineDiffFromStep}
              bind:toStep={timelineDiffToStep}
              onSelectStep={handleSelectTimelineStep}
              onCompareSteps={handleCompareTimelineSteps}
            />
          {/if}
        </Card>

        <Card title="Events" count={events.length}>
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
              <ExecutionDeadline deadline={workflow.executionDeadline} createdAt={workflow.createdAt} />
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
