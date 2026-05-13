/**
 * Shared direct-route definitions for REST-only HTTP endpoints.
 *
 * Operation-backed REST endpoints are modeled by `RestBinding` instances.
 * These six endpoints stay direct because they describe or expose the HTTP
 * server itself rather than a durable workflow operation:
 *   - `GET /v1/health`    — anonymous liveness probe (no catalog op)
 *   - `GET /v1/metrics`   — Prometheus text exposition (text/plain, no catalog op)
 *   - `GET /.well-known/api-catalog` — RFC 9264 service-desc linkset
 *   - `GET /asyncapi.json` — transport-meta endpoint (self-describing, no catalog op)
 *   - `GET /openapi.json` — transport-meta endpoint (self-describing, no catalog op)
 *   - `GET /openrpc.json` — transport-meta endpoint (self-describing, no catalog op)
 *
 * @module server/route-model
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** HTTP method for a route. */
export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

export type DirectRouteResponseMediaType =
  | 'application/json'
  | 'application/msgpack'
  | 'application/linkset+json'
  | 'text/plain';

export type DirectRouteResponseSchema = 'object' | 'string';

export type DirectRouteResponseContent = {
  /** Media type advertised for this response body. */
  mediaType: DirectRouteResponseMediaType;
  /** Minimal OpenAPI schema shape for this response body. */
  schema: DirectRouteResponseSchema;
};

export type DirectRouteResponse = {
  /** HTTP status emitted by the direct route. */
  status: number;
  /** Human-readable response description for OpenAPI. */
  description: string;
  /** Response body variants advertised by the direct route, when it has a body. */
  content?: readonly DirectRouteResponseContent[];
};

export type DirectRouteAccess = 'public' | 'authenticated';

/** A single direct HTTP route definition. */
export type DirectHttpRouteDefinition = {
  /** HTTP method. */
  method: HttpMethod;
  /**
   * Express-style path pattern (e.g. `/v1/workflows/:id/signal/:name`).
   * Used to generate OpenAPI path items and regex patterns.
   */
  path: string;
  /** Internal handler function name. */
  handler: string;
  /** Ordered list of path parameter names. */
  paramNames: string[];
  /** Human-readable summary for OpenAPI. */
  summary: string;
  /** OpenAPI tags for grouping. */
  tags: string[];
  /** Response metadata shared by dispatch documentation. */
  responses: readonly DirectRouteResponse[];
  /** Direct route access policy for authentication and OpenAPI metadata. */
  access: DirectRouteAccess;
};

// ---------------------------------------------------------------------------
// Route definitions
// ---------------------------------------------------------------------------

/**
 * Intentionally REST-only routes. These are not in the operation catalog.
 *
 * `as const` preserves the literal types of `handler` so consumers can
 * derive a string-literal union for compile-time exhaustiveness on route
 * executors.
 */
export const DIRECT_HTTP_ROUTES = [
  {
    method: 'GET',
    path: '/v1/health',
    handler: 'healthCheck',
    paramNames: [],
    summary: 'Health check',
    tags: ['System'],
    responses: [
      {
        status: 200,
        description: 'Service health status',
        content: [
          { mediaType: 'application/json', schema: 'object' },
          { mediaType: 'application/msgpack', schema: 'object' },
        ],
      },
    ],
    access: 'public',
  },
  {
    method: 'GET',
    path: '/v1/metrics',
    handler: 'getMetrics',
    paramNames: [],
    summary: 'Prometheus metrics export',
    tags: ['Observability'],
    responses: [
      {
        status: 200,
        description: 'Prometheus metrics exposition',
        content: [{ mediaType: 'text/plain', schema: 'string' }],
      },
      {
        status: 503,
        description: 'Metrics exporter failure',
        content: [{ mediaType: 'application/json', schema: 'object' }],
      },
    ],
    access: 'public',
  },
  {
    method: 'GET',
    path: '/.well-known/api-catalog',
    handler: 'apiCatalog',
    paramNames: [],
    summary: 'RFC 9264 API catalog linkset',
    tags: ['System'],
    responses: [
      {
        status: 200,
        description: 'RFC 9264 API catalog linkset',
        content: [{ mediaType: 'application/linkset+json', schema: 'object' }],
      },
      {
        status: 421,
        description: 'Request host rejected by trustedHosts',
        content: [{ mediaType: 'application/json', schema: 'object' }],
      },
      {
        status: 503,
        description: 'API catalog origin is not configured',
        content: [{ mediaType: 'application/json', schema: 'object' }],
      },
    ],
    access: 'public',
  },
  {
    method: 'GET',
    path: '/openapi.json',
    handler: 'openApiDocument',
    paramNames: [],
    summary: 'OpenAPI 3.1 specification',
    tags: ['System'],
    responses: [
      {
        status: 200,
        description: 'OpenAPI 3.1 specification',
        content: [{ mediaType: 'application/json', schema: 'object' }],
      },
    ],
    access: 'public',
  },
  {
    method: 'GET',
    path: '/openrpc.json',
    handler: 'openRpcDocument',
    paramNames: [],
    summary: 'OpenRPC 1.3.2 specification',
    tags: ['System'],
    responses: [
      {
        status: 200,
        description: 'OpenRPC 1.3.2 specification',
        content: [{ mediaType: 'application/json', schema: 'object' }],
      },
    ],
    access: 'public',
  },
  {
    method: 'GET',
    path: '/asyncapi.json',
    handler: 'asyncApiDocument',
    paramNames: [],
    summary: 'AsyncAPI 3.0 specification',
    tags: ['System'],
    responses: [
      {
        status: 200,
        description: 'AsyncAPI 3.0 specification',
        content: [{ mediaType: 'application/json', schema: 'object' }],
      },
    ],
    access: 'public',
  },
] as const satisfies readonly DirectHttpRouteDefinition[];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Convert an Express-style path to an OpenAPI path template.
 * `/v1/workflows/:id/signal/:name` → `/v1/workflows/{id}/signal/{name}`
 */
export function toOpenApiPath(path: string): string {
  return path.replace(/:([^/]+)/g, '{$1}');
}

/** Escape regex metacharacters in a literal path segment. */
function escapeRegexLiteral(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Convert an Express-style path to a regex pattern for route matching.
 *
 * Each segment is either a literal (with regex metacharacters escaped) or a
 * parameter placeholder:
 * - `:step` becomes `(\\d+)` for numeric-only matching (checkpoint routes)
 * - `:name` becomes `([^/]+)` for any non-slash token
 *
 * Escaping the literal segments prevents characters like `.` in paths such as
 * `/openapi.json` from being treated as wildcards (which would match
 * `/openapiXjson`).
 */
export function toRegex(path: string): RegExp {
  const regexStr = path
    .split('/')
    .map((segment) => {
      if (segment === ':step') return '(\\d+)';
      if (segment.startsWith(':')) return '([^/]+)';
      return escapeRegexLiteral(segment);
    })
    .join('/');
  return new RegExp(`^${regexStr}$`);
}
