/**
 * Platform-agnostic HTTP request handler for the workflow REST API.
 * Maps Request to Response with no Bun-specific dependencies.
 *
 * @module server/handler
 */

import { decode } from '../core/codec.ts';
import type { Engine } from '../core/engine.ts';
import type { ListFilter, WorkflowState, WorkflowStatus } from '../core/types.ts';
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

function errorResponse(message: string, status: number): Response {
  return jsonResponse({ error: message }, status);
}

// ---------------------------------------------------------------------------
// Route handlers
// ---------------------------------------------------------------------------

function handleHealthCheck(): Response {
  return jsonResponse({ status: 'ok' });
}

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
      return handleHealthCheck();

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

    default:
      return errorResponse(`Not found: ${request.method} ${url.pathname}`, 404);
  }
}
