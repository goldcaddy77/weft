import type { ServeOptions } from '../index.ts';
import type { PendingTask } from '../task-queue.ts';
import type { InflightRecord } from '../task-state.ts';
import { transitionInflightToResolved, transitionQueuedToInflight } from '../task-state.ts';
import type { ServerContext } from './context.ts';

const TASK_POLL_RE = /^\/v1\/tasks\/([\w-]+)$/;
const TASK_RESULT_RE = /^\/v1\/tasks\/([\w-]+)\/result$/;

const MAX_POLL_TIMEOUT = 60_000;
const DEFAULT_POLL_TIMEOUT = 30_000;
const DEFAULT_VISIBILITY_TIMEOUT = 30_000;

async function parseTaskResultBody(request: Request): Promise<Record<string, unknown> | null> {
  try {
    return (await request.json()) as Record<string, unknown>;
  } catch {
    return null;
  }
}

export function createLongPollInflightRecord(queue: string, task: PendingTask): InflightRecord {
  const visibilityTimeout = task.visibilityTimeout ?? DEFAULT_VISIBILITY_TIMEOUT;
  const deadline = Date.now() + visibilityTimeout;

  return {
    operationId: task.operationId,
    workerId: `longpoll-${crypto.randomUUID().slice(0, 8)}`,
    deadline,
    activityName: task.activityName,
    queue,
    input: task.input,
    attempt: task.attempt ?? 1,
    visibilityTimeout,
    retryPolicy: task.retryPolicy,
  };
}

export function markTaskClaimedByLongPollWorker(
  context: ServerContext,
  options: ServeOptions,
  queue: string,
  task: PendingTask,
): void {
  const inflightRecord = createLongPollInflightRecord(queue, task);
  context.deadlineTracker.add({
    operationId: task.operationId,
    deadline: inflightRecord.deadline,
  });
  void transitionQueuedToInflight(options.engine.storage, task.operationId, inflightRecord);
}

export async function handleTaskPollRequest(
  context: ServerContext,
  options: ServeOptions,
  request: Request,
  url: URL,
): Promise<Response | null> {
  if (request.method !== 'GET') {
    return null;
  }

  const pollMatch = TASK_POLL_RE.exec(url.pathname);
  if (!pollMatch?.[1]) {
    return null;
  }

  const queue = decodeURIComponent(pollMatch[1]);
  const activities = url.searchParams.getAll('activity');
  if (activities.length === 0) {
    return Response.json(
      { error: 'At least one "activity" query parameter is required' },
      { status: 400 },
    );
  }

  const rawTimeout = url.searchParams.get('timeout');
  const timeout =
    rawTimeout !== null
      ? Math.min(Math.max(0, Number(rawTimeout)), MAX_POLL_TIMEOUT)
      : DEFAULT_POLL_TIMEOUT;

  const task = await context.taskQueue.poll(queue, activities, timeout);
  if (task !== null) {
    markTaskClaimedByLongPollWorker(context, options, queue, task);
    return Response.json(task);
  }

  return new Response(null, { status: 204 });
}

// oxlint-disable-next-line complexity -- ID:server-index-handle-task-result-request-complexity
export async function handleTaskResultRequest(
  context: ServerContext,
  options: ServeOptions,
  request: Request,
  url: URL,
): Promise<Response | null> {
  if (request.method !== 'POST') {
    return null;
  }

  const completeMatch = TASK_RESULT_RE.exec(url.pathname);
  if (!completeMatch?.[1]) {
    return null;
  }

  const body = await parseTaskResultBody(request);
  if (body === null) {
    return Response.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const operationId = body['operationId'];
  const status = body['status'];
  if (typeof operationId !== 'string' || typeof status !== 'string') {
    return Response.json(
      { error: 'Missing required fields: operationId, status' },
      { status: 400 },
    );
  }

  if (status !== 'completed' && status !== 'failed') {
    return Response.json({ error: 'status must be "completed" or "failed"' }, { status: 400 });
  }

  context.taskQueue.complete({
    operationId,
    status,
    value: body['value'],
    error: typeof body['error'] === 'string' ? body['error'] : undefined,
  });

  context.deadlineTracker.remove(operationId);
  const resolvedStatus = status === 'failed' ? 'failed' : ('completed' as const);
  transitionInflightToResolved(options.engine.storage, operationId, resolvedStatus).catch(
    (error) => {
      console.error(
        `[weft] Failed to transition task "${operationId}" to resolved — inflight record may leak:`,
        error,
      );
    },
  );

  return Response.json({ ok: true });
}
