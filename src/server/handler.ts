/**
 * Platform-agnostic HTTP request handler for the workflow REST API.
 * Maps Request to Response with no Bun-specific dependencies.
 *
 * Every route delegates to an {@link Engine} method — the handler is a
 * thin translation layer between HTTP and the Engine public API.
 *
 * @module server/handler
 */

import type { BudgetPolicyOptions } from '../ai/budget-policy.ts';
import { createSSEStream } from '../ai/streaming-agent.ts';
import { encode } from '../core/codec.ts';
import type { Engine } from '../core/engine.ts';
import type {
  AttributeFilter,
  ListFilter,
  ReviewDecision,
  SearchAttributeValue,
  WorkflowStatus,
} from '../core/types.ts';
import { UpdateTimeoutError, WorkflowTerminalError } from '../core/updates.ts';
import {
  createMetricsCollectorExporter,
  type MetricsCollector,
  type PrometheusExporter,
} from '../observability/metrics.ts';

// ---------------------------------------------------------------------------
// Route matching
// ---------------------------------------------------------------------------

interface RouteMatch {
  handler: RouteHandlerName;
  params: Record<string, string>;
}

type RouteHandlerName =
  | 'healthCheck'
  | 'startWorkflow'
  | 'listWorkflows'
  | 'recoverAll'
  | 'setBudgetPolicy'
  | 'getBudgetPolicy'
  | 'getStreamChunks'
  | 'queryWorkflow'
  | 'resumeWorkflow'
  | 'timeoutWorkflow'
  | 'getWorkflowResult'
  | 'signalWorkflow'
  | 'updateWorkflow'
  | 'getUpdateResult'
  | 'getAttributes'
  | 'setAttributes'
  | 'getMetrics'
  | 'getWorkflowEvents'
  | 'listReviews'
  | 'submitReviewDecision'
  | 'getReview'
  | 'streamSSE'
  | 'getWorkflow'
  | 'cancelWorkflow';

const ROUTE_PATTERNS: Array<{
  method: string;
  pattern: RegExp;
  handler: RouteHandlerName;
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
    method: 'POST',
    pattern: /^\/v1\/recover$/,
    handler: 'recoverAll',
    paramNames: [],
  },
  {
    method: 'PUT',
    pattern: /^\/v1\/budget-policy$/,
    handler: 'setBudgetPolicy',
    paramNames: [],
  },
  {
    method: 'GET',
    pattern: /^\/v1\/budget-policy\/([^/]+)$/,
    handler: 'getBudgetPolicy',
    paramNames: ['namespace'],
  },
  {
    method: 'GET',
    pattern: /^\/v1\/workflows\/([^/]+)\/streams\/([^/]+)$/,
    handler: 'getStreamChunks',
    paramNames: ['id', 'key'],
  },
  {
    method: 'GET',
    pattern: /^\/v1\/workflows\/([^/]+)\/query\/([^/]+)$/,
    handler: 'queryWorkflow',
    paramNames: ['id', 'name'],
  },
  {
    method: 'POST',
    pattern: /^\/v1\/workflows\/([^/]+)\/resume$/,
    handler: 'resumeWorkflow',
    paramNames: ['id'],
  },
  {
    method: 'POST',
    pattern: /^\/v1\/workflows\/([^/]+)\/timeout$/,
    handler: 'timeoutWorkflow',
    paramNames: ['id'],
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
    pattern: /^\/v1\/workflows\/([^/]+)\/review\/([^/]+)$/,
    handler: 'getReview',
    paramNames: ['id', 'reviewId'],
  },
  {
    method: 'GET',
    pattern: /^\/v1\/workflows\/([^/]+)\/sse$/,
    handler: 'streamSSE',
    paramNames: ['id'],
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

export function getRequiredRouteParameter(
  params: Record<string, string>,
  name: string,
  routeDescription: string,
): string {
  const value = params[name];
  if (value === undefined) {
    throw new Error(`Missing route parameter "${name}" for ${routeDescription}`);
  }
  return value;
}

// ---------------------------------------------------------------------------
// Route handlers — each delegates to an Engine method
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

function parseAttributeFilters(params: URLSearchParams): AttributeFilter[] {
  const filterMap = new Map<string, AttributeFilter>();

  for (const [key, value] of params) {
    if (!key.startsWith('attr.')) continue;

    const rest = key.slice(5); // strip "attr."
    const dotIndex = rest.indexOf('.');

    if (dotIndex === -1) {
      // Exact match: attr.{name}={value}
      const name = rest;
      const existing = filterMap.get(name) ?? { key: name };
      existing.value = inferAttributeValue(value);
      filterMap.set(name, existing);
    } else {
      // Range: attr.{name}.gte={value} or attr.{name}.lte={value}
      const name = rest.slice(0, dotIndex);
      const operator = rest.slice(dotIndex + 1);
      const existing = filterMap.get(name) ?? { key: name };

      if (operator === 'gt') {
        existing.gt = inferAttributeValue(value);
        filterMap.set(name, existing);
      } else if (operator === 'lt') {
        existing.lt = inferAttributeValue(value);
        filterMap.set(name, existing);
      } else if (operator === 'gte') {
        existing.gte = inferAttributeValue(value);
        filterMap.set(name, existing);
      } else if (operator === 'lte') {
        existing.lte = inferAttributeValue(value);
        filterMap.set(name, existing);
      }
      // Unknown operators are silently skipped to avoid unconstrained range scans.
    }
  }

  return [...filterMap.values()];
}

/** Infer the type of an attribute value from its string representation. */
function inferAttributeValue(raw: string): SearchAttributeValue {
  if (raw === 'true') return true;
  if (raw === 'false') return false;

  const asNumber = Number(raw);
  if (!Number.isNaN(asNumber) && raw.trim() !== '') return asNumber;

  return raw;
}

async function handleListWorkflows(request: Request, engine: Engine): Promise<Response> {
  const url = new URL(request.url);
  const filter: ListFilter = {};

  const statuses = url.searchParams.getAll('status') as WorkflowStatus[];
  if (statuses.length === 1) {
    filter.status = statuses[0]!;
  } else if (statuses.length > 1) {
    filter.status = statuses;
  }

  const type = url.searchParams.get('type');
  if (type !== null) {
    filter.type = type;
  }

  const limit = url.searchParams.get('limit');
  if (limit !== null) {
    const parsed = Number(limit);
    if (Number.isFinite(parsed) && parsed >= 1) {
      filter.limit = Math.min(Math.floor(parsed), 1000);
    }
  }

  const offset = url.searchParams.get('offset');
  if (offset !== null) {
    const parsed = Number(offset);
    if (Number.isFinite(parsed) && parsed >= 0) {
      filter.offset = Math.floor(parsed);
    }
  }

  // Parse attribute filters: attr.{name}={value}, attr.{name}.gte={value}, attr.{name}.lte={value}
  const attributeFilters = parseAttributeFilters(url.searchParams);
  if (attributeFilters.length > 0) {
    filter.attributes = attributeFilters;
  }

  const result = await engine.list(filter);
  return jsonResponse(result);
}

async function handleGetWorkflow(engine: Engine, workflowId: string): Promise<Response> {
  const state = await engine.get(workflowId);
  if (state === null) {
    return errorResponse(`Workflow "${workflowId}" not found`, 404);
  }

  return jsonResponse(state);
}

async function handleCancelWorkflow(engine: Engine, workflowId: string): Promise<Response> {
  try {
    await engine.cancel(workflowId);
    return new Response(null, { status: 204 });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes('not found')) {
      return errorResponse(message, 404);
    }
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
  const state = await engine.get(workflowId);
  if (state === null) {
    return errorResponse(`Workflow "${workflowId}" not found`, 404);
  }

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
// Update routes — engine.submitCoordinatedUpdate() / engine.getUpdateResult()
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

  const updateOptions: { timeout?: number; idempotencyKey?: string } = { timeout };
  if (idempotencyKey !== undefined) {
    updateOptions.idempotencyKey = idempotencyKey;
  }

  try {
    const result = await engine.submitCoordinatedUpdate(
      workflowId,
      updateName,
      payload,
      updateOptions,
    );

    if (result.error !== undefined) {
      return errorResponse(result.error, 422);
    }

    return jsonResponse({ updateId: result.updateId, result: result.result });
  } catch (error) {
    if (error instanceof WorkflowTerminalError) {
      return errorResponse(error.message, 422);
    }
    if (error instanceof UpdateTimeoutError) {
      return errorResponse(error.message, 408);
    }
    const message = error instanceof Error ? error.message : String(error);
    return errorResponse(message, 500);
  }
}

async function handleGetUpdateResult(engine: Engine, updateId: string): Promise<Response> {
  const response = await engine.getUpdateResult(updateId);

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
// Attributes routes — engine.getAttributes() / engine.setAttributes()
// ---------------------------------------------------------------------------

async function handleGetAttributes(engine: Engine, workflowId: string): Promise<Response> {
  const attributes = await engine.getAttributes(workflowId);
  if (attributes === null) {
    return errorResponse(`Attributes for workflow "${workflowId}" not found`, 404);
  }

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

  await engine.setAttributes(workflowId, incoming as Record<string, SearchAttributeValue>);

  return jsonResponse({ ok: true });
}

// ---------------------------------------------------------------------------
// Events route — engine.getEvents()
// ---------------------------------------------------------------------------

async function handleGetWorkflowEvents(engine: Engine, workflowId: string): Promise<Response> {
  const state = await engine.get(workflowId);
  if (state === null) {
    return errorResponse(`Workflow "${workflowId}" not found`, 404);
  }

  const events = await engine.getEvents(workflowId);
  return jsonResponse({ events });
}

// ---------------------------------------------------------------------------
// Reviews routes — engine.listReviews() / engine.submitReview()
// ---------------------------------------------------------------------------

async function handleListReviews(engine: Engine): Promise<Response> {
  const reviews = await engine.listReviews();
  return jsonResponse({ items: reviews });
}

async function handleGetReview(
  engine: Engine,
  workflowId: string,
  reviewId: string,
): Promise<Response> {
  const review = await engine.getReview(workflowId, reviewId);
  if (review === null) {
    return errorResponse(`Review "${reviewId}" not found for workflow "${workflowId}"`, 404);
  }
  return jsonResponse(review);
}

const VALID_DECISIONS = ['approved', 'rejected', 'needs-changes'] as const;

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
  const feedback = body['feedback'];
  const workflowId = body['workflowId'];

  if (typeof decision !== 'string' || typeof reviewer !== 'string') {
    return errorResponse('Missing required fields: decision, reviewer', 400);
  }

  if (!VALID_DECISIONS.includes(decision as (typeof VALID_DECISIONS)[number])) {
    return errorResponse(
      `Invalid decision "${decision}". Must be one of: ${VALID_DECISIONS.join(', ')}`,
      400,
    );
  }

  if (feedback !== undefined && typeof feedback !== 'string') {
    return errorResponse('Field "feedback" must be a string when provided', 400);
  }

  try {
    const reviewOptions: import('../core/types.ts').SubmitReviewOptions = {
      decision: decision as ReviewDecision,
      reviewer,
    };
    if (typeof feedback === 'string') {
      reviewOptions.feedback = feedback;
    }
    if (typeof workflowId === 'string') {
      reviewOptions.workflowId = workflowId;
    }

    await engine.submitReview(reviewId, reviewOptions);

    return jsonResponse({ ok: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes('not found')) {
      return errorResponse(message, 404);
    }
    return errorResponse(message, 500);
  }
}

// ---------------------------------------------------------------------------
// Query route — engine.query()
// ---------------------------------------------------------------------------

async function handleQueryWorkflow(
  engine: Engine,
  workflowId: string,
  queryName: string,
): Promise<Response> {
  try {
    const result = await engine.query(workflowId, queryName);
    return jsonResponse({ result: result ?? null });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes('not supported')) {
      return errorResponse(message, 501);
    }
    return errorResponse(message, 500);
  }
}

// ---------------------------------------------------------------------------
// Resume route — engine.resume()
// ---------------------------------------------------------------------------

async function handleResumeWorkflow(engine: Engine, workflowId: string): Promise<Response> {
  try {
    const handle = await engine.resume(workflowId);
    return jsonResponse({ id: handle.id });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes('not found')) {
      return errorResponse(message, 404);
    }
    if (message.includes('Cannot resume')) {
      return errorResponse(message, 409);
    }
    return errorResponse(message, 500);
  }
}

// ---------------------------------------------------------------------------
// Recover all route — engine.recoverAll()
// ---------------------------------------------------------------------------

async function handleRecoverAll(engine: Engine): Promise<Response> {
  const handles = await engine.recoverAll();
  const recovered: string[] = [];
  for (const handle of handles) {
    recovered.push(handle.id);
  }
  return jsonResponse({ recovered });
}

// ---------------------------------------------------------------------------
// Timeout route — engine.timeout()
// ---------------------------------------------------------------------------

async function handleTimeoutWorkflow(engine: Engine, workflowId: string): Promise<Response> {
  try {
    await engine.timeout(workflowId);
    return new Response(null, { status: 204 });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes('not found')) {
      return errorResponse(message, 404);
    }
    return errorResponse(message, 500);
  }
}

// ---------------------------------------------------------------------------
// Budget policy route — engine.setBudgetPolicy()
// ---------------------------------------------------------------------------

async function handleSetBudgetPolicy(request: Request, engine: Engine): Promise<Response> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return errorResponse('Invalid JSON body', 400);
  }

  if (typeof body !== 'object' || body === null) {
    return errorResponse('Request body must be a JSON object', 400);
  }

  const { namespace, daily, monthly } = body as Record<string, unknown>;

  if (typeof namespace !== 'string' || namespace.length === 0) {
    return errorResponse('Missing required field: namespace', 400);
  }

  const options: BudgetPolicyOptions = { namespace };
  if (daily !== undefined && typeof daily === 'object' && daily !== null) {
    options.daily = daily as { maxCost: number };
  }
  if (monthly !== undefined && typeof monthly === 'object' && monthly !== null) {
    options.monthly = monthly as { maxCost: number };
  }

  try {
    await engine.setBudgetPolicy(options);
    return jsonResponse({ ok: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return errorResponse(message, 500);
  }
}

// ---------------------------------------------------------------------------
// Budget policy read route — engine.getBudgetPolicy()
// ---------------------------------------------------------------------------

async function handleGetBudgetPolicy(engine: Engine, namespace: string): Promise<Response> {
  const policy = await engine.getBudgetPolicy(namespace);
  if (policy === null) {
    return errorResponse(`Budget policy for namespace "${namespace}" not found`, 404);
  }
  return jsonResponse(policy);
}

// ---------------------------------------------------------------------------
// Stream chunks route — engine.getStreamChunks()
// ---------------------------------------------------------------------------

async function handleGetStreamChunks(
  engine: Engine,
  workflowId: string,
  key: string,
): Promise<Response> {
  const chunks = await engine.getStreamChunks(workflowId, key);
  return jsonResponse({ chunks });
}

// ---------------------------------------------------------------------------
// SSE streaming route
// ---------------------------------------------------------------------------

async function handleStreamSSE(
  request: Request,
  engine: Engine,
  workflowId: string,
): Promise<Response> {
  const accept = request.headers.get('Accept') ?? '';
  if (!accept.includes('text/event-stream')) {
    return errorResponse('Accept header must include text/event-stream', 406);
  }

  // Check workflow exists
  const state = await engine.get(workflowId);
  if (state === null) {
    return errorResponse(`Workflow "${workflowId}" not found`, 404);
  }

  // Get Last-Event-ID for reconnection support
  const lastEventId = request.headers.get('Last-Event-ID') ?? undefined;

  // Get token stream from engine's stream chunks
  const chunks = await engine.getStreamChunks(workflowId, 'tokens');

  // Build a ReadableStream<string> from the stored chunks
  const tokenStream = new ReadableStream<string>({
    start(controller) {
      for (const chunk of chunks) {
        if (typeof chunk === 'string') {
          controller.enqueue(chunk);
        } else if (typeof chunk === 'object' && chunk !== null && 'token' in chunk) {
          const token = (chunk as { token?: string }).token;
          if (token) controller.enqueue(token);
        }
      }
      controller.close();
    },
  });

  const sseStream = createSSEStream(tokenStream, lastEventId);

  return new Response(sseStream, {
    status: 200,
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    },
  });
}

// ---------------------------------------------------------------------------
// Metrics route
// ---------------------------------------------------------------------------

async function handleGetMetrics(
  prometheusExporter: PrometheusExporter | undefined,
  metricsCollector: MetricsCollector | undefined,
): Promise<Response> {
  const exporter = prometheusExporter ?? createMetricsCollectorExporter(metricsCollector);
  let body: string;
  try {
    body = await exporter.serialize();
  } catch (error) {
    console.error('PrometheusExporter.serialize() threw', { error });
    return new Response(JSON.stringify({ error: 'metrics exporter failed' }), {
      status: 503,
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
    });
  }
  return new Response(body, {
    status: 200,
    headers: { 'Content-Type': 'text/plain; charset=utf-8' },
  });
}

type RouteParameterGetter = (name: string) => string;

type RouteExecutionContext = {
  request: Request;
  engine: Engine;
  options: HandlerOptions | undefined;
  param: RouteParameterGetter;
};

type RouteExecutor = (context: RouteExecutionContext) => Promise<Response>;

const ROUTE_EXECUTORS: Record<RouteHandlerName, RouteExecutor> = {
  healthCheck: async ({ request }) => negotiatedResponse(request, { status: 'ok' }),
  startWorkflow: async ({ request, engine }) => handleStartWorkflow(request, engine),
  listWorkflows: async ({ request, engine }) => handleListWorkflows(request, engine),
  recoverAll: async ({ engine }) => handleRecoverAll(engine),
  setBudgetPolicy: async ({ request, engine }) => handleSetBudgetPolicy(request, engine),
  getBudgetPolicy: async ({ engine, param }) => handleGetBudgetPolicy(engine, param('namespace')),
  getStreamChunks: async ({ engine, param }) =>
    handleGetStreamChunks(engine, param('id'), param('key')),
  queryWorkflow: async ({ engine, param }) =>
    handleQueryWorkflow(engine, param('id'), param('name')),
  resumeWorkflow: async ({ engine, param }) => handleResumeWorkflow(engine, param('id')),
  timeoutWorkflow: async ({ engine, param }) => handleTimeoutWorkflow(engine, param('id')),
  getWorkflowResult: async ({ engine, param }) => handleGetWorkflowResult(engine, param('id')),
  signalWorkflow: async ({ request, engine, param }) =>
    handleSignalWorkflow(request, engine, param('id'), param('name')),
  updateWorkflow: async ({ request, engine, param }) =>
    handleUpdateWorkflow(request, engine, param('id'), param('name')),
  getUpdateResult: async ({ engine, param }) => handleGetUpdateResult(engine, param('updateId')),
  getAttributes: async ({ engine, param }) => handleGetAttributes(engine, param('id')),
  setAttributes: async ({ request, engine, param }) =>
    handleSetAttributes(request, engine, param('id')),
  getMetrics: async ({ options }) =>
    handleGetMetrics(options?.prometheusExporter, options?.metricsCollector),
  getWorkflowEvents: async ({ engine, param }) => handleGetWorkflowEvents(engine, param('id')),
  listReviews: async ({ engine }) => handleListReviews(engine),
  submitReviewDecision: async ({ request, engine, param }) =>
    handleSubmitReviewDecision(request, engine, param('reviewId')),
  getReview: async ({ engine, param }) => handleGetReview(engine, param('id'), param('reviewId')),
  streamSSE: async ({ request, engine, param }) => handleStreamSSE(request, engine, param('id')),
  getWorkflow: async ({ engine, param }) => handleGetWorkflow(engine, param('id')),
  cancelWorkflow: async ({ engine, param }) => handleCancelWorkflow(engine, param('id')),
};

// ---------------------------------------------------------------------------
// Main handler
// ---------------------------------------------------------------------------

export interface HandlerOptions {
  /**
   * Optional {@link PrometheusExporter} used to produce the body of
   * `/v1/metrics`. When set, it takes precedence over `metricsCollector` —
   * this is the recommended plug point for projects that source metrics from
   * the OpenTelemetry SDK (e.g. via `@opentelemetry/exporter-prometheus`).
   */
  prometheusExporter?: PrometheusExporter;
  /**
   * Optional metrics collector for the /v1/metrics endpoint. Used when no
   * `prometheusExporter` is provided.
   *
   * @deprecated Prefer `prometheusExporter` — wrap your metrics source (OTel
   * or otherwise) in a {@link PrometheusExporter} and pass it there. This
   * field remains for projects still using the legacy `MetricsCollector`
   * path and has lower precedence if both are set.
   */
  metricsCollector?: MetricsCollector;
}

/** Pure HTTP request handler. Maps Request to Response. */
export async function handleRequest(
  request: Request,
  engine: Engine,
  options?: HandlerOptions,
): Promise<Response> {
  const url = new URL(request.url);
  const route = matchRoute(request.method, url.pathname);

  if (route === null) {
    return errorResponse(`Not found: ${request.method} ${url.pathname}`, 404);
  }

  const routeDescription = `${request.method} ${url.pathname}`;
  const param = (name: string): string =>
    getRequiredRouteParameter(route.params, name, routeDescription);

  try {
    return await ROUTE_EXECUTORS[route.handler]({ request, engine, options, param });
  } catch (error) {
    console.error('Unhandled error in handleRequest', {
      method: request.method,
      path: url.pathname,
      error,
    });
    return errorResponse('Internal server error', 500);
  }
}
