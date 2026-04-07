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

  // The raw `events` buffer feeds the Timeline display and is capped so a
  // long-running agent emitting thousands of token events cannot grow memory
  // unbounded. Once the cap is exceeded the oldest events are dropped from
  // the timeline only — the derived aggregates (`turns`, `tokensUsed`,
  // `costUsed`, `tokenBudget`, `maxCost`) are NOT derived from this buffer.
  // They are held as durable `$state` and updated incrementally by
  // `applyEvent`, so eviction cannot silently corrupt running totals or the
  // budget gauge.
  const MAX_EVENT_BUFFER = 2000;

  let workflow: WorkflowState | null = $state(null);
  let events: WorkflowEvent[] = $state([]);
  let totalEventsReceived = $state(0);
  let loading = $state(true);
  let error: string | null = $state(null);
  let cancelling = $state(false);
  let streamingText = $state('');
  let fetchGeneration = 0;

  // Durable agent aggregates — updated incrementally in `applyEvent`, NEVER
  // derived from the evicting `events` buffer. `turnMap` is the authoritative
  // store; `turns` is a sorted snapshot that mirrors it for rendering.
  let turnMap: Map<number, AgentTurnData> = $state(new Map());
  let turns: AgentTurnData[] = $state([]);
  let tokensUsed = $state(0);
  let costUsed = $state(0);
  let tokenBudget: number | undefined = $state(undefined);
  let maxCost: number | undefined = $state(undefined);

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

  function applyCompletedTurnEvent(data: WorkflowEvent['data']): void {
    const turnIndex = readEventNumber(data, 'turnIndex', 0);
    const turn = getOrCreateTurn(turnIndex, data);
    turn.model = readEventString(data, 'model', turn.model);
    turn.inputTokens = readEventNumber(data, 'inputTokens', turn.inputTokens);
    turn.outputTokens = readEventNumber(data, 'outputTokens', turn.outputTokens);
    turn.cost = readEventNumber(data, 'cost', turn.cost);
  }

  function applyToolCalledEvent(data: WorkflowEvent['data']): void {
    const turnIndex = readEventNumber(data, 'turnIndex', 0);
    const turn = getOrCreateTurn(turnIndex);
    turn.toolCalls.push({
      name: readEventString(data, 'toolName', 'unknown'),
      input: data['toolInput'] ?? null,
      output: null,
    });
  }

  function applyToolReturnedEvent(data: WorkflowEvent['data']): void {
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

  // Incremental aggregate update. Called once per event (both on WS arrival
  // and on initial fetch replay), updating the durable `turnMap`/`turns`/
  // budget/total state in place. This is what makes eviction of the raw
  // `events` buffer safe — the aggregates never rebuild from that buffer.
  function ingestAgentEvent(event: WorkflowEvent): void {
    switch (event.type) {
      case 'agent:turn:completed':
        applyCompletedTurnEvent(event.data);
        refreshTurnsSnapshot();
        break;
      case 'agent:tool:called':
        applyToolCalledEvent(event.data);
        refreshTurnsSnapshot();
        break;
      case 'agent:tool:returned':
        applyToolReturnedEvent(event.data);
        refreshTurnsSnapshot();
        break;
      case 'agent:budget:warning':
      case 'agent:budget:exceeded': {
        const budget = event.data['tokenBudget'] as number | undefined;
        if (budget !== undefined) tokenBudget = budget;
        if (event.type === 'agent:budget:exceeded') {
          const max = event.data['maxCost'] as number | undefined;
          if (max !== undefined) maxCost = max;
        }
        break;
      }
    }
  }

  function refreshTurnsSnapshot(): void {
    // Rebuild the sorted snapshot plus running totals from the authoritative
    // turnMap. Cost here is O(k) in number of turns, not O(n) in events.
    const sorted = Array.from(turnMap.values()).toSorted((a, b) => a.turnIndex - b.turnIndex);
    turns = sorted;
    let nextTokens = 0;
    let nextCost = 0;
    for (const turn of sorted) {
      nextTokens += turn.inputTokens + turn.outputTokens;
      nextCost += turn.cost;
    }
    tokensUsed = nextTokens;
    costUsed = nextCost;
  }

  function resetAgentAggregates(): void {
    turnMap = new Map();
    turns = [];
    tokensUsed = 0;
    costUsed = 0;
    tokenBudget = undefined;
    maxCost = undefined;
  }

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
      // Replay the full fetched history into the durable aggregates (so
      // turnMap, budgets, and running totals reflect every event even if
      // the visible timeline buffer is capped).
      resetAgentAggregates();
      for (const event of fetched) {
        ingestAgentEvent(event);
      }
      totalEventsReceived = fetched.length;
      // Timeline buffer itself is capped — older events are dropped from
      // the visible list only, not from the aggregates above.
      events =
        fetched.length > MAX_EVENT_BUFFER
          ? fetched.slice(fetched.length - MAX_EVENT_BUFFER)
          : fetched;
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
    totalEventsReceived = 0;
    resetAgentAggregates();
    const generation = ++fetchGeneration;

    // Buffer WS events that arrive while the initial fetch is in-flight so they
    // are not silently discarded when fetchAll overwrites the events array.
    let fetchSettled = false;
    const pendingWebSocketEvents: WorkflowEvent[] = [];

    function applyEvent(event: WorkflowEvent): void {
      // Durable aggregates first — these never evict.
      ingestAgentEvent(event);
      totalEventsReceived += 1;

      // Then append to the timeline buffer, dropping the oldest entry if
      // the cap is exceeded so the visible timeline stays bounded.
      if (events.length >= MAX_EVENT_BUFFER) {
        events = [...events.slice(events.length - MAX_EVENT_BUFFER + 1), event];
      } else {
        events = [...events, event];
      }

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
      <Card title="Timeline" count={totalEventsReceived}>
        {#if totalEventsReceived > events.length}
          <p class="timeline-truncated-notice">
            Showing the most recent {events.length} of {totalEventsReceived} events. Earlier events were
            dropped from the view; aggregates and budgets above remain accurate.
          </p>
        {/if}
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

  .timeline-truncated-notice {
    margin: 0 0 var(--space-3, 0.75rem);
    padding: var(--space-2, 0.5rem) var(--space-3, 0.75rem);
    background: var(--surface-muted, rgba(0, 0, 0, 0.04));
    border-radius: var(--radius-sm, 0.25rem);
    font-size: var(--text-xs, 0.75rem);
    color: var(--text-muted, #6b7280);
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
