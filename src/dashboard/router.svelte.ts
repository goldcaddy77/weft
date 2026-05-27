/**
 * History API router using Svelte 5 runes.
 *
 * Provides reactive route state, programmatic navigation,
 * and pattern matching against the dashboard route table.
 *
 * @module dashboard/router
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ViewName =
  | 'workflow-list'
  | 'workflow-detail'
  | 'human-review-queue'
  | 'workers-and-queues'
  | 'not-found';

export interface RouteState {
  path: string;
  params: Record<string, string>;
  query: URLSearchParams;
}

export interface RouteMatch {
  view: ViewName;
  params: Record<string, string>;
}

// ---------------------------------------------------------------------------
// Route table
// ---------------------------------------------------------------------------

interface RouteDefinition {
  pattern: RegExp;
  paramNames: string[];
  view: ViewName;
}

const ROUTE_TABLE: RouteDefinition[] = [
  { pattern: /^\/?$/, paramNames: [], view: 'workflow-list' },
  { pattern: /^\/workflows\/?$/, paramNames: [], view: 'workflow-list' },
  { pattern: /^\/workflows\/([^/]+)\/?$/, paramNames: ['id'], view: 'workflow-detail' },
  { pattern: /^\/reviews\/?$/, paramNames: [], view: 'human-review-queue' },
  { pattern: /^\/workers\/?$/, paramNames: [], view: 'workers-and-queues' },
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function parseLocation(): RouteState {
  return {
    path: window.location.pathname,
    params: {},
    query: new URLSearchParams(window.location.search),
  };
}

// ---------------------------------------------------------------------------
// Match a pathname against the route table
// ---------------------------------------------------------------------------

export function matchRoute(pathname: string): RouteMatch {
  for (const definition of ROUTE_TABLE) {
    const match = definition.pattern.exec(pathname);
    if (!match) continue;

    const params: Record<string, string> = {};
    for (let i = 0; i < definition.paramNames.length; i++) {
      const name = definition.paramNames[i];
      const value = match[i + 1];
      if (name !== undefined && value !== undefined) {
        params[name] = decodeURIComponent(value);
      }
    }

    return { view: definition.view, params };
  }

  return { view: 'not-found', params: {} };
}

// ---------------------------------------------------------------------------
// Reactive route state (module-level singleton)
// ---------------------------------------------------------------------------

export const route: RouteState = $state(parseLocation());

// ---------------------------------------------------------------------------
// Navigate programmatically
// ---------------------------------------------------------------------------

export function navigate(path: string): void {
  window.history.pushState(null, '', path);
  const next = parseLocation();
  route.path = next.path;
  route.params = next.params;
  route.query = next.query;
}

// ---------------------------------------------------------------------------
// Listen for popstate (back/forward navigation)
// ---------------------------------------------------------------------------

if (typeof window !== 'undefined') {
  window.addEventListener('popstate', () => {
    const next = parseLocation();
    route.path = next.path;
    route.params = next.params;
    route.query = next.query;
  });
}
