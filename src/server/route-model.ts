/**
 * Shared route definitions for the workflow REST API.
 *
 * Both `handleRequest()` and the OpenAPI generator consume this model,
 * ensuring the handler and the API documentation always agree.
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
 * All REST API routes. Each entry is the single source of truth for the
 * route's method, path, parameters, and documentation.
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
    path: '/v1/schedules',
    handler: 'listSchedules',
    paramNames: [],
    summary: 'List recurring schedules',
    tags: ['Schedules'],
  },
  {
    method: 'GET',
    path: '/v1/schedules/:id',
    handler: 'getSchedule',
    paramNames: ['id'],
    summary: 'Get one recurring schedule',
    tags: ['Schedules'],
  },
  {
    method: 'GET',
    path: '/v1/tenants/:id/quota',
    handler: 'getTenantQuota',
    paramNames: ['id'],
    summary: 'Get quota usage for a tenant',
    tags: ['Budget'],
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
    path: '/v1/workflows/:id/replay/:step',
    handler: 'replayWorkflowToStep',
    paramNames: ['id', 'step'],
    summary: 'Replay a workflow to a historical checkpoint step',
    tags: ['Checkpoints'],
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
