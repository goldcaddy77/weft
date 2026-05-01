import { bindingPathMatches } from '../rest-binding.ts';
import type { UnknownRestBinding } from '../rest-bindings.ts';
import type { RouteMatch } from './route-matching.ts';

/**
 * Find a REST binding that matches the request's method and path.
 * Returns null if no binding matches (caller falls back to legacy
 * dispatch). Delegates path resolution to the canonical
 * `bindingPathMatches` helper — single source of truth for
 * segment-and-param matching across router and OpenAPI generator.
 */
export function matchRestBinding(
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
