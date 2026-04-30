/**
 * Platform-agnostic HTTP request handler for the workflow REST API.
 * Maps Request to Response with no Bun-specific dependencies.
 *
 * Post-Track-8 dispatch model: incoming requests are resolved first against
 * the unified operation catalog via `RestBinding` entries (the
 * `dispatchViaExecuteOperation` pipeline). Only four REST-only meta routes
 * bypass that pipeline and are dispatched directly from the legacy `ROUTES`
 * table: `GET /v1/health`, `GET /v1/metrics`, `GET /openapi.json`, and
 * `GET /openrpc.json`. The `shouldPreferLegacyRoute` predicate enforces
 * the precedence rule when both a `RestBinding` and a legacy `ROUTES` entry
 * match the same path.
 *
 * @module server/handler
 */

import { encode } from '../core/codec.ts';
import type { Engine } from '../core/engine.ts';
import {
  createMetricsCollectorExporter,
  type MetricsCollector,
  type PrometheusExporter,
} from '../observability/metrics.ts';
import type { AuthContext } from './authentication.ts';
import { faultToHttpResponse } from './fault-to-http.ts';
import { generateOpenApiDocument, type OpenApiSecuritySchemeName } from './openapi.ts';
import { generateOpenRpcDocument } from './openrpc.ts';
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
  createLiveRestBindings,
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

    return {
      handler: route.handler,
      params: extractRouteParameters(route.paramNames, match),
      path: route.path,
    };
  }

  return null;
}

/**
 * Extract path parameter values from a regex match against a route pattern.
 *
 * Pairs the ordered `parameterNames` (from the route's compiled pattern)
 * with the corresponding capture groups in `match`, decoding each value with
 * `decodeURIComponent`. Used by route dispatchers to turn a regex hit into a
 * `{ paramName: value }` map for the operation handler.
 *
 * Post-Track-8 note: the only active routes dispatched through this helper
 * are the four parameter-free meta routes (`/v1/health`, `/v1/metrics`,
 * `/openapi.json`, `/openrpc.json`). The function is kept public for
 * tests and any user-supplied route extensions.
 *
 * @example Extract route params from a synthetic custom route
 * ```ts
 * import { extractRouteParameters } from 'weft/server/handler';
 *
 * const pattern = /^\/tenants\/([^/]+)\/workflows\/([^/]+)$/;
 * const match = pattern.exec('/tenants/acme/workflows/wf-42');
 * if (match) {
 *   const params = extractRouteParameters(['tenantId', 'workflowId'], match);
 *   console.log(params); // { tenantId: 'acme', workflowId: 'wf-42' }
 * }
 * ```
 */
export function extractRouteParameters(
  parameterNames: readonly string[],
  match: Pick<RegExpExecArray, number | 'length'>,
): Record<string, string> {
  const params: Record<string, string> = {};
  for (let index = 0; index < parameterNames.length; index += 1) {
    const name = parameterNames[index];
    const value = match[index + 1];
    if (name !== undefined && value !== undefined) {
      try {
        params[name] = decodeURIComponent(value);
      } catch {
        throw new MalformedRouteParameterError();
      }
    }
  }
  return params;
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

/**
 * Extracts a named parameter from a route parameter map, throwing a descriptive
 * `Error` if the parameter is absent.
 *
 * Used by the legacy ROUTE_EXECUTOR helpers in this file and any user-supplied
 * route handlers that extend the catalog. Post-Track-8 in-tree REST bindings
 * do not call this function — they receive a pre-populated `pathParams` map
 * from `bindingPathMatches` via `RestBinding.extractInput`.
 *
 * @example
 * ```ts
 * import { getRequiredRouteParameter } from 'weft/server/handler';
 *
 * const params = { workflowId: 'wf-123' };
 * const id = getRequiredRouteParameter(params, 'workflowId', 'GET /v1/workflows/:workflowId');
 * console.log(id); // 'wf-123'
 *
 * // Throws: Missing route parameter "workflowId" for GET /v1/workflows/:workflowId
 * getRequiredRouteParameter({}, 'workflowId', 'GET /v1/workflows/:workflowId');
 * ```
 */
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

type RouteExecutionContext = {
  request: Request;
  engine: Engine;
  options: HandlerOptions | undefined;
};

type RouteExecutor = (context: RouteExecutionContext) => Promise<Response>;

const ROUTE_EXECUTORS: Record<HandlerName, RouteExecutor> = {
  healthCheck: async ({ request }) => negotiatedResponse(request, { status: 'ok' }),
  getMetrics: async ({ options }) =>
    handleGetMetrics(options?.prometheusExporter, options?.metricsCollector),
  openApiDocument: async ({ options }) =>
    jsonResponse(
      generateOpenApiDocument({
        registry: options?.operationRegistry ?? defaultOperationRegistry(),
        ...(options?.restBindings !== undefined ? { restBindings: options.restBindings } : {}),
        ...(options?.supportedAuthenticationSchemes !== undefined
          ? { supportedSchemes: options.supportedAuthenticationSchemes }
          : {}),
      }),
    ),
  openRpcDocument: async ({ options }) =>
    jsonResponse(
      generateOpenRpcDocument({
        registry: options?.operationRegistry ?? defaultOperationRegistry(),
        transports: ['http', 'websocket'],
      }),
    ),
};

// ---------------------------------------------------------------------------
// Main handler
// ---------------------------------------------------------------------------

/**
 * Options bag passed to `handleRequest` by the HTTP server wrapper.
 *
 * Injects the resolved authentication context, custom metrics exporters, and
 * an optional override for the operation registry and REST bindings.  Omit
 * `operationRegistry` and `restBindings` together to use the live defaults.
 *
 * @example
 * ```ts
 * import { type HandlerOptions } from 'weft/server/handler';
 *
 * const options: HandlerOptions = {
 *   authContext: { method: 'public' },
 * };
 * void options;
 * ```
 */
export interface HandlerOptions {
  /**
   * Optional authenticated caller context injected by the HTTP server
   * wrapper. See `AuthContext` in `authentication.ts` for field documentation.
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
  /** OpenAPI security schemes supported by the live server configuration. */
  supportedAuthenticationSchemes?: ReadonlySet<OpenApiSecuritySchemeName>;
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

/**
 * Count the number of `:param` placeholders in a route path pattern.
 *
 * Used as part of {@link shouldPreferLegacyRoute}'s tie-break: a route with
 * fewer parameters (i.e., more specific) wins over one with more.
 *
 * @example Count parameters in a route pattern
 * ```ts
 * import { countPathParameters } from 'weft/server/handler';
 *
 * countPathParameters('/v1/workflows/:id/signal/:name'); // 2
 * countPathParameters('/v1/workflows');                   // 0
 * ```
 */
export function countPathParameters(pathPattern: string): number {
  return pathPattern.split('/').filter((segment) => segment.startsWith(':')).length;
}

/**
 * Count the number of literal (non-parameter, non-empty) segments in a route
 * path pattern. Used as the secondary tie-break in
 * {@link shouldPreferLegacyRoute}: more literals wins.
 *
 * @example Count literal segments in a route pattern
 * ```ts
 * import { countLiteralSegments } from 'weft/server/handler';
 *
 * countLiteralSegments('/v1/workflows/:id/signal'); // 3 (v1, workflows, signal)
 * countLiteralSegments('/:any');                     // 0
 * ```
 */
export function countLiteralSegments(pathPattern: string): number {
  return pathPattern.split('/').filter((segment) => segment.length > 0 && !segment.startsWith(':'))
    .length;
}

/**
 * Decide which of two competing route matches should win when both bind to
 * the same path. Prefers the legacy binding when it is strictly more specific
 * (fewer parameters or, on tie, more literal segments).
 *
 * Returns `true` when the legacy `bindingMatch` should take precedence over
 * the catalog `routeMatch`; `false` otherwise (including when either side is
 * null).
 *
 * **Post-Track-8 note:** the four remaining legacy routes in `ROUTES`
 * (`/v1/health`, `/v1/metrics`, `/openapi.json`, `/openrpc.json`) carry zero
 * path parameters. As a result, the `routeParameterCount < bindingParameterCount`
 * branch in this function is currently dormant — the literal-segment count
 * tie-break is the only branch that fires in practice. The function retains
 * the full parameter-count logic to keep the precedence rule sound if a
 * parameterized legacy route is ever reintroduced.
 *
 * The `Parameters<typeof shouldPreferLegacyRoute>` pattern in the example
 * below is used because the `RouteMatch` type (second argument) is an
 * internal interface not exported from this module.
 *
 * @example Pick the winning route between a legacy binding and a catalog route
 * ```ts
 * import { shouldPreferLegacyRoute } from 'weft/server/handler';
 *
 * type Args = Parameters<typeof shouldPreferLegacyRoute>;
 * declare const bindingMatch: Args[0];
 * declare const routeMatch: Args[1];
 *
 * if (shouldPreferLegacyRoute(bindingMatch, routeMatch)) {
 *   // dispatch via the legacy binding
 * }
 * ```
 */
export function shouldPreferLegacyRoute(
  bindingMatch: { readonly binding: UnknownRestBinding } | null,
  routeMatch: RouteMatch | null,
): boolean {
  if (bindingMatch === null || routeMatch === null) {
    return false;
  }

  const bindingParameterCount = countPathParameters(bindingMatch.binding.path);
  const routeParameterCount = countPathParameters(routeMatch.path);
  return routeParameterCount !== bindingParameterCount
    ? routeParameterCount < bindingParameterCount
    : countLiteralSegments(routeMatch.path) > countLiteralSegments(bindingMatch.binding.path);
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

/**
 * Type guard that returns true if the value structurally resembles an
 * {@link OperationFault} (carries `code`, `message`, and `data` properties).
 *
 * Used by error handlers to decide whether a thrown value can be mapped to a
 * structured operation fault response, vs. needing to be wrapped in a generic
 * 500.
 *
 * @example Catch an unknown error and surface as a fault when it qualifies
 * ```ts
 * import { isOperationFaultLike } from 'weft/server/handler';
 *
 * try {
 *   // operation handler runs here
 * } catch (error) {
 *   if (isOperationFaultLike(error)) {
 *     // structured fault — pass through
 *   } else {
 *     // unknown — wrap as 500
 *   }
 * }
 * ```
 */
export function isOperationFaultLike(value: unknown): value is OperationFault {
  if (typeof value !== 'object' || value === null) {
    return false;
  }

  const candidate = value as Record<string, unknown>;
  if (
    !Object.hasOwn(candidate, 'code') ||
    !Object.hasOwn(candidate, 'message') ||
    !Object.hasOwn(candidate, 'data')
  ) {
    return false;
  }

  let code: unknown;
  let message: unknown;
  let data: unknown;
  try {
    code = candidate['code'];
    message = candidate['message'];
    data = candidate['data'];
  } catch {
    return false;
  }

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
    typeof message === 'string' &&
    typeof data === 'object' &&
    data !== null &&
    !Array.isArray(data)
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
 *
 * @example
 * ```ts
 * import { authContextToPrincipal } from 'weft/server/handler';
 *
 * const principal = authContextToPrincipal({
 *   method: 'api-key',
 * });
 * console.log(principal.method); // 'api-key'
 * ```
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

let _defaultRestBindings: ReadonlyArray<UnknownRestBinding> | undefined;
function defaultRestBindings(): ReadonlyArray<UnknownRestBinding> {
  if (_defaultRestBindings === undefined) {
    _defaultRestBindings = createLiveRestBindings();
  }
  return _defaultRestBindings;
}

/**
 * Pure HTTP request handler. Maps Request to Response.
 *
 * @example
 * ```ts
 * import { Engine, MemoryStorage, handleRequest } from 'weft';
 *
 * await using engine = new Engine({ storage: new MemoryStorage() });
 * engine.register('ping', async function* () { return 'pong'; });
 *
 * const request = new Request('http://localhost/v1/health');
 * const response = await handleRequest(request, engine);
 * console.log(response.status); // 200
 * ```
 */
// oxlint-disable-next-line eslint(complexity) -- this request boundary intentionally owns binding-first dispatch, legacy fallback, and compatibility shims in one place.
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
  const restBindings = options?.restBindings ?? defaultRestBindings();
  const operationRegistry = options?.operationRegistry ?? defaultOperationRegistry();
  let bindingMatch: ReturnType<typeof matchRestBinding>;
  try {
    bindingMatch = matchRestBinding(request.method, url.pathname, restBindings);
  } catch (error) {
    if (error instanceof MalformedRouteParameterError) return errorResponse(error.message, 400);
    throw error;
  }

  const route = matchRoute(request.method, url.pathname);

  if (bindingMatch !== null && !shouldPreferLegacyRoute(bindingMatch, route)) {
    try {
      const principal = authContextToPrincipal(options?.authContext);
      return await dispatchViaExecuteOperation(
        request,
        engine,
        bindingMatch.binding,
        bindingMatch.pathParams,
        operationRegistry,
        principal,
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

  try {
    const executor = ROUTE_EXECUTORS[route.handler];
    return await executor({ request, engine, options });
  } catch (error) {
    console.error('Unhandled error in handleRequest', {
      method: request.method,
      path: url.pathname,
      error,
    });
    return errorResponse('Internal server error', 500);
  }
}
