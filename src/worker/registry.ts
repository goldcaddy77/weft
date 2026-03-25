// ---------------------------------------------------------------------------
// Server-side worker tracking and least-loaded routing
// ---------------------------------------------------------------------------

export interface WorkerInfo {
  id: string;
  activities: string[];
  concurrency: number;
  inFlight: number;
  connectedAt: number;
  lastHeartbeat: number;
}

export interface RoutingOptions {
  sticky?: string; // preferred worker ID for cache locality
  queue?: string;
}

export class WorkerRegistry {
  #workers: Map<string, WorkerInfo>;

  constructor() {
    this.#workers = new Map();
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

  /** Unregister a worker. Returns its info for reassignment of in-flight tasks. */
  unregister(workerId: string): WorkerInfo | undefined {
    const info = this.#workers.get(workerId);
    if (info !== undefined) {
      this.#workers.delete(workerId);
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

  /** Find the best worker for a task using least-loaded routing. */
  findWorker(activityName: string, options?: RoutingOptions): WorkerInfo | undefined {
    const candidates: WorkerInfo[] = [];

    for (const worker of this.#workers.values()) {
      if (worker.activities.includes(activityName) && worker.inFlight < worker.concurrency) {
        candidates.push(worker);
      }
    }

    if (candidates.length === 0) {
      return undefined;
    }

    // If a sticky preference is provided and that worker has capacity, use it.
    if (options?.sticky !== undefined) {
      const sticky = candidates.find((worker) => worker.id === options.sticky);
      if (sticky !== undefined) {
        return sticky;
      }
    }

    // Return the least-loaded worker (lowest inFlight count).
    candidates.sort((a, b) => a.inFlight - b.inFlight);
    return candidates[0];
  }

  /** Get all registered workers. */
  getAll(): WorkerInfo[] {
    return [...this.#workers.values()];
  }

  /** Get worker count. */
  get size(): number {
    return this.#workers.size;
  }
}
