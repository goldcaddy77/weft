/**
 * `weft.task.queues.list` operation + REST binding.
 *
 * Reports per-queue health for the operator dashboard: backlog,
 * oldest-queued age, waiting long-poll pollers, in-flight task count,
 * connected worker count, and scheduling policy.
 *
 * The queue set is the union of three sources, merged inside the
 * operation:
 *   1. `taskQueue.getQueueSummaries()` — queues with pending tasks or
 *      waiters (TaskQueue-owned state).
 *   2. `registry.getWorkerSummaries(now).map(w => w.queue)` — queues with
 *      connected workers, so an idle queue with no backlog still appears
 *      in the response.
 * The same `now` snapshot is shared with the worker registry to keep
 * per-request data internally consistent.
 *
 * Access is `system:read`. The `TaskQueue` is server-wide infrastructure
 * and is never tenant-partitioned.
 *
 * @module server/operations/list-task-queues
 */

import { z } from 'zod';

import type { WorkerRegistry, WorkerSummary } from '../../worker/registry.ts';
import { FAULT_CODE_TO_HTTP_STATUS, type OperationFault } from '../operation-fault.ts';
import { defineOperation } from '../operation-registry.ts';
import type { UnknownRestBinding } from '../rest-bindings.ts';
import type { SchedulingPolicy, TaskQueue, TaskQueueSummary } from '../task-queue.ts';

const listTaskQueuesInput = z.object({});

const schedulingPolicySchema = z.enum(['priority', 'fifo', 'lifo']) as z.ZodType<SchedulingPolicy>;

export interface TaskQueueHealth {
  queue: string;
  backlog: number;
  oldestEnqueuedAt: number | null;
  oldestQueuedAgeMs: number | null;
  waitingPollers: number;
  schedulingPolicy: SchedulingPolicy;
  inFlight: number;
  connectedWorkers: number;
}

const taskQueueHealthSchema = z.object({
  queue: z.string(),
  backlog: z.number(),
  oldestEnqueuedAt: z.number().nullable(),
  oldestQueuedAgeMs: z.number().nullable(),
  waitingPollers: z.number(),
  schedulingPolicy: schedulingPolicySchema,
  inFlight: z.number(),
  connectedWorkers: z.number(),
}) satisfies z.ZodType<TaskQueueHealth>;

const listTaskQueuesOutput = z.object({
  items: z.array(taskQueueHealthSchema),
});

export type ListTaskQueuesInput = z.infer<typeof listTaskQueuesInput>;
export interface ListTaskQueuesOutput {
  items: TaskQueueHealth[];
}

interface ListTaskQueuesOptions {
  workerRegistry?: WorkerRegistry;
  taskQueue?: TaskQueue;
  clock?: () => number;
}

/**
 * Build the `weft.task.queues.list` operation, optionally bound to a live
 * `WorkerRegistry`, `TaskQueue`, and clock.
 *
 * When either runtime dependency is omitted, the operation is registered
 * with metadata only — discovery output still describes the endpoint —
 * but `invoke` throws if called.
 */
export function createListTaskQueuesOperation(options?: ListTaskQueuesOptions) {
  const workerRegistry = options?.workerRegistry;
  const taskQueue = options?.taskQueue;
  const clock = options?.clock ?? Date.now;
  return defineOperation<ListTaskQueuesInput, ListTaskQueuesOutput>({
    name: 'weft.task.queues.list',
    mcpExposable: false,
    summary: 'List task queues with backlog, waiting pollers, and per-queue saturation',
    tags: ['System'],
    inputSchema: listTaskQueuesInput,
    outputSchema: listTaskQueuesOutput as z.ZodType<ListTaskQueuesOutput>,
    access: { kind: 'scoped', scopes: { kind: 'anyOf', scopes: ['system:read'] } },
    discoverable: true,
    transports: { http: true, jsonRpcHttp: true, jsonRpcWebSocket: true, jsonRpcStdio: true },
    unknownKeyPolicy: { http: 'strip', jsonRpc: 'reject' },
    invoke: async (): Promise<ListTaskQueuesOutput> => {
      if (workerRegistry === undefined || taskQueue === undefined) {
        throw new Error(
          'weft.task.queues.list invoked from a discovery-only operation registry; no WorkerRegistry or TaskQueue was wired in',
        );
      }
      const now = clock();
      const workerSummaries = workerRegistry.getWorkerSummaries(now);
      const queueEntries = taskQueue.getQueueSummaries();
      return {
        items: mergeQueueHealth({
          now,
          workerSummaries,
          queueEntries,
          schedulingPolicy: taskQueue.schedulingPolicy,
        }),
      };
    },
  });
}

interface MergeArgs {
  now: number;
  workerSummaries: WorkerSummary[];
  queueEntries: ReturnType<TaskQueue['getQueueSummaries']>;
  schedulingPolicy: SchedulingPolicy;
}

interface WorkerLoad {
  inFlight: number;
  connectedWorkers: number;
}

function tallyWorkerLoad(workerSummaries: WorkerSummary[]): Map<string, WorkerLoad> {
  const perWorkerQueue = new Map<string, WorkerLoad>();
  for (const worker of workerSummaries) {
    const existing = perWorkerQueue.get(worker.queue);
    if (existing === undefined) {
      perWorkerQueue.set(worker.queue, { inFlight: worker.inFlight, connectedWorkers: 1 });
    } else {
      existing.inFlight += worker.inFlight;
      existing.connectedWorkers += 1;
    }
  }
  return perWorkerQueue;
}

const EMPTY_WORKER_LOAD: WorkerLoad = { inFlight: 0, connectedWorkers: 0 };

function buildHealthEntry(args: {
  queue: string;
  now: number;
  queueEntry: TaskQueueSummary | undefined;
  workerLoad: WorkerLoad | undefined;
  fallbackSchedulingPolicy: SchedulingPolicy;
}): TaskQueueHealth {
  const { queue, now, queueEntry, fallbackSchedulingPolicy } = args;
  const load = args.workerLoad ?? EMPTY_WORKER_LOAD;
  const oldestEnqueuedAt = queueEntry === undefined ? null : queueEntry.oldestEnqueuedAt;
  const oldestQueuedAgeMs = oldestEnqueuedAt === null ? null : now - oldestEnqueuedAt;
  return {
    queue,
    backlog: queueEntry === undefined ? 0 : queueEntry.backlog,
    oldestEnqueuedAt,
    oldestQueuedAgeMs,
    waitingPollers: queueEntry === undefined ? 0 : queueEntry.waitingPollers,
    schedulingPolicy:
      queueEntry === undefined ? fallbackSchedulingPolicy : queueEntry.schedulingPolicy,
    inFlight: load.inFlight,
    connectedWorkers: load.connectedWorkers,
  };
}

/**
 * Join queue-owned state with worker-owned state into one stable, sorted
 * list. Exported for unit testing the merge logic in isolation.
 */
export function mergeQueueHealth(args: MergeArgs): TaskQueueHealth[] {
  const { now, workerSummaries, queueEntries, schedulingPolicy } = args;
  const perWorkerQueue = tallyWorkerLoad(workerSummaries);

  const queueNames = new Set<string>();
  for (const entry of queueEntries) queueNames.add(entry.queue);
  for (const queue of perWorkerQueue.keys()) queueNames.add(queue);

  const entriesByQueue = new Map(queueEntries.map((entry) => [entry.queue, entry]));

  const merged: TaskQueueHealth[] = [];
  for (const queue of queueNames) {
    merged.push(
      buildHealthEntry({
        queue,
        now,
        queueEntry: entriesByQueue.get(queue),
        workerLoad: perWorkerQueue.get(queue),
        fallbackSchedulingPolicy: schedulingPolicy,
      }),
    );
  }

  return merged.toSorted((a, b) => (a.queue < b.queue ? -1 : a.queue > b.queue ? 1 : 0));
}

/** Default discovery-only operation; live servers use `createListTaskQueuesOperation(...)`. */
export const listTaskQueuesOperation = createListTaskQueuesOperation();

function formatInvalidParamsMessage(
  fault: Extract<OperationFault, { code: 'InvalidParams' }>,
): string {
  return fault.data.issues
    .map((issue) => {
      const path = issue.path.join('.');
      return path.length > 0 ? `${path}: ${issue.message}` : issue.message;
    })
    .join('; ');
}

function shapeListTaskQueuesFault(fault: OperationFault): Response {
  if (fault.code === 'InvalidParams') {
    return new Response(JSON.stringify({ error: formatInvalidParamsMessage(fault) }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }
  if (fault.code === 'EngineFailure') {
    return new Response(JSON.stringify({ error: 'Internal server error' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
  return new Response(JSON.stringify({ error: fault.message }), {
    status: FAULT_CODE_TO_HTTP_STATUS[fault.code],
    headers: { 'Content-Type': 'application/json' },
  });
}

/** Build the REST binding for `weft.task.queues.list`. */
export function createListTaskQueuesRestBinding(): UnknownRestBinding {
  return {
    method: 'GET',
    path: '/v1/task-queues',
    pathParamNames: [],
    operationName: 'weft.task.queues.list',
    inputSources: {},
    extractInput: async () => ({}),
    success: { kind: 'json', status: 200 },
    shapeSuccess: (output: ListTaskQueuesOutput) =>
      new Response(JSON.stringify(output), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    shapeFault: shapeListTaskQueuesFault,
  };
}

export const listTaskQueuesRestBinding = createListTaskQueuesRestBinding();
