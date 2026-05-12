// ---------------------------------------------------------------------------
// Server-side worker tracking and pluggable routing policies
// ---------------------------------------------------------------------------

export interface WorkerInfo {
  id: string;
  queue: string;
  activities: string[];
  concurrency: number;
  inFlight: number;
  connectedAt: number;
  lastHeartbeat: number;
}

/**
 * Per-worker projection reported by {@link WorkerRegistry.getWorkerSummaries}.
 * Derived view used by the public `weft.workers.list` operation and joined
 * into `weft.taskQueues.list` to compute per-queue in-flight totals. The
 * `now` parameter passed to `getWorkerSummaries` is the same `now` the
 * operation uses for queue-age math, so a single response is internally
 * consistent across both data sources.
 */
export type WorkerSummary = {
  id: string;
  queue: string;
  activities: string[];
  concurrency: number;
  inFlight: number;
  availableCapacity: number;
  connectedAt: number;
  lastHeartbeatAt: number;
  heartbeatAgeMs: number;
};

/**
 * Strategy used by {@link WorkerRegistry.findWorker} to pick among eligible workers.
 *
 * - `'least-loaded'` (default) picks the worker with the lowest `inFlight` count.
 *   Best general-purpose policy when tasks are roughly uniform.
 * - `'round-robin'` rotates through workers in registration order, giving each
 *   equal opportunity regardless of load. Useful when tasks are uniform and you
 *   want deterministic distribution for debugging or fairness across workers.
 * - `'fair-share'` picks the worker whose in-flight count for the current
 *   `fairShareKey` (e.g. tenant id) is lowest, preventing any single tenant from
 *   monopolizing capacity when tasks are heterogeneous.
 */
export type RoutingPolicy = 'least-loaded' | 'round-robin' | 'fair-share';

export interface RoutingOptions {
  /** Preferred worker ID for cache locality (wins when it still has capacity). */
  sticky?: string;
  queue?: string;
  /**
   * Partition key for `'fair-share'` routing. Typically a tenant or customer id.
   * Ignored by other policies. When omitted under `'fair-share'` the policy
   * degrades gracefully to `'least-loaded'`.
   */
  fairShareKey?: string;
}

export interface InFlightTask {
  operationId: string;
  workerId: string;
  deadline: number; // absolute timestamp
  visibilityTimeout: number; // original timeout duration in ms
  /** Optional fair-share partition key the task was assigned under. */
  fairShareKey?: string;
}

export interface WorkerRegistryOptions {
  /** Routing policy used by {@link WorkerRegistry.findWorker}. Default: `'least-loaded'`. */
  policy?: RoutingPolicy;
}

/**
 * Server-side registry of connected remote workers with pluggable routing
 * policies.
 *
 * Tracks which workers are connected, which activities they support, and how
 * many tasks they have in flight.  The `findWorker` method selects the best
 * worker for a given activity according to the configured {@link RoutingPolicy}
 * (`'least-loaded'` by default).  Used internally by `serve()` — most
 * applications access it through {@link WeftServer.registry}.
 *
 * @example
 * ```ts
 * import { WorkerRegistry } from 'weft';
 *
 * const registry = new WorkerRegistry({ policy: 'least-loaded' });
 *
 * registry.register({
 *   id: 'worker-1',
 *   queue: 'default',
 *   activities: ['sendEmail'],
 *   concurrency: 10,
 * });
 *
 * const best = registry.findWorker('sendEmail', { queue: 'default' });
 * console.log(best?.id); // 'worker-1'
 * ```
 */
export class WorkerRegistry {
  #workers: Map<string, WorkerInfo>;
  #inFlightTasks: Map<string, InFlightTask>;
  #policy: RoutingPolicy;
  /**
   * Rotating cursor for round-robin routing, keyed by `${queue}::${activity}`.
   * The eligible-worker set is `(queue ∩ activity ∩ has-capacity)`, so two
   * activities sharing one queue must not contend for the same cursor — that
   * would let an activity-A request advance the cursor past an activity-A-only
   * worker because the previous request was for activity B.
   */
  #roundRobinCursor: Map<string, number>;
  /**
   * Inflight counts per worker per fair-share key. Outer key is `workerId`,
   * inner key is the fair-share key. Nested maps avoid the collision risk of
   * a flat `${workerId}::${key}` key when either segment can contain the
   * separator. Incremented on assignment and decremented on completion so
   * fair-share can pick the worker that carries the fewest in-flight tasks
   * for the requesting key.
   */
  #fairShareCounts: Map<string, Map<string, number>>;

  constructor(options?: WorkerRegistryOptions) {
    this.#workers = new Map();
    this.#inFlightTasks = new Map();
    this.#policy = options?.policy ?? 'least-loaded';
    this.#roundRobinCursor = new Map();
    this.#fairShareCounts = new Map();
  }

  /** The routing policy this registry was configured with. */
  get policy(): RoutingPolicy {
    return this.#policy;
  }

  /** Register a worker. */
  register(info: Omit<WorkerInfo, 'connectedAt' | 'lastHeartbeat' | 'inFlight'>): void {
    const now = Date.now();

    this.#workers.set(info.id, {
      ...info,
      inFlight: 0,
      connectedAt: now,
      lastHeartbeat: now,
    });
  }

  /**
   * Unregister a worker. Returns its info for reassignment of in-flight tasks.
   *
   * Purges any fair-share counters and in-flight task entries that referenced
   * this worker so the registry never carries stale rows after a forced
   * removal, crash recovery, or reset path that bypasses the per-task
   * `completeTask` loop.
   */
  unregister(workerId: string): WorkerInfo | undefined {
    const info = this.#workers.get(workerId);
    if (info === undefined) {
      return undefined;
    }

    this.#workers.delete(workerId);
    this.#fairShareCounts.delete(workerId);

    // Deleting from a Map during `for..of` iteration over that same Map is
    // safe per ECMAScript §23.1.3.5: already-visited entries are not
    // revisited, and entries deleted before being visited are skipped.
    for (const [operationId, task] of this.#inFlightTasks) {
      if (task.workerId === workerId) {
        this.#inFlightTasks.delete(operationId);
      }
    }

    return info;
  }

  /** Record a heartbeat from a worker. */
  heartbeat(workerId: string): void {
    const info = this.#workers.get(workerId);
    if (info !== undefined) {
      info.lastHeartbeat = Date.now();
    }
  }

  /** Increment in-flight count for a worker. */
  taskAssigned(workerId: string): void {
    const info = this.#workers.get(workerId);
    if (info !== undefined) {
      info.inFlight += 1;
    }
  }

  /** Decrement in-flight count. */
  taskCompleted(workerId: string): void {
    const info = this.#workers.get(workerId);
    if (info !== undefined) {
      info.inFlight = Math.max(0, info.inFlight - 1);
    }
  }

  /**
   * Find the best worker for a task using the configured {@link RoutingPolicy}.
   *
   * Common preconditions for every policy:
   * 1. If `options.queue` is set, only workers on that queue are considered.
   * 2. Only workers that advertise `activityName` in their `activities` list are
   *    considered.
   * 3. Workers at `inFlight >= concurrency` are excluded.
   * 4. A `sticky` worker that also satisfies the above wins regardless of policy.
   */
  // oxlint-disable-next-line complexity -- ID:worker-registry-find-worker-complexity
  findWorker(activityName: string, options?: RoutingOptions): WorkerInfo | undefined {
    const queue = options?.queue;
    const stickyId = options?.sticky;
    const fairShareKey = options?.fairShareKey;

    const eligible: WorkerInfo[] = [];
    let stickyCandidate: WorkerInfo | undefined;

    for (const worker of this.#workers.values()) {
      if (queue !== undefined && worker.queue !== queue) continue;
      if (!worker.activities.includes(activityName)) continue;
      if (worker.inFlight >= worker.concurrency) continue;

      if (stickyId !== undefined && worker.id === stickyId) {
        stickyCandidate = worker;
      }

      eligible.push(worker);
    }

    if (stickyCandidate !== undefined) return stickyCandidate;
    if (eligible.length === 0) return undefined;

    switch (this.#policy) {
      case 'round-robin':
        return this.#pickRoundRobin(eligible, queue, activityName);
      case 'fair-share':
        if (fairShareKey !== undefined) {
          return this.#pickFairShare(eligible, queue, fairShareKey);
        }
        // Missing key — fall through to least-loaded to stay deterministic.
        return pickLeastLoaded(eligible);
      case 'least-loaded':
      default:
        return pickLeastLoaded(eligible);
    }
  }

  /**
   * Round-robin over eligible workers in stable registration order. Cursor
   * state is keyed by `(queue, activity)` so two activities sharing one queue
   * don't contend for the same cursor — otherwise an activity-A request could
   * advance the cursor past an activity-A-only worker just because the
   * previous request was for activity B.
   */
  #pickRoundRobin(
    eligible: WorkerInfo[],
    queue: string | undefined,
    activityName: string,
  ): WorkerInfo {
    // `eligible` preserves the registration order from `this.#workers.values()`
    // because `Map` iteration order is insertion order. No per-call sort
    // needed — the cursor is stable as long as the worker set is stable.
    const key = `${queue ?? '__default__'}::${activityName}`;
    const cursor = this.#roundRobinCursor.get(key) ?? 0;
    const pick = eligible[cursor % eligible.length]!;
    this.#roundRobinCursor.set(key, cursor + 1);
    return pick;
  }

  /**
   * Fair-share: pick the worker that currently carries the fewest in-flight
   * tasks *for this fairShareKey*. This spreads one tenant's tasks across
   * workers so no worker becomes the "tenant X worker". Ties are broken by
   * overall inFlight count, then by stable worker id order.
   */
  // oxlint-disable-next-line complexity -- ID:worker-registry-pick-fair-share-complexity
  #pickFairShare(
    eligible: WorkerInfo[],
    _queue: string | undefined,
    fairShareKey: string,
  ): WorkerInfo {
    let best = eligible[0]!;
    let bestKeyLoad = this.#fairShareCounts.get(best.id)?.get(fairShareKey) ?? 0;

    for (let index = 1; index < eligible.length; index += 1) {
      const candidate = eligible[index]!;
      const candidateKeyLoad = this.#fairShareCounts.get(candidate.id)?.get(fairShareKey) ?? 0;

      if (candidateKeyLoad < bestKeyLoad) {
        best = candidate;
        bestKeyLoad = candidateKeyLoad;
        continue;
      }
      if (candidateKeyLoad > bestKeyLoad) continue;

      // Tiebreak on overall load, then stable id.
      if (
        candidate.inFlight < best.inFlight ||
        (candidate.inFlight === best.inFlight && candidate.id < best.id)
      ) {
        best = candidate;
        bestKeyLoad = candidateKeyLoad;
      }
    }
    return best;
  }

  /** Track a task assignment with a visibility timeout deadline. */
  assignTask(
    workerId: string,
    operationId: string,
    visibilityTimeout: number,
    fairShareKey?: string,
  ): void {
    const deadline = Date.now() + visibilityTimeout;

    const task: InFlightTask = {
      operationId,
      workerId,
      deadline,
      visibilityTimeout,
    };
    if (fairShareKey !== undefined) {
      task.fairShareKey = fairShareKey;
      let workerCounts = this.#fairShareCounts.get(workerId);
      if (workerCounts === undefined) {
        workerCounts = new Map();
        this.#fairShareCounts.set(workerId, workerCounts);
      }
      workerCounts.set(fairShareKey, (workerCounts.get(fairShareKey) ?? 0) + 1);
    }
    this.#inFlightTasks.set(operationId, task);

    this.taskAssigned(workerId);
  }

  /** Return tasks whose deadline has passed and remove them from tracking. */
  checkExpiredTasks(now: number): InFlightTask[] {
    const expired: InFlightTask[] = [];

    for (const task of this.#inFlightTasks.values()) {
      if (task.deadline <= now) {
        expired.push(task);
      }
    }

    for (const task of expired) {
      this.#inFlightTasks.delete(task.operationId);
      this.#releaseFairShare(task);
    }

    return expired;
  }

  /** Extend the visibility timeout deadline for an in-flight task (heartbeat).
   *  Resets the deadline to `now + extension` so each heartbeat grants exactly
   *  one visibility window rather than accumulating on top of a future deadline.
   *  Returns the new deadline, or `undefined` if the task was not found. */
  extendVisibility(operationId: string, extension: number): number | undefined {
    const task = this.#inFlightTasks.get(operationId);
    if (task !== undefined) {
      task.deadline = Date.now() + extension;
      return task.deadline;
    }
    return undefined;
  }

  /** Return all in-flight tasks assigned to a given worker. */
  getWorkerTasks(workerId: string): InFlightTask[] {
    const tasks: InFlightTask[] = [];
    for (const task of this.#inFlightTasks.values()) {
      if (task.workerId === workerId) {
        tasks.push(task);
      }
    }
    return tasks;
  }

  /** Check whether an operation is currently assigned to a worker. */
  isAssigned(operationId: string): boolean {
    return this.#inFlightTasks.has(operationId);
  }

  /** Look up an in-flight task by operationId in O(1). */
  getTask(operationId: string): InFlightTask | undefined {
    return this.#inFlightTasks.get(operationId);
  }

  /** Complete an in-flight task: remove tracking and decrement the worker's counter. */
  completeTask(operationId: string): InFlightTask | undefined {
    const task = this.#inFlightTasks.get(operationId);
    if (task === undefined) return undefined;

    this.#inFlightTasks.delete(operationId);
    this.taskCompleted(task.workerId);
    this.#releaseFairShare(task);
    return task;
  }

  /** Look up a worker by ID. */
  getWorker(workerId: string): WorkerInfo | undefined {
    return this.#workers.get(workerId);
  }

  /** Get all registered workers. */
  getAll(): WorkerInfo[] {
    return [...this.#workers.values()];
  }

  /**
   * Stable, sorted-by-id snapshot of every connected worker for the public
   * `weft.workers.list` operation. The caller passes a per-request `now`
   * so heartbeat ages across the response use one consistent clock; the
   * same `now` should be reused by the task-queue operation when both run
   * in the same request to keep the join honest.
   */
  getWorkerSummaries(now: number): WorkerSummary[] {
    const summaries: WorkerSummary[] = [];
    for (const worker of this.#workers.values()) {
      const inFlight = worker.inFlight;
      const concurrency = worker.concurrency;
      summaries.push({
        id: worker.id,
        queue: worker.queue,
        activities: [...worker.activities],
        concurrency,
        inFlight,
        availableCapacity: Math.max(0, concurrency - inFlight),
        connectedAt: worker.connectedAt,
        lastHeartbeatAt: worker.lastHeartbeat,
        heartbeatAgeMs: now - worker.lastHeartbeat,
      });
    }
    return summaries.toSorted((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  }

  /** Get worker count. */
  get size(): number {
    return this.#workers.size;
  }

  /** Decrement the fair-share count for a completed or expired task. */
  #releaseFairShare(task: InFlightTask): void {
    if (task.fairShareKey === undefined) return;
    const workerCounts = this.#fairShareCounts.get(task.workerId);
    if (workerCounts === undefined) return;
    const current = workerCounts.get(task.fairShareKey) ?? 0;
    const next = Math.max(0, current - 1);
    if (next === 0) {
      workerCounts.delete(task.fairShareKey);
      if (workerCounts.size === 0) {
        this.#fairShareCounts.delete(task.workerId);
      }
    } else {
      workerCounts.set(task.fairShareKey, next);
    }
  }
}

/**
 * Pick the worker with the lowest in-flight count. Ties broken by stable
 * worker id ordering so the choice is deterministic across runs.
 */
function pickLeastLoaded(eligible: WorkerInfo[]): WorkerInfo {
  let best = eligible[0]!;
  for (let index = 1; index < eligible.length; index += 1) {
    const candidate = eligible[index]!;
    if (
      candidate.inFlight < best.inFlight ||
      (candidate.inFlight === best.inFlight && candidate.id < best.id)
    ) {
      best = candidate;
    }
  }
  return best;
}
