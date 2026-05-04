import { MalformedRouteParameterError } from '../rest-binding.ts';
import { ROUTES, toRegex } from '../route-model.ts';

/** Union of all handler names derived from the shared route model. */
export type HandlerName = (typeof ROUTES)[number]['handler'];

export type RouteMatch = {
  handler: HandlerName;
  params: Record<string, string>;
  path: string;
};

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

export function matchRoute(method: string, pathname: string): RouteMatch | null {
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
