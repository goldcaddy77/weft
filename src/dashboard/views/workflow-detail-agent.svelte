<script lang="ts" module>
  export type WorkflowDetailAgentProps = {
    id: string;
  };
</script>

<script lang="ts">
  import { getContext, untrack } from 'svelte';

  import type { ApiClient, WorkflowState, WorkflowEvent } from '../api-client.ts';
  import type { AgentTurnData } from '../fragments/agent-turn.svelte';
  import { WebSocketClient } from '../websocket-client.svelte.ts';
  import { chevronLeft, xCircle, bot } from '../icons.ts';
  import { navigate } from '../router.svelte.ts';
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
  import AgentTurn from '../fragments/agent-turn.svelte';
  import AgentBudgetGauge from '../fragments/agent-budget-gauge.svelte';

  let { id }: WorkflowDetailAgentProps = $props();

  const apiClient = getContext<ApiClient>('api-client');

  // ---------------------------------------------------------------------------
  // Data state
  // ---------------------------------------------------------------------------

  // Cap the in-memory event buffer so a long-running agent emitting thousands
  // of token events cannot grow memory unbounded or slow the per-event
  // `buildAgentTurns` recomputation linearly. When the cap is exceeded the
  // oldest events are dropped; agent turns and budget totals derived from the
  // most recent events stay accurate, and the full history remains available
  // by reloading the page (which re-fetches via the API).
  const MAX_EVENT_BUFFER = 2000;

  let workflow: WorkflowState | null = $state(null);
  let events: WorkflowEvent[] = $state([]);
  let loading = $state(true);
  let error: string | null = $state(null);
  let cancelling = $state(false);
  let streamingText = $state('');
  let fetchGeneration = 0;

  function readEventString(
    data: WorkflowEvent['data'],
    key: string,
    fallback: string,
  ): string {
    const value = data[key];
    return typeof value === 'string' ? value : fallback;
  }

  function readEventNumber(
    data: WorkflowEvent['data'],
    key: string,
    fallback: number,
  ): number {
    const value = data[key];
    return typeof value === 'number' ? value : fallback;
  }

  function createAgentTurn(
    turnIndex: number,
    data?: WorkflowEvent['data'],
  ): AgentTurnData {
    return {
      turnIndex,
      model: data ? readEventString(data, 'model', 'unknown') : 'unknown',
      inputTokens: data ? readEventNumber(data, 'inputTokens', 0) : 0,
      outputTokens: data ? readEventNumber(data, 'outputTokens', 0) : 0,
      cost: data ? readEventNumber(data, 'cost', 0) : 0,
      toolCalls: [],
      response: '',
    };
  }

  function getOrCreateTurn(
    turnMap: Map<number, AgentTurnData>,
    turnIndex: number,
    data?: WorkflowEvent['data'],
  ): AgentTurnData {
    const existingTurn = turnMap.get(turnIndex);
    if (existingTurn) {
      return existingTurn;
    }

    const turn = createAgentTurn(turnIndex, data);
    turnMap.set(turnIndex, turn);
    return turn;
  }

  function applyCompletedTurnEvent(
    turnMap: Map<number, AgentTurnData>,
    data: WorkflowEvent['data'],
  ): void {
    const turnIndex = readEventNumber(data, 'turnIndex', 0);
    const turn = getOrCreateTurn(turnMap, turnIndex, data);
    turn.model = readEventString(data, 'model', turn.model);
    turn.inputTokens = readEventNumber(data, 'inputTokens', turn.inputTokens);
    turn.outputTokens = readEventNumber(data, 'outputTokens', turn.outputTokens);
    turn.cost = readEventNumber(data, 'cost', turn.cost);
  }

  function applyToolCalledEvent(
    turnMap: Map<number, AgentTurnData>,
    data: WorkflowEvent['data'],
  ): void {
    const turnIndex = readEventNumber(data, 'turnIndex', 0);
    const turn = getOrCreateTurn(turnMap, turnIndex);
    turn.toolCalls.push({
      name: readEventString(data, 'toolName', 'unknown'),
      input: data['toolInput'] ?? null,
      output: null,
    });
  }

  function applyToolReturnedEvent(
    turnMap: Map<number, AgentTurnData>,
    data: WorkflowEvent['data'],
  ): void {
    const turnIndex = readEventNumber(data, 'turnIndex', 0);
    const toolName = readEventString(data, 'toolName', '');
    const turn = turnMap.get(turnIndex);
    if (!turn) {
      return;
    }

    const matchingCall = turn.toolCalls.find((toolCall) => {
      return toolCall.name === toolName && toolCall.output === null;
    });
    if (matchingCall) {
      matchingCall.output = data['result'] ?? { success: data['success'] };
    }
  }

  function buildAgentTurns(workflowEvents: WorkflowEvent[]): AgentTurnData[] {
    const turnMap = new Map<number, AgentTurnData>();

    for (const event of workflowEvents) {
      switch (event.type) {
        case 'agent:turn:completed':
          applyCompletedTurnEvent(turnMap, event.data);
          break;
        case 'agent:tool:called':
          applyToolCalledEvent(turnMap, event.data);
          break;
        case 'agent:tool:returned':
          applyToolReturnedEvent(turnMap, event.data);
          break;
      }
    }

    return Array.from(turnMap.values()).toSorted((a, b) => a.turnIndex - b.turnIndex);
  }

  // ---------------------------------------------------------------------------
  // Agent-specific derived state
  // ---------------------------------------------------------------------------

  const turns: AgentTurnData[] = $derived.by(() => buildAgentTurns(events));

  const tokensUsed = $derived(turns.reduce((sum, turn) => sum + turn.inputTokens + turn.outputTokens, 0));
  const costUsed = $derived(turns.reduce((sum, turn) => sum + turn.cost, 0));

  const tokenBudget = $derived.by(() => {
    for (const event of events) {
      if (event.type === 'agent:budget:exceeded' || event.type === 'agent:budget:warning') {
        const budget = event.data['tokenBudget'] as number | undefined;
        if (budget !== undefined) return budget;
      }
    }
    return undefined;
  });

  const maxCost = $derived.by(() => {
    for (const event of events) {
      if (event.type === 'agent:budget:exceeded') {
        const max = event.data['maxCost'] as number | undefined;
        if (max !== undefined) return max;
      }
    }
    return undefined;
  });

  const pageTitle = $derived(workflow?.type ?? 'Agent Workflow');
  const isRunning = $derived(workflow?.status === 'running' || workflow?.status === 'pending');
  const duration = $derived.by(() => {
    if (!workflow) return '-';
    return formatDuration(workflow.createdAt, workflow.updatedAt);
  });

  // ---------------------------------------------------------------------------
  // Fetching
  // ---------------------------------------------------------------------------

  async function fetchAll(generation: number): Promise<void> {
    try {
      const [workflowResult, eventsResult] = await Promise.all([
        apiClient.getWorkflow(id),
        apiClient.getWorkflowEvents(id),
      ]);

      if (generation !== fetchGeneration) return;

      workflow = workflowResult;
      const fetched = Array.isArray(eventsResult) ? eventsResult : [];
      events = fetched.length > MAX_EVENT_BUFFER ? fetched.slice(fetched.length - MAX_EVENT_BUFFER) : fetched;
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
  // WebSocket subscription
  // ---------------------------------------------------------------------------

  const websocketClient = new WebSocketClient();

  $effect(() => {
    loading = true;
    streamingText = '';
    const generation = ++fetchGeneration;

    // Buffer WS events that arrive while the initial fetch is in-flight so they
    // are not silently discarded when fetchAll overwrites the events array.
    let fetchSettled = false;
    const pendingWebSocketEvents: WorkflowEvent[] = [];

    function applyEvent(event: WorkflowEvent): void {
      const next = [...events, event];
      events = next.length > MAX_EVENT_BUFFER ? next.slice(next.length - MAX_EVENT_BUFFER) : next;

      // Accumulate streaming tokens
      if (event.type === 'agent:token') {
        streamingText += (event.data['token'] as string) ?? '';
      }

      // Clear streaming text on turn completion
      if (event.type === 'agent:turn:completed') {
        streamingText = '';
      }

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
          (refetchError) => {
            console.warn('[workflow-detail-agent] Failed to re-fetch workflow on terminal event:', refetchError);
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
    navigate('/ui/workflows');
  }
</script>

{#if loading}
  <div class="workflow-detail-agent-loading">
    <Skeleton variant="text" width="12rem" height="2rem" />
    <Skeleton variant="rounded" height="4rem" />
    <Skeleton variant="rounded" height="10rem" />
  </div>
{:else if error && !workflow}
  <Page title="Error">
    <Alert variant="danger" title="Failed to load workflow" description={error} />
    <Button variant="secondary" size="sm" icon={chevronLeft(14)} label="Back to Workflows" onclick={handleBackClick} />
  </Page>
{:else if workflow}
  <Page title={pageTitle} subtitle={id}>
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

    <div class="workflow-detail-agent-content">
      <!-- Status and Budget Row -->
      <div class="workflow-detail-agent-top">
        <Card title="Status">
          <div class="workflow-detail-agent-status">
            <WorkflowStatusBadge status={workflow.status} />
            <div class="workflow-detail-agent-meta">
              <span class="text-muted" style="font-size: var(--text-xs);">
                {formatTimestamp(workflow.createdAt)} &middot; {duration}
              </span>
              {#if workflow.executionDeadline !== undefined}
                <ExecutionDeadline deadline={workflow.executionDeadline} createdAt={workflow.createdAt} />
              {/if}
            </div>
          </div>
        </Card>

        <Card title="Budget" icon={bot(16)}>
          <AgentBudgetGauge
            {tokensUsed}
            {tokenBudget}
            {costUsed}
            {maxCost}
          />
        </Card>
      </div>

      <!-- Streaming Output (if running) -->
      {#if isRunning && streamingText}
        <Card title="Current Output">
          <div class="streaming-output">
            <pre class="streaming-output-text">{streamingText}<span class="streaming-cursor">|</span></pre>
          </div>
        </Card>
      {/if}

      <!-- Agent Turns -->
      {#if turns.length > 0}
        <Card title="Agent Turns" count={turns.length}>
          <div class="agent-turns-list">
            {#each turns as turn (turn.turnIndex)}
              <AgentTurn {turn} />
            {/each}
          </div>
        </Card>
      {/if}

      <!-- Input/Result -->
      <div class="workflow-detail-agent-data-row">
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
      </div>

      <!-- Timeline -->
      <Card title="Timeline" count={events.length}>
        <EventTimeline {events} />
      </Card>
    </div>
  </Page>
{/if}

<style>
  .workflow-detail-agent-loading {
    display: flex;
    flex-direction: column;
    gap: var(--space-3, 0.75rem);
  }

  .workflow-detail-agent-content {
    display: flex;
    flex-direction: column;
    gap: var(--space-4, 1rem);
  }

  .workflow-detail-agent-top {
    display: grid;
    grid-template-columns: 1fr;
    gap: var(--space-4, 1rem);
  }

  @media (min-width: 768px) {
    .workflow-detail-agent-top {
      grid-template-columns: 1fr 1fr;
    }
  }

  .workflow-detail-agent-status {
    display: flex;
    flex-direction: column;
    gap: var(--space-2, 0.5rem);
  }

  .workflow-detail-agent-meta {
    display: flex;
    flex-direction: column;
    gap: var(--space-1, 0.25rem);
  }

  .agent-turns-list {
    display: flex;
    flex-direction: column;
    gap: var(--space-3, 0.75rem);
  }

  .workflow-detail-agent-data-row {
    display: grid;
    grid-template-columns: 1fr;
    gap: var(--space-4, 1rem);
  }

  @media (min-width: 768px) {
    .workflow-detail-agent-data-row {
      grid-template-columns: 1fr 1fr;
    }
  }

  .streaming-output {
    max-height: 20rem;
    overflow: auto;
  }

  .streaming-output-text {
    font-size: var(--text-sm, 0.875rem);
    line-height: var(--leading-relaxed, 1.625);
    white-space: pre-wrap;
    word-break: break-word;
  }

  .streaming-cursor {
    animation: blink 1s step-end infinite;
    color: var(--accent, #6366f1);
  }

  @keyframes blink {
    0%,
    100% {
      opacity: 1;
    }
    50% {
      opacity: 0;
    }
  }

  @media (prefers-reduced-motion: reduce) {
    .streaming-cursor {
      animation: none;
    }
  }
</style>
