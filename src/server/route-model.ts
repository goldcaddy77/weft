/**
 * Shared route definitions for the workflow REST API.
 *
 * Both `handleRequest()` and the OpenAPI generator consume this model,
 * ensuring the handler and the API documentation always agree.
 *
 * As of Wave 1, only routes that are intentionally REST-only direct
 * handlers remain here. All cataloged runtime operations have been
 * migrated to `rest-bindings.ts`:
 *   - `GET /v1/schedules`           → `weft.schedules.list`
 *   - `GET /v1/schedules/:id`       → `weft.schedules.get`
 *   - `GET /v1/tenants/:id/quota`   → `weft.tenants.quota.get`
 *   - `GET /v1/workflows/:id/replay/:step` → `weft.workflows.replay`
 *
 * Intentional REST-only direct handlers that remain:
 *   - `GET /v1/health`    — anonymous liveness probe (no catalog op)
 *   - `GET /v1/metrics`   — Prometheus text exposition (text/plain, no catalog op)
 *   - `GET /openapi.json` — transport-meta endpoint (self-describing, no catalog op)
 *
 * @module server/route-model
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** HTTP method for a route. */
export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

/** A single REST API route definition. */
export type RouteDefinition = {
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
};

// ---------------------------------------------------------------------------
// Route definitions
// ---------------------------------------------------------------------------

/**
 * Intentionally REST-only routes. These are not in the operation catalog.
 * See module JSDoc for the full list of routes migrated to catalog operations.
 *
 * `as const` preserves the literal types of `handler` so consumers can
 * derive a string-literal union (see `HandlerName` in handler.ts) for
 * compile-time exhaustiveness on route executors.
 */
export const ROUTES = [
  {
    method: 'GET',
    path: '/v1/health',
    handler: 'healthCheck',
    paramNames: [],
    summary: 'Health check',
    tags: ['System'],
  },
  {
    method: 'GET',
    path: '/v1/metrics',
    handler: 'getMetrics',
    paramNames: [],
    summary: 'Prometheus metrics export',
    tags: ['Observability'],
  },
  {
    method: 'GET',
    path: '/openapi.json',
    handler: 'openApiDocument',
    paramNames: [],
    summary: 'OpenAPI 3.1 specification',
    tags: ['System'],
  },
] as const satisfies readonly RouteDefinition[];

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
