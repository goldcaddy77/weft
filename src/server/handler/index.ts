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

import type { Engine } from '../../core/engine.ts';
import { MalformedRouteParameterError } from '../rest-binding.ts';
import { matchRestBinding, shouldPreferLegacyRoute } from './binding-dispatch.ts';
import { errorResponse } from './response-helpers.ts';
import {
  ROUTE_EXECUTORS,
  authContextToPrincipal,
  defaultOperationRegistry,
  defaultRestBindings,
  dispatchViaExecuteOperation,
  type HandlerOptions,
} from './route-dispatch.ts';
import { matchRoute } from './route-matching.ts';

export {
  countLiteralSegments,
  countPathParameters,
  shouldPreferLegacyRoute,
} from './binding-dispatch.ts';
export {
  authContextToPrincipal,
  isOperationFaultLike,
  type HandlerOptions,
} from './route-dispatch.ts';
export { extractRouteParameters, getRequiredRouteParameter } from './route-matching.ts';

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
// oxlint-disable-next-line eslint(complexity) -- ID:server-handler-route-binding-dispatch-complexity -- this request boundary intentionally owns binding-first dispatch, legacy fallback, and compatibility shims in one place.
export async function handleRequest(
  request: Request,
  engine: Engine,
  options?: HandlerOptions,
): Promise<Response> {
  const url = new URL(request.url);

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

  let route: ReturnType<typeof matchRoute>;
  try {
    route = matchRoute(request.method, url.pathname);
  } catch (error) {
    if (error instanceof MalformedRouteParameterError) return errorResponse(error.message, 400);
    throw error;
  }

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
