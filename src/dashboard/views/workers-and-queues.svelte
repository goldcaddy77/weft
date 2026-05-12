<script lang="ts">
  import { getContext, untrack } from 'svelte';

  import type {
    ApiClient,
    ListTaskQueuesResponse,
    ListWorkersResponse,
    TaskQueueHealth,
    WorkerSummary,
  } from '../api-client.ts';
  import { cpu } from '../icons.ts';
  import Alert from '../components/alert.svelte';
  import Badge from '../components/badge.svelte';
  import Card from '../components/card.svelte';
  import EmptyState from '../components/empty-state.svelte';
  import Page from '../components/page.svelte';
  import Skeleton from '../components/skeleton.svelte';

  const apiClient = getContext<ApiClient>('api-client');

  // ---------------------------------------------------------------------------
  // Data state
  // ---------------------------------------------------------------------------
  // `$state.raw` keeps the deep-proxy cost off these wholesale-replaced
  // arrays — every tick replaces the array reference, never mutates entries.

  let workers = $state.raw<WorkerSummary[]>([]);
  let queues = $state.raw<TaskQueueHealth[]>([]);
  let routingPolicy = $state<ListWorkersResponse['routingPolicy'] | null>(null);
  let initialLoading = $state(true);
  let workersError = $state<string | null>(null);
  let queuesError = $state<string | null>(null);

  // ---------------------------------------------------------------------------
  // Fetching
  // ---------------------------------------------------------------------------

  let fetchGeneration = 0;

  async function fetchOnce(signal: AbortSignal): Promise<void> {
    const generation = ++fetchGeneration;
    const [workersResult, queuesResult] = await Promise.allSettled([
      apiClient.listWorkers(),
      apiClient.listTaskQueues(),
    ]);

    if (signal.aborted || generation !== fetchGeneration) return;

    handleWorkersResult(workersResult);
    handleQueuesResult(queuesResult);
    initialLoading = false;
  }

  function handleWorkersResult(result: PromiseSettledResult<ListWorkersResponse>): void {
    if (result.status === 'fulfilled') {
      workers = result.value.items;
      routingPolicy = result.value.routingPolicy;
      workersError = null;
    } else {
      workersError = errorMessage(result.reason);
    }
  }

  function handleQueuesResult(result: PromiseSettledResult<ListTaskQueuesResponse>): void {
    if (result.status === 'fulfilled') {
      queues = result.value.items;
      queuesError = null;
    } else {
      queuesError = errorMessage(result.reason);
    }
  }

  function errorMessage(reason: unknown): string {
    return reason instanceof Error ? reason.message : String(reason);
  }

  $effect(() => {
    const controller = new AbortController();
    let interval: ReturnType<typeof setInterval> | null = null;

    // Polling lifecycle is scheduled here so the cleanup function tears down
    // both the interval and the visibilitychange listener in one place. The
    // initial fetch runs untracked to avoid registering api-client reads as
    // dependencies of this effect.
    untrack(() => {
      void fetchOnce(controller.signal);
    });

    function startInterval(): void {
      interval = setInterval(() => {
        if (!document.hidden && !controller.signal.aborted) {
          void fetchOnce(controller.signal);
        }
      }, 5_000);
    }

    function handleVisibility(): void {
      if (!document.hidden && interval === null) {
        void fetchOnce(controller.signal);
        startInterval();
      } else if (document.hidden && interval !== null) {
        clearInterval(interval);
        interval = null;
      }
    }

    startInterval();
    document.addEventListener('visibilitychange', handleVisibility);

    return () => {
      controller.abort();
      if (interval !== null) clearInterval(interval);
      document.removeEventListener('visibilitychange', handleVisibility);
    };
  });

  // ---------------------------------------------------------------------------
  // Formatting
  // ---------------------------------------------------------------------------

  function formatAge(ms: number | null): string {
    if (ms === null) return '—';
    if (ms < 1_000) return `${Math.max(0, Math.round(ms))}ms`;
    if (ms < 60_000) return `${(ms / 1_000).toFixed(1)}s`;
    if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m ${Math.floor((ms % 60_000) / 1_000)}s`;
    return `${Math.floor(ms / 3_600_000)}h ${Math.floor((ms % 3_600_000) / 60_000)}m`;
  }

  function formatTimestamp(epochMs: number): string {
    return new Date(epochMs).toLocaleString();
  }
</script>

<Page title="Workers & Queues" icon={cpu(20)}>
  {#if !initialLoading && workersError !== null && queuesError !== null}
    <Alert
      variant="danger"
      title="Failed to load workers and task queues"
      description="Both observability endpoints are returning errors. Check the server logs."
    />
  {/if}
  <Card title="Workers" description="Connected long-poll and WebSocket workers, their advertised activities, and current saturation.">
    {#snippet actions()}
      {#if routingPolicy !== null}
        <Badge variant="accent" label={`routing: ${routingPolicy}`} />
      {/if}
    {/snippet}

    {#if initialLoading}
      <Skeleton variant="rounded" height="6rem" />
    {:else if workersError !== null}
      <Alert variant="danger" title="Failed to load workers" description={workersError} />
    {:else if workers.length === 0}
      <EmptyState
        icon={cpu(32)}
        title="No connected workers"
        description="The fleet is empty. Start a worker process to register one with this server."
      />
    {:else}
      <div class="table-wrapper">
        <table class="data-table">
          <caption class="sr-only">Connected workers</caption>
          <thead>
            <tr>
              <th scope="col">Worker ID</th>
              <th scope="col">Queue</th>
              <th scope="col" class="activities-col">Activities</th>
              <th scope="col">In-flight / Capacity</th>
              <th scope="col">Heartbeat age</th>
              <th scope="col">Connected at</th>
            </tr>
          </thead>
          <tbody>
            {#each workers as worker (worker.id)}
              {@const ratioPercent =
                worker.concurrency === 0
                  ? 0
                  : Math.min(100, Math.round((worker.inFlight / worker.concurrency) * 100))}
              <tr>
                <td class="cell-id">{worker.id}</td>
                <td>{worker.queue}</td>
                <td class="activities-cell">
                  <div class="chip-row">
                    {#each worker.activities as activityName (activityName)}
                      <Badge code={true} label={activityName} truncate={24} />
                    {/each}
                  </div>
                </td>
                <td>
                  <span class="capacity">
                    <span
                      class="capacity-bar"
                      role="meter"
                      aria-label={`In-flight tasks for ${worker.id}`}
                      aria-valuemin="0"
                      aria-valuemax="100"
                      aria-valuenow={ratioPercent}
                      aria-valuetext={`${worker.inFlight} of ${worker.concurrency} slots in use (${ratioPercent}%)`}
                      style:--capacity-fill={`${ratioPercent}%`}
                    ></span>
                    <span class="capacity-text" aria-hidden="true"
                      >{worker.inFlight} / {worker.concurrency}</span
                    >
                  </span>
                </td>
                <td>{formatAge(worker.heartbeatAgeMs)}</td>
                <td>{formatTimestamp(worker.connectedAt)}</td>
              </tr>
            {/each}
          </tbody>
        </table>
      </div>
    {/if}
  </Card>

  <Card title="Task queues" description="Per-queue backlog, oldest queued task age, waiting pollers, and scheduling policy.">
    {#if initialLoading}
      <Skeleton variant="rounded" height="6rem" />
    {:else if queuesError !== null}
      <Alert variant="danger" title="Failed to load task queues" description={queuesError} />
    {:else if queues.length === 0}
      <EmptyState
        icon={cpu(32)}
        title="No task queues"
        description="No queues currently carry pending tasks, parked pollers, or connected workers."
      />
    {:else}
      <div class="table-wrapper">
        <table class="data-table">
          <caption class="sr-only">Task queues</caption>
          <thead>
            <tr>
              <th scope="col">Queue</th>
              <th scope="col">Backlog</th>
              <th scope="col">Oldest age</th>
              <th scope="col">Waiting pollers</th>
              <th scope="col">In-flight</th>
              <th scope="col">Workers</th>
              <th scope="col">Policy</th>
            </tr>
          </thead>
          <tbody>
            {#each queues as queue (queue.queue)}
              <tr>
                <td class="cell-id">{queue.queue}</td>
                <td>{queue.backlog}</td>
                <td>{formatAge(queue.oldestQueuedAgeMs)}</td>
                <td>{queue.waitingPollers}</td>
                <td>{queue.inFlight}</td>
                <td>{queue.connectedWorkers}</td>
                <td><Badge code={true} label={queue.schedulingPolicy} /></td>
              </tr>
            {/each}
          </tbody>
        </table>
      </div>
    {/if}
  </Card>
</Page>

<style>
  .table-wrapper {
    width: 100%;
    overflow-x: auto;
  }

  .data-table {
    width: 100%;
    border-collapse: collapse;
    font-size: var(--text-sm, 0.875rem);
  }

  .data-table th,
  .data-table td {
    text-align: left;
    padding: var(--space-2, 0.5rem) var(--space-3, 0.75rem);
    border-bottom: 1px solid var(--border-muted, #e5e7eb);
    vertical-align: middle;
  }

  .data-table th {
    font-weight: var(--font-semibold, 600);
    color: var(--text-muted, #6b7280);
    text-transform: uppercase;
    font-size: var(--text-xs, 0.75rem);
    letter-spacing: 0.04em;
  }

  .cell-id {
    font-family: var(--font-mono, ui-monospace, monospace);
    color: var(--text, #111827);
  }

  .activities-col {
    max-width: 20rem;
  }

  .activities-cell {
    max-width: 20rem;
  }

  .chip-row {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-1, 0.25rem);
  }

  .capacity {
    display: inline-flex;
    flex-direction: column;
    gap: var(--space-1, 0.25rem);
    min-width: 5rem;
  }

  .capacity-text {
    font-variant-numeric: tabular-nums;
  }

  .capacity-bar {
    display: block;
    height: 0.25rem;
    border-radius: 999px;
    background: var(--surface-raised, #e5e7eb);
    position: relative;
    overflow: hidden;
  }

  .capacity-bar::after {
    content: '';
    position: absolute;
    inset: 0;
    width: var(--capacity-fill);
    background: var(--accent, #2563eb);
    border-radius: 999px;
  }
</style>
