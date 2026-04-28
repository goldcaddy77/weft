/**
 * Platform-agnostic HTTP request handler for the workflow REST API.
 * Maps Request to Response with no Bun-specific dependencies.
 *
 * Every route delegates to an {@link Engine} method — the handler is a
 * thin translation layer between HTTP and the Engine public API.
 *
 * @module server/handler
 */

import { encode } from '../core/codec.ts';
import type { Engine } from '../core/engine.ts';
import type { ScheduleAccessOptions, ScheduleFilter, ScheduleStatus } from '../core/types.ts';
import {
  createMetricsCollectorExporter,
  type MetricsCollector,
  type PrometheusExporter,
} from '../observability/metrics.ts';
import type { AuthContext, JWTPayload } from './authentication.ts';
import { faultToHttpResponse } from './fault-to-http.ts';
import { generateOpenApiDocument } from './openapi.ts';
import { executeOperation, type OperationRegistry } from './operation-catalog.ts';
import type { OperationFault } from './operation-fault.ts';
import { FAULT_CODE_TO_HTTP_STATUS } from './operation-fault.ts';
import {
  anonymousPrincipal,
  principalFromApiKey,
  principalFromJwtClaims,
  principalFromMutualTls,
  type Principal,
} from './principal.ts';
import { bindingPathMatches, MalformedRouteParameterError } from './rest-binding.ts';
import {
  createLiveOperationRegistry,
  REST_BINDINGS,
  type UnknownRestBinding,
} from './rest-bindings.ts';
import { ROUTES, toRegex } from './route-model.ts';

// ---------------------------------------------------------------------------
// Route matching
// ---------------------------------------------------------------------------

/** Union of all handler names derived from the shared route model. */
type HandlerName = (typeof ROUTES)[number]['handler'];

interface RouteMatch {
  handler: HandlerName;
  params: Record<string, string>;
  path: string;
}

/** Alias for `AuthContext` — kept local so handler-internal code reads naturally. */
type AuthenticatedRequestContext = AuthContext;

/**
 * Route patterns derived from the shared route model. The regex is computed
 * once at module load time for the hot path.
 */
const ROUTE_PATTERNS: Array<{
  method: (typeof ROUTES)[number]['method'];
  pattern: RegExp;
  handler: HandlerName;
  path: string;
  paramNames: readonly string[];
}> = [];

for (const route of ROUTES) {
  ROUTE_PATTERNS.push({
    method: route.method,
    pattern: toRegex(route.path),
    handler: route.handler,
    path: route.path,
    paramNames: route.paramNames,
  });
}

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
        try {
          params[name] = decodeURIComponent(value);
        } catch {
          throw new MalformedRouteParameterError();
        }
      }
    }

    return { handler: route.handler, params, path: route.path };
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

function getAuthenticatedTenantId(claims: JWTPayload | undefined): string | null {
  if (!claims) {
    return null;
  }

  for (const key of ['tenantId', 'tenant_id', 'tenant'] as const) {
    const value = claims[key];
    if (typeof value === 'string') {
      const normalizedTenantId = value.trim();
      if (normalizedTenantId.length > 0) {
        return normalizedTenantId;
      }
    }
  }

  return null;
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

const VALID_SCHEDULE_STATUSES = new Set<ScheduleStatus>(['active', 'paused', 'cancelled']);

function parseScheduleListFilter(request: Request): ScheduleFilter {
  const url = new URL(request.url);
  const filter: ScheduleFilter = {};

  const statuses = url.searchParams.getAll('status');
  if (statuses.length > 0) {
    const normalizedStatuses: ScheduleStatus[] = [];
    for (const status of statuses) {
      if (!VALID_SCHEDULE_STATUSES.has(status as ScheduleStatus)) {
        throw new Error('Query parameter "status" must be one of active, paused, cancelled');
      }
      normalizedStatuses.push(status as ScheduleStatus);
    }

    const [firstStatus] = normalizedStatuses;
    if (normalizedStatuses.length === 1 && firstStatus !== undefined) {
      filter.status = firstStatus;
    } else {
      filter.status = normalizedStatuses;
    }
  }

  const workflowType = url.searchParams.get('workflowType');
  if (workflowType !== null) {
    filter.workflowType = workflowType;
  }

  const tenantId = url.searchParams.get('tenantId');
  if (tenantId !== null) {
    filter.tenantId = tenantId;
  }

  const limit = url.searchParams.get('limit');
  if (limit !== null) {
    const parsed = Number(limit);
    if (!Number.isInteger(parsed) || parsed < 1) {
      throw new Error('Query parameter "limit" must be a positive integer');
    }
    filter.limit = Math.min(parsed, 1000);
  }

  const offset = url.searchParams.get('offset');
  if (offset !== null) {
    const parsed = Number(offset);
    if (!Number.isInteger(parsed) || parsed < 0) {
      throw new Error('Query parameter "offset" must be a non-negative integer');
    }
    filter.offset = parsed;
  }

  return filter;
}

function scheduleErrorResponse(error: unknown): Response {
  const message = error instanceof Error ? error.message : String(error);
  const normalizedMessage = message.toLowerCase();

  if (normalizedMessage.includes('not found')) {
    return errorResponse(message, 404);
  }

  if (normalizedMessage.includes('already exists')) {
    return errorResponse(message, 409);
  }

  if (normalizedMessage.includes('cannot be resumed')) {
    return errorResponse(message, 409);
  }

  if (normalizedMessage.includes('authenticated tenant')) {
    return errorResponse(message, 403);
  }

  if (
    message.includes('Missing required field') ||
    normalizedMessage.includes('must be') ||
    normalizedMessage.includes('no workflow registered') ||
    normalizedMessage.includes('cron')
  ) {
    return errorResponse(message, 400);
  }

  return errorResponse(message, 500);
}

function getAuthenticatedScheduleTenantId(
  authContext: AuthenticatedRequestContext | undefined,
): string | Response | undefined {
  if (authContext?.method !== 'jwt') {
    return undefined;
  }

  const authenticatedTenantId = getAuthenticatedTenantId(authContext.claims);
  if (authenticatedTenantId === null) {
    return errorResponse(
      'JWT-authenticated schedule requests require a tenantId, tenant_id, or tenant claim',
      403,
    );
  }

  return authenticatedTenantId;
}

function applyAuthenticatedScheduleTenantScope(
  filter: ScheduleFilter,
  authContext: AuthenticatedRequestContext | undefined,
): Response | undefined {
  const authenticatedTenantId = getAuthenticatedScheduleTenantId(authContext);
  if (authenticatedTenantId instanceof Response) {
    return authenticatedTenantId;
  }

  if (authenticatedTenantId === undefined) {
    return undefined;
  }

  if (filter.tenantId !== undefined && filter.tenantId !== authenticatedTenantId) {
    return errorResponse('Schedule access is limited to the authenticated tenant', 403);
  }

  filter.tenantId = authenticatedTenantId;
  return undefined;
}

function getScheduleAccessOptions(
  authContext: AuthenticatedRequestContext | undefined,
): ScheduleAccessOptions | Response | undefined {
  const authenticatedTenantId = getAuthenticatedScheduleTenantId(authContext);
  if (authenticatedTenantId instanceof Response) {
    return authenticatedTenantId;
  }

  if (authenticatedTenantId === undefined) {
    return undefined;
  }

  return { tenantId: authenticatedTenantId };
}

// ---------------------------------------------------------------------------
// Route handlers — each delegates to an Engine method
// ---------------------------------------------------------------------------

async function handleListSchedules(
  request: Request,
  engine: Engine,
  authContext: AuthenticatedRequestContext | undefined,
): Promise<Response> {
  try {
    const filter = parseScheduleListFilter(request);
    const authError = applyAuthenticatedScheduleTenantScope(filter, authContext);
    if (authError !== undefined) {
      return authError;
    }
    return jsonResponse(await engine.listSchedules(filter));
  } catch (error) {
    return scheduleErrorResponse(error);
  }
}

async function handleGetSchedule(
  engine: Engine,
  scheduleId: string,
  authContext: AuthenticatedRequestContext | undefined,
): Promise<Response> {
  try {
    const accessOptions = getScheduleAccessOptions(authContext);
    if (accessOptions instanceof Response) {
      return accessOptions;
    }

    const schedule = await engine.getSchedule(scheduleId, accessOptions);
    if (schedule === null) {
      return errorResponse(`Schedule "${scheduleId}" not found`, 404);
    }

    return jsonResponse(schedule);
  } catch (error) {
    return scheduleErrorResponse(error);
  }
}

// ---------------------------------------------------------------------------
// Events route — engine.getEvents()
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Reviews routes — engine.listReviews() / engine.submitReview()
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Query route — engine.query()
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Budget policy route — engine.setBudgetPolicy()
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Budget policy read route — engine.getBudgetPolicy()
// ---------------------------------------------------------------------------

async function handleGetTenantQuota(
  engine: Engine,
  tenantId: string,
  authContext: AuthenticatedRequestContext | undefined,
): Promise<Response> {
  const normalizedTenantId = tenantId.trim();
  if (normalizedTenantId.length === 0) {
    return errorResponse('Tenant id must be a non-empty string', 400);
  }

  if (authContext?.method === 'jwt') {
    const authenticatedTenantId = getAuthenticatedTenantId(authContext.claims);
    if (authenticatedTenantId === null) {
      return errorResponse(
        'JWT-authenticated tenant quota requests require a tenantId, tenant_id, or tenant claim',
        403,
      );
    }
    if (authenticatedTenantId !== normalizedTenantId) {
      return errorResponse('Tenant quota access is limited to the authenticated tenant', 403);
    }
  }

  return jsonResponse(await engine.getQuotaUsage(normalizedTenantId));
}

// ---------------------------------------------------------------------------
// Checkpoint history routes
// ---------------------------------------------------------------------------

async function handleReplayWorkflowToStep(
  request: Request,
  engine: Engine,
  workflowId: string,
  stepParam: string,
): Promise<Response> {
  const state = await engine.get(workflowId);
  if (state === null) {
    return errorResponse(`Workflow "${workflowId}" not found`, 404);
  }

  const step = Number(stepParam);
  if (!Number.isSafeInteger(step) || step < 0) {
    return errorResponse(`Invalid step: ${stepParam}`, 400);
  }

  const replay = await engine.replayTo(workflowId, step);
  if (replay === null) {
    return errorResponse(`Replay not found at step ${step} for workflow ${workflowId}`, 404);
  }

  return negotiatedResponse(request, replay);
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

const ROUTE_EXECUTORS: Record<HandlerName, RouteExecutor> = {
  healthCheck: async ({ request }) => negotiatedResponse(request, { status: 'ok' }),
  listSchedules: async ({ request, engine, options }) =>
    handleListSchedules(request, engine, options?.authContext),
  getSchedule: async ({ engine, options, param }) =>
    handleGetSchedule(engine, param('id'), options?.authContext),
  getTenantQuota: async ({ engine, options, param }) =>
    handleGetTenantQuota(engine, param('id'), options?.authContext),
  getMetrics: async ({ options }) =>
    handleGetMetrics(options?.prometheusExporter, options?.metricsCollector),
  replayWorkflowToStep: async ({ request, engine, param }) =>
    handleReplayWorkflowToStep(request, engine, param('id'), param('step')),
  openApiDocument: async () => jsonResponse(generateOpenApiDocument()),
};

// ---------------------------------------------------------------------------
// Main handler
// ---------------------------------------------------------------------------

export interface HandlerOptions {
  /**
   * Optional authenticated caller context injected by the HTTP server
   * wrapper. See `AuthContext` in `authentication.ts` for field docs.
   */
  authContext?: AuthContext;
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
  /**
   * Operation registry for pipeline dispatch. Must be supplied together
   * with `restBindings` — a caller that overrides one but not the other
   * gets a mismatched configuration (custom bindings referencing a live
   * registry they weren't built against), which `handleRequest` rejects
   * at request time. Omit both to use the live defaults.
   */
  operationRegistry?: OperationRegistry;
  /**
   * REST bindings. A request whose method+path matches a binding routes
   * through the `executeOperation` pipeline. Must be supplied together
   * with `operationRegistry`. Omit both to use the live defaults.
   */
  restBindings?: ReadonlyArray<UnknownRestBinding>;
}

/**
 * Find a REST binding that matches the request's method and path.
 * Returns null if no binding matches (caller falls back to legacy
 * dispatch). Delegates path resolution to the canonical
 * `bindingPathMatches` helper — single source of truth for
 * segment-and-param matching across router and OpenAPI generator.
 */
function matchRestBinding(
  method: string,
  pathname: string,
  bindings: ReadonlyArray<UnknownRestBinding> | undefined,
): { readonly binding: UnknownRestBinding; readonly pathParams: Record<string, string> } | null {
  if (bindings === undefined) return null;
  for (const binding of bindings) {
    if (binding.method !== method) continue;
    const params = bindingPathMatches(binding.path, pathname);
    if (params !== null) return { binding, pathParams: params };
  }
  return null;
}

function countPathParameters(pathPattern: string): number {
  return pathPattern.split('/').filter((segment) => segment.startsWith(':')).length;
}

function countLiteralSegments(pathPattern: string): number {
  return pathPattern.split('/').filter((segment) => segment.length > 0 && !segment.startsWith(':'))
    .length;
}

function shouldPreferLegacyRoute(
  bindingMatch: { readonly binding: UnknownRestBinding } | null,
  routeMatch: RouteMatch | null,
): boolean {
  if (bindingMatch === null || routeMatch === null) {
    return false;
  }

  const bindingParameterCount = countPathParameters(bindingMatch.binding.path);
  const routeParameterCount = countPathParameters(routeMatch.path);
  if (routeParameterCount !== bindingParameterCount) {
    return routeParameterCount < bindingParameterCount;
  }

  return countLiteralSegments(routeMatch.path) > countLiteralSegments(bindingMatch.binding.path);
}

/**
 * Dispatch a request through the `executeOperation` pipeline using a
 * matched `RestBinding`. Returns the shaped response (via
 * `shapeSuccess` / `shapeFault` overrides, or defaults).
 */
async function dispatchViaExecuteOperation(
  request: Request,
  engine: Engine,
  binding: UnknownRestBinding,
  pathParams: Record<string, string>,
  registry: OperationRegistry,
  principal: Principal,
): Promise<Response> {
  let input: unknown;
  try {
    input = await binding.extractInput(request, pathParams);
  } catch (error) {
    if (isOperationFaultLike(error)) {
      return binding.shapeFault ? binding.shapeFault(error) : faultToHttpResponse(error);
    }
    const message = error instanceof Error ? error.message : String(error);
    return errorResponse(message, 400);
  }
  const result = await executeOperation(binding.operationName, input, {
    principal,
    engine,
    transport: 'http-rest',
    registry,
  });
  if (result.ok) {
    return binding.shapeSuccess
      ? binding.shapeSuccess(result.value, request)
      : defaultShapeSuccess(result.value, binding.success);
  }
  return binding.shapeFault ? binding.shapeFault(result.fault) : faultToHttpResponse(result.fault);
}

function isOperationFaultLike(value: unknown): value is OperationFault {
  if (typeof value !== 'object' || value === null) {
    return false;
  }

  const candidate = value as Record<string, unknown>;
  const code = candidate['code'];
  // `data` must be a non-null object: every member of the
  // `OperationFault` discriminated union types `data` as an object
  // shape (never `undefined`, never `null`). Accepting a fault with
  // `data: undefined` here would produce a `value as OperationFault`
  // narrowing the union does not actually permit, leaking an
  // unsound cast through to `binding.shapeFault`.
  //
  // `Object.hasOwn` (not `in`) so we don't accidentally promote a
  // foreign object whose `code` is `'__proto__'`, `'constructor'`,
  // or any other inherited property of `FAULT_CODE_TO_HTTP_STATUS`
  // — those would walk the prototype chain via `in` and let an
  // arbitrary thrown object impersonate a fault.
  return (
    typeof code === 'string' &&
    Object.hasOwn(FAULT_CODE_TO_HTTP_STATUS, code) &&
    typeof candidate['message'] === 'string' &&
    typeof candidate['data'] === 'object' &&
    candidate['data'] !== null
  );
}

/**
 * Convert the REST transport's `authContext` into a `Principal`. The
 * authenticator (`serve()`) only reports method + optional claims; this
 * shim bridges that into the richer `Principal` the pipeline expects.
 * Returns `anonymousPrincipal()` when no context is provided (public
 * request).
 *
 * JWT: claims → `principalFromJwtClaims` (scope/tenant extraction).
 *   JWT without claims is an authenticator contract violation — the
 *   production authenticator always populates claims, and silently
 *   degrading to anonymous here would let a caller with `authContext:
 *   { method: 'jwt' }` (no claims) bypass `optionalAuth` scope checks
 *   by appearing unauthenticated. We throw instead so the bug surfaces
 *   loudly rather than as a silent security downgrade.
 * API key / mTLS: identity details are not carried on `authContext`
 * yet — this shim produces a minimal authenticated principal with no
 * scopes. Scope-protected REST ops still dispatch through
 * `authenticateRequest` in `authentication.ts`, which adds scopes via
 * `resolveApiKeyPrincipal` / `defaultApiKeyScopes` when configured.
 */
export function authContextToPrincipal(
  authContext: AuthenticatedRequestContext | undefined,
): Principal {
  if (authContext === undefined) return anonymousPrincipal();
  // Forwarded principal from the authenticator (e.g. from
  // `resolveApiKeyPrincipal` or static api-key admission with
  // `defaultApiKeyScopes`) takes precedence over method-based
  // reconstruction.
  if (authContext.principal !== undefined) return authContext.principal;
  switch (authContext.method) {
    case 'jwt': {
      if (authContext.claims === undefined) {
        throw new Error(
          'authContextToPrincipal: jwt authContext reached the pipeline without claims — ' +
            'authenticator contract violation',
        );
      }
      return principalFromJwtClaims(authContext.claims);
    }
    case 'api-key':
      return principalFromApiKey({ subject: 'api-key-caller', scopes: [] });
    case 'mtls':
      return principalFromMutualTls({ subject: 'mtls-caller', scopes: [] });
    case 'public':
      // serve() short-circuits public requests before reaching here; if
      // a direct caller still passes method: 'public', treat as anonymous.
      return anonymousPrincipal();
  }
}

function defaultShapeSuccess(value: unknown, shape: UnknownRestBinding['success']): Response {
  if (shape.kind === 'empty') return new Response(null, { status: shape.status });
  if (shape.kind === 'streaming') {
    // Streaming responses must supply their own `shapeSuccess` — a
    // default here would bundle the async iterable into a JSON body
    // and silently break SSE/binary output. Fail loudly instead.
    throw new Error('streaming RestBinding must provide shapeSuccess');
  }
  return jsonResponse(value, shape.status);
}

/**
 * Lazily-initialized live operation registry used as the default for
 * callers that don't pass one. The registry is stateless and can be
 * shared across all requests.
 */
let _defaultOperationRegistry: OperationRegistry | undefined;
function defaultOperationRegistry(): OperationRegistry {
  if (_defaultOperationRegistry === undefined) {
    _defaultOperationRegistry = createLiveOperationRegistry();
  }
  return _defaultOperationRegistry;
}

/** Pure HTTP request handler. Maps Request to Response. */
export async function handleRequest(
  request: Request,
  engine: Engine,
  options?: HandlerOptions,
): Promise<Response> {
  const url = new URL(request.url);

  // REST bindings match first — they dispatch through the shared
  // `executeOperation` pipeline. Callers may override the registry and
  // bindings for tests; production callers (serve()) pass their own
  // instance so the registry shares the same lifecycle as the server.
  //
  // Reject the half-configured case: a caller that supplies one of
  // `restBindings` / `operationRegistry` without the other would get a
  // silent mismatch — custom bindings paired with the live registry (or
  // vice versa), producing `MethodNotFound` faults at dispatch time
  // that surface as generic 500s. Fail loudly at the request boundary
  // instead.
  if ((options?.restBindings === undefined) !== (options?.operationRegistry === undefined)) {
    return errorResponse(
      '`restBindings` and `operationRegistry` must be supplied together (or both omitted).',
      500,
    );
  }
  const restBindings = options?.restBindings ?? REST_BINDINGS;
  const operationRegistry = options?.operationRegistry ?? defaultOperationRegistry();
  let bindingMatch: ReturnType<typeof matchRestBinding>;
  try {
    bindingMatch = matchRestBinding(request.method, url.pathname, restBindings);
  } catch (error) {
    if (error instanceof MalformedRouteParameterError) {
      return errorResponse(error.message, 400);
    }
    throw error;
  }

  let route: RouteMatch | null;
  try {
    route = matchRoute(request.method, url.pathname);
  } catch (error) {
    if (error instanceof MalformedRouteParameterError) return errorResponse(error.message, 400);
    throw error;
  }

  if (bindingMatch !== null && !shouldPreferLegacyRoute(bindingMatch, route)) {
    try {
      return await dispatchViaExecuteOperation(
        request,
        engine,
        bindingMatch.binding,
        bindingMatch.pathParams,
        operationRegistry,
        authContextToPrincipal(options?.authContext),
      );
    } catch (error) {
      console.error('Unhandled error in dispatchViaExecuteOperation', {
        method: request.method,
        path: url.pathname,
        error,
      });
      return errorResponse('Internal server error', 500);
    }
  }

  if (route === null) {
    return errorResponse(`Not found: ${request.method} ${url.pathname}`, 404);
  }

  const routeDescription = `${request.method} ${url.pathname}`;
  const param = (name: string): string =>
    getRequiredRouteParameter(route.params, name, routeDescription);

  try {
    const executor = ROUTE_EXECUTORS[route.handler];
    return await executor({ request, engine, options, param });
  } catch (error) {
    console.error('Unhandled error in handleRequest', {
      method: request.method,
      path: url.pathname,
      error,
    });
    return errorResponse('Internal server error', 500);
  }
}
