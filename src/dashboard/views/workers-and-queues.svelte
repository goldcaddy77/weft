<script lang="ts">
  import { getContext, untrack } from 'svelte';
  import { SvelteMap } from 'svelte/reactivity';

  import type {
    ApiClient,
    ListTaskQueuesResponse,
    ListWorkersResponse,
    TaskQueueHealth,
    WorkerDeploymentSummary,
    WorkerHealth,
    WorkerSummary,
  } from '../api-client.ts';
  import { cpu } from '../icons.ts';
  import Alert from '../components/alert.svelte';
  import Badge from '../components/badge.svelte';
  import type { BadgeVariant } from '../components/badge.svelte';
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
  let deployments = $state.raw<WorkerDeploymentSummary[]>([]);
  let queues = $state.raw<TaskQueueHealth[]>([]);
  let routingPolicy = $state<ListWorkersResponse['routingPolicy'] | null>(null);
  let initialLoading = $state(true);
  let workersError = $state<string | null>(null);
  let queuesError = $state<string | null>(null);
  const activeMutationCounts = new SvelteMap<string, number>();
  let mutationError = $state<string | null>(null);

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
      deployments = result.value.deployments;
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

  async function refreshNow(): Promise<void> {
    await fetchOnce(new AbortController().signal);
  }

  async function runMutation(key: string, mutation: () => Promise<unknown>): Promise<void> {
    addActiveMutation(key);
    mutationError = null;
    try {
      await mutation();
      await refreshNow();
    } catch (error) {
      mutationError = errorMessage(error);
    } finally {
      removeActiveMutation(key);
    }
  }

  function addActiveMutation(key: string): void {
    activeMutationCounts.set(key, (activeMutationCounts.get(key) ?? 0) + 1);
  }

  function removeActiveMutation(key: string): void {
    const currentCount = activeMutationCounts.get(key) ?? 0;
    if (currentCount <= 1) {
      activeMutationCounts.delete(key);
    } else {
      activeMutationCounts.set(key, currentCount - 1);
    }
  }

  function isMutationActive(key: string): boolean {
    return activeMutationCounts.has(key);
  }

  function deploymentIdentityKey(deployment: WorkerDeploymentSummary): string {
    return JSON.stringify([
      deployment.deploymentName,
      deployment.buildId,
      deployment.runtimeVersion,
      deployment.gitSha,
    ]);
  }

  function deploymentMutationKey(deploymentName: string): string {
    return `deployment:${deploymentName}`;
  }

  function workerMutationKey(workerId: string): string {
    return `worker:${workerId}`;
  }

  function drainWorker(worker: WorkerSummary): void {
    void runMutation(workerMutationKey(worker.id), () => apiClient.drainWorker(worker.id));
  }

  function resumeWorker(worker: WorkerSummary): void {
    void runMutation(workerMutationKey(worker.id), () => apiClient.clearWorkerDrain(worker.id));
  }

  function drainDeployment(deployment: WorkerDeploymentSummary): void {
    const deploymentName = deployment.deploymentName;
    if (deploymentName === null) return;
    void runMutation(deploymentMutationKey(deploymentName), () =>
      apiClient.drainDeployment(deploymentName),
    );
  }

  function resumeDeployment(deployment: WorkerDeploymentSummary): void {
    const deploymentName = deployment.deploymentName;
    if (deploymentName === null) return;
    void runMutation(deploymentMutationKey(deploymentName), () =>
      apiClient.clearDeploymentDrain(deploymentName),
    );
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

  function formatOptional(value: string | null | undefined): string {
    return value ?? '—';
  }

  function healthVariant(health: WorkerHealth): BadgeVariant {
    if (health === 'active') return 'success';
    if (health === 'draining') return 'warning';
    return 'danger';
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
  {#if mutationError !== null}
    <Alert variant="danger" title="Drain operation failed" description={mutationError} />
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
              <th scope="col">Health</th>
              <th scope="col">Deployment</th>
              <th scope="col">Queue</th>
              <th scope="col" class="activities-col">Activities</th>
              <th scope="col">In-flight / Capacity</th>
              <th scope="col">Heartbeat age</th>
              <th scope="col">Connected at</th>
              <th scope="col">Actions</th>
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
                <td><Badge variant={healthVariant(worker.health)} label={worker.health} /></td>
                <td>
                  <div class="identity-cell">
                    <span>{formatOptional(worker.deploymentName)}</span>
                    {#if worker.buildId !== undefined}
                      <Badge code={true} size="xs" label={worker.buildId} truncate={18} />
                    {/if}
                  </div>
                </td>
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
                <td>
                  <button
                    class="table-action"
                    type="button"
                    disabled={isMutationActive(workerMutationKey(worker.id))}
                    onclick={() =>
                      worker.health === 'active' ? drainWorker(worker) : resumeWorker(worker)}
                  >
                    {worker.health === 'active' ? 'Drain' : 'Resume'}
                  </button>
                </td>
              </tr>
            {/each}
          </tbody>
        </table>
      </div>
    {/if}
  </Card>

  <Card title="Worker deployments" description="Deployment identity, aggregate health, and drain controls for registered worker builds.">
    {#if initialLoading}
      <Skeleton variant="rounded" height="6rem" />
    {:else if workersError !== null}
      <Alert variant="danger" title="Failed to load worker deployments" description={workersError} />
    {:else if deployments.length === 0}
      <EmptyState
        icon={cpu(32)}
        title="No worker deployments"
        description="No connected workers have reported deployment identity yet."
      />
    {:else}
      <div class="table-wrapper">
        <table class="data-table">
          <caption class="sr-only">Worker deployments</caption>
          <thead>
            <tr>
              <th scope="col">Deployment</th>
              <th scope="col">Build</th>
              <th scope="col">Runtime</th>
              <th scope="col">Health</th>
              <th scope="col">Workers</th>
              <th scope="col">In-flight</th>
              <th scope="col">Oldest start</th>
              <th scope="col">Actions</th>
            </tr>
          </thead>
          <tbody>
            {#each deployments as deployment (deploymentIdentityKey(deployment))}
              <tr>
                <td class="cell-id">{formatOptional(deployment.deploymentName)}</td>
                <td>{formatOptional(deployment.buildId)}</td>
                <td>{formatOptional(deployment.runtimeVersion)}</td>
                <td><Badge variant={healthVariant(deployment.health)} label={deployment.health} /></td>
                <td>
                  <span class="worker-counts">
                    {deployment.workers}
                    <span class="muted-count">
                      {deployment.activeWorkers} active / {deployment.drainingWorkers} draining /
                      {deployment.drainedWorkers} drained
                    </span>
                  </span>
                </td>
                <td>{deployment.inFlight}</td>
                <td>
                  {deployment.oldestStartedAt === null
                    ? '—'
                    : formatTimestamp(deployment.oldestStartedAt)}
                </td>
                <td>
                  {#if deployment.deploymentName !== null}
                    <button
                      class="table-action"
                      type="button"
                      disabled={isMutationActive(deploymentMutationKey(deployment.deploymentName))}
                      onclick={() =>
                        deployment.health === 'active'
                          ? drainDeployment(deployment)
                          : resumeDeployment(deployment)}
                    >
                      {deployment.health === 'active' ? 'Drain' : 'Resume'}
                    </button>
                  {:else}
                    <span class="muted-count">—</span>
                  {/if}
                </td>
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

  .identity-cell {
    display: inline-flex;
    flex-direction: column;
    gap: var(--space-1, 0.25rem);
    min-width: 8rem;
  }

  .worker-counts {
    display: inline-flex;
    flex-direction: column;
    gap: var(--space-0-5, 0.125rem);
    font-variant-numeric: tabular-nums;
  }

  .muted-count {
    color: var(--text-subtle, #9ca3af);
    font-size: var(--text-xs, 0.75rem);
    white-space: nowrap;
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

  .table-action {
    border: 1px solid var(--border-muted, #e5e7eb);
    border-radius: var(--radius-sm, 0.25rem);
    background: var(--surface-raised, #fff);
    color: var(--text, #111827);
    font-size: var(--text-xs, 0.75rem);
    font-weight: var(--font-medium, 500);
    line-height: 1;
    min-width: 4.5rem;
    padding: var(--space-1, 0.25rem) var(--space-2, 0.5rem);
  }

  .table-action:hover:not(:disabled) {
    background: var(--surface-inset, #f3f4f6);
  }

  .table-action:disabled {
    color: var(--text-disabled, #9ca3af);
    cursor: not-allowed;
  }
</style>
