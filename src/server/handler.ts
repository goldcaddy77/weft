/**
 * Platform-agnostic HTTP request handler for the workflow REST API.
 * Maps Request to Response with no Bun-specific dependencies.
 *
 * @module server/handler
 */

import { decode, encode } from '../core/codec.ts';
import type { Engine } from '../core/engine.ts';
import type { ListFilter, WorkflowState, WorkflowStatus } from '../core/types.ts';
import { UpdateCoordinator, UpdateTimeoutError } from '../core/updates.ts';
import { METRICS } from '../observability/metrics.ts';
import { KEYS } from '../storage/interface.ts';

// ---------------------------------------------------------------------------
// Route matching
// ---------------------------------------------------------------------------

interface RouteMatch {
  handler: string;
  params: Record<string, string>;
}

const ROUTE_PATTERNS: Array<{
  method: string;
  pattern: RegExp;
  handler: string;
  paramNames: string[];
}> = [
  {
    method: 'GET',
    pattern: /^\/v1\/health$/,
    handler: 'healthCheck',
    paramNames: [],
  },
  {
    method: 'POST',
    pattern: /^\/v1\/workflows$/,
    handler: 'startWorkflow',
    paramNames: [],
  },
  {
    method: 'GET',
    pattern: /^\/v1\/workflows$/,
    handler: 'listWorkflows',
    paramNames: [],
  },
  {
    method: 'GET',
    pattern: /^\/v1\/workflows\/([^/]+)\/result$/,
    handler: 'getWorkflowResult',
    paramNames: ['id'],
  },
  {
    method: 'POST',
    pattern: /^\/v1\/workflows\/([^/]+)\/signal\/([^/]+)$/,
    handler: 'signalWorkflow',
    paramNames: ['id', 'name'],
  },
  {
    method: 'POST',
    pattern: /^\/v1\/workflows\/([^/]+)\/update\/([^/]+)$/,
    handler: 'updateWorkflow',
    paramNames: ['id', 'name'],
  },
  {
    method: 'GET',
    pattern: /^\/v1\/updates\/([^/]+)$/,
    handler: 'getUpdateResult',
    paramNames: ['updateId'],
  },
  {
    method: 'GET',
    pattern: /^\/v1\/workflows\/([^/]+)\/attributes$/,
    handler: 'getAttributes',
    paramNames: ['id'],
  },
  {
    method: 'PATCH',
    pattern: /^\/v1\/workflows\/([^/]+)\/attributes$/,
    handler: 'setAttributes',
    paramNames: ['id'],
  },
  {
    method: 'GET',
    pattern: /^\/v1\/metrics$/,
    handler: 'getMetrics',
    paramNames: [],
  },
  {
    method: 'GET',
    pattern: /^\/v1\/workflows\/([^/]+)\/events$/,
    handler: 'getWorkflowEvents',
    paramNames: ['id'],
  },
  {
    method: 'GET',
    pattern: /^\/v1\/reviews$/,
    handler: 'listReviews',
    paramNames: [],
  },
  {
    method: 'POST',
    pattern: /^\/v1\/reviews\/([^/]+)\/decision$/,
    handler: 'submitReviewDecision',
    paramNames: ['reviewId'],
  },
  {
    method: 'GET',
    pattern: /^\/v1\/workflows\/([^/]+)$/,
    handler: 'getWorkflow',
    paramNames: ['id'],
  },
  {
    method: 'DELETE',
    pattern: /^\/v1\/workflows\/([^/]+)$/,
    handler: 'cancelWorkflow',
    paramNames: ['id'],
  },
];

function matchRoute(method: string, pathname: string): RouteMatch | null {
  for (const route of ROUTE_PATTERNS) {
    if (route.method !== method) continue;

    const match = route.pattern.exec(pathname);
    if (!match) continue;

    const params: Record<string, string> = {};
    for (let i = 0; i < route.paramNames.length; i++) {
      const name = route.paramNames[i];
      const value = match[i + 1];
      if (name !== undefined && value !== undefined) {
        params[name] = decodeURIComponent(value);
      }
    }

    return { handler: route.handler, params };
  }

  return null;
}

// ---------------------------------------------------------------------------
// Response helpers
// ---------------------------------------------------------------------------

function jsonResponse(body: unknown, status: number = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function msgpackResponse(body: unknown, status: number = 200): Response {
  return new Response(encode(body), {
    status,
    headers: { 'Content-Type': 'application/msgpack' },
  });
}

function negotiatedResponse(request: Request, body: unknown, status: number = 200): Response {
  const accept = request.headers.get('Accept') ?? '';
  if (accept.includes('application/msgpack')) {
    return msgpackResponse(body, status);
  }
  return jsonResponse(body, status);
}

function errorResponse(message: string, status: number): Response {
  return jsonResponse({ error: message }, status);
}

// ---------------------------------------------------------------------------
// Route handlers
// ---------------------------------------------------------------------------

async function handleStartWorkflow(request: Request, engine: Engine): Promise<Response> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return errorResponse('Invalid JSON body', 400);
  }

  if (typeof body !== 'object' || body === null) {
    return errorResponse('Request body must be a JSON object', 400);
  }

  const { type, input, id, executionTimeout } = body as Record<string, unknown>;

  if (typeof type !== 'string' || type.length === 0) {
    return errorResponse('Missing required field: type', 400);
  }

  try {
    const options: Record<string, unknown> = {};
    if (id !== undefined) {
      options['id'] = id;
    }
    if (executionTimeout !== undefined) {
      options['executionTimeout'] = executionTimeout;
    }

    const handle = await engine.start(type, input, options);
    return jsonResponse({ id: handle.id }, 201);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);

    if (message.includes('No workflow registered')) {
      return errorResponse(message, 400);
    }
    if (message.includes('already exists')) {
      return errorResponse(message, 409);
    }

    return errorResponse(message, 500);
  }
}

async function handleListWorkflows(request: Request, engine: Engine): Promise<Response> {
  const url = new URL(request.url);
  const filter: ListFilter = {};

  const status = url.searchParams.get('status');
  if (status !== null) {
    filter.status = status as WorkflowStatus;
  }

  const type = url.searchParams.get('type');
  if (type !== null) {
    filter.type = type;
  }

  const limit = url.searchParams.get('limit');
  if (limit !== null) {
    filter.limit = Number(limit);
  }

  const offset = url.searchParams.get('offset');
  if (offset !== null) {
    filter.offset = Number(offset);
  }

  const result = await engine.list(filter);
  return jsonResponse(result);
}

async function handleGetWorkflow(engine: Engine, workflowId: string): Promise<Response> {
  const bytes = await engine.storage.get(KEYS.workflow(workflowId));
  if (bytes === null) {
    return errorResponse(`Workflow "${workflowId}" not found`, 404);
  }

  const state = decode(bytes) as WorkflowState;
  return jsonResponse(state);
}

async function handleCancelWorkflow(engine: Engine, workflowId: string): Promise<Response> {
  try {
    await engine.cancel(workflowId);
    return new Response(null, { status: 204 });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return errorResponse(message, 500);
  }
}

async function handleSignalWorkflow(
  request: Request,
  engine: Engine,
  workflowId: string,
  signalName: string,
): Promise<Response> {
  let payload: unknown;
  try {
    const body = (await request.json()) as Record<string, unknown>;
    payload = body['payload'];
  } catch {
    // No body or invalid JSON is fine for signals -- payload is optional
  }

  try {
    await engine.signal(workflowId, signalName, payload);
    return jsonResponse({ ok: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);

    if (message.includes('not found')) {
      return errorResponse(message, 404);
    }

    return errorResponse(message, 500);
  }
}

async function handleGetWorkflowResult(engine: Engine, workflowId: string): Promise<Response> {
  // First check if the workflow exists
  const bytes = await engine.storage.get(KEYS.workflow(workflowId));
  if (bytes === null) {
    return errorResponse(`Workflow "${workflowId}" not found`, 404);
  }

  const state = decode(bytes) as WorkflowState;

  if (state.status === 'completed') {
    return jsonResponse({ result: state.result });
  }

  if (state.status === 'failed') {
    return errorResponse(state.error ?? 'Workflow failed', 422);
  }

  if (state.status === 'cancelled') {
    return errorResponse('Workflow cancelled', 422);
  }

  // Workflow is still running -- await with a timeout
  const handle = engine.getHandle(workflowId);
  const timeoutMilliseconds = 30_000;

  try {
    const result = await Promise.race([
      handle.result(),
      new Promise<never>((_resolve, reject) => {
        setTimeout(
          () => reject(new Error('Timeout waiting for workflow result')),
          timeoutMilliseconds,
        );
      }),
    ]);

    return jsonResponse({ result });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);

    if (message.includes('Timeout')) {
      return errorResponse('Timeout waiting for workflow result', 408);
    }

    return errorResponse(message, 500);
  }
}

// ---------------------------------------------------------------------------
// Update routes
// ---------------------------------------------------------------------------

const DEFAULT_UPDATE_TIMEOUT_MS = 30_000;

async function handleUpdateWorkflow(
  request: Request,
  engine: Engine,
  workflowId: string,
  updateName: string,
): Promise<Response> {
  let payload: unknown;
  let timeout = DEFAULT_UPDATE_TIMEOUT_MS;
  let idempotencyKey: string | undefined;

  try {
    const body = (await request.json()) as Record<string, unknown>;
    payload = body['payload'];
    if (typeof body['timeout'] === 'number') {
      timeout = body['timeout'];
    }
    if (typeof body['idempotencyKey'] === 'string') {
      idempotencyKey = body['idempotencyKey'];
    }
  } catch {
    // No body or invalid JSON — payload stays undefined
  }

  const coordinator = new UpdateCoordinator(engine.storage);

  // Check idempotency
  if (idempotencyKey !== undefined) {
    const existing = await coordinator.checkIdempotency(workflowId, idempotencyKey);
    if (existing !== null) {
      return jsonResponse({ updateId: existing.updateId, result: existing.result });
    }
  }

  const requestOptions: { timeout: number; idempotencyKey?: string } = { timeout };
  if (idempotencyKey !== undefined) {
    requestOptions.idempotencyKey = idempotencyKey;
  }

  const updateId = await coordinator.createRequest(workflowId, updateName, payload, requestOptions);

  try {
    const response = await coordinator.waitForResponse(updateId, timeout);
    if (response.error !== undefined) {
      return errorResponse(response.error, 422);
    }
    return jsonResponse({ updateId: response.updateId, result: response.result });
  } catch (error) {
    if (error instanceof UpdateTimeoutError) {
      return errorResponse(error.message, 408);
    }
    const message = error instanceof Error ? error.message : String(error);
    return errorResponse(message, 500);
  }
}

async function handleGetUpdateResult(engine: Engine, updateId: string): Promise<Response> {
  const coordinator = new UpdateCoordinator(engine.storage);
  const response = await coordinator.getResponse(updateId);

  if (response === null) {
    return jsonResponse({ status: 'pending' }, 202);
  }

  return jsonResponse({
    status: 'completed',
    result: response.result,
    ...(response.error !== undefined ? { error: response.error } : {}),
  });
}

// ---------------------------------------------------------------------------
// Attributes routes
// ---------------------------------------------------------------------------

async function handleGetAttributes(engine: Engine, workflowId: string): Promise<Response> {
  const bytes = await engine.storage.get(KEYS.attribute(workflowId));
  if (bytes === null) {
    return errorResponse(`Attributes for workflow "${workflowId}" not found`, 404);
  }

  const attributes = decode(bytes);
  return jsonResponse(attributes);
}

async function handleSetAttributes(
  request: Request,
  engine: Engine,
  workflowId: string,
): Promise<Response> {
  let incoming: Record<string, unknown>;
  try {
    const body = (await request.json()) as Record<string, unknown>;
    incoming = (body['attributes'] as Record<string, unknown>) ?? {};
  } catch {
    return errorResponse('Invalid JSON body', 400);
  }

  // Read existing attributes and merge
  const existingBytes = await engine.storage.get(KEYS.attribute(workflowId));
  let existing: Record<string, unknown> = {};
  if (existingBytes !== null) {
    existing = decode(existingBytes) as Record<string, unknown>;
  }

  const merged = { ...existing, ...incoming };

  // Build batch: write attributes + rebuild index operations
  const operations: Array<{ type: 'put'; key: string; value: Uint8Array }> = [
    { type: 'put', key: KEYS.attribute(workflowId), value: encode(merged) },
  ];

  // Rebuild attribute index entries
  for (const [attributeName, value] of Object.entries(incoming)) {
    const encodedValue = String(value);
    operations.push({
      type: 'put',
      key: KEYS.attributeIndex(attributeName, encodedValue, workflowId),
      value: encode(value),
    });
  }

  await engine.storage.batch(operations);

  return jsonResponse({ ok: true });
}

// ---------------------------------------------------------------------------
// Events route
// ---------------------------------------------------------------------------

async function handleGetWorkflowEvents(engine: Engine, workflowId: string): Promise<Response> {
  // Check workflow exists
  const bytes = await engine.storage.get(KEYS.workflow(workflowId));
  if (bytes === null) {
    return errorResponse(`Workflow "${workflowId}" not found`, 404);
  }

  const events: Array<{ type: string; timestamp: number; data: Record<string, unknown> }> = [];
  const prefix = `ev:${workflowId}:`;

  for await (const [_key, value] of engine.storage.scan(prefix)) {
    const event = decode(value) as Record<string, unknown>;
    events.push({
      type: (event['type'] as string) ?? 'unknown',
      timestamp: (event['timestamp'] as number) ?? 0,
      data: event,
    });
  }

  return jsonResponse({ events });
}

// ---------------------------------------------------------------------------
// Reviews routes
// ---------------------------------------------------------------------------

async function handleListReviews(engine: Engine): Promise<Response> {
  const reviews: Array<Record<string, unknown>> = [];

  for await (const [_key, value] of engine.storage.scan('review:')) {
    const review = decode(value) as Record<string, unknown>;
    reviews.push(review);
  }

  return jsonResponse({ items: reviews });
}

async function handleSubmitReviewDecision(
  request: Request,
  engine: Engine,
  reviewId: string,
): Promise<Response> {
  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return errorResponse('Invalid JSON body', 400);
  }

  const decision = body['decision'];
  const reviewer = body['reviewer'];

  if (typeof decision !== 'string' || typeof reviewer !== 'string') {
    return errorResponse('Missing required fields: decision, reviewer', 400);
  }

  // Find and resolve the review
  let reviewKey: string | null = null;
  for await (const [key, value] of engine.storage.scan('review:')) {
    const review = decode(value) as Record<string, unknown>;
    if (review['reviewId'] === reviewId) {
      reviewKey = key;
      break;
    }
  }

  if (reviewKey === null) {
    return errorResponse(`Review "${reviewId}" not found`, 404);
  }

  // Store the decision and signal the workflow
  const decisionData = {
    reviewId,
    decision,
    reviewer,
    feedback: body['feedback'],
    timestamp: Date.now(),
  };

  await engine.storage.batch([
    { type: 'put', key: `review-decision:${reviewId}`, value: encode(decisionData) },
    { type: 'delete', key: reviewKey },
  ]);

  return jsonResponse({ ok: true });
}

// ---------------------------------------------------------------------------
// Metrics route
// ---------------------------------------------------------------------------

function handleGetMetrics(): Response {
  const lines: string[] = [];

  for (const metric of Object.values(METRICS)) {
    const safeName = metric.name.replace(/\./g, '_');
    lines.push(`# HELP ${safeName} ${metric.description}`);
    lines.push(`# TYPE ${safeName} ${metric.type === 'counter' ? 'counter' : 'gauge'}`);
    lines.push(`${safeName}${metric.type === 'counter' ? '_total' : ''} 0`);
  }

  return new Response(lines.join('\n') + '\n', {
    status: 200,
    headers: { 'Content-Type': 'text/plain; charset=utf-8' },
  });
}

// ---------------------------------------------------------------------------
// Main handler
// ---------------------------------------------------------------------------

/** Pure HTTP request handler. Maps Request to Response. */
export async function handleRequest(request: Request, engine: Engine): Promise<Response> {
  const url = new URL(request.url);
  const route = matchRoute(request.method, url.pathname);

  if (route === null) {
    return errorResponse(`Not found: ${request.method} ${url.pathname}`, 404);
  }

  switch (route.handler) {
    case 'healthCheck':
      return negotiatedResponse(request, { status: 'ok' });

    case 'startWorkflow':
      return handleStartWorkflow(request, engine);

    case 'listWorkflows':
      return handleListWorkflows(request, engine);

    case 'getWorkflow':
      return handleGetWorkflow(engine, route.params['id']!);

    case 'cancelWorkflow':
      return handleCancelWorkflow(engine, route.params['id']!);

    case 'signalWorkflow':
      return handleSignalWorkflow(request, engine, route.params['id']!, route.params['name']!);

    case 'getWorkflowResult':
      return handleGetWorkflowResult(engine, route.params['id']!);

    case 'updateWorkflow':
      return handleUpdateWorkflow(request, engine, route.params['id']!, route.params['name']!);

    case 'getUpdateResult':
      return handleGetUpdateResult(engine, route.params['updateId']!);

    case 'getAttributes':
      return handleGetAttributes(engine, route.params['id']!);

    case 'setAttributes':
      return handleSetAttributes(request, engine, route.params['id']!);

    case 'getMetrics':
      return handleGetMetrics();

    case 'getWorkflowEvents':
      return handleGetWorkflowEvents(engine, route.params['id']!);

    case 'listReviews':
      return handleListReviews(engine);

    case 'submitReviewDecision':
      return handleSubmitReviewDecision(request, engine, route.params['reviewId']!);

    default:
      return errorResponse(`Not found: ${request.method} ${url.pathname}`, 404);
  }
}
