/**
 * Dashboard SPA route table — the single source of truth for client-side
 * routing, kept in a plain (non-runes) module so it can be imported by the
 * Svelte router, the server (to derive the static mount routes), and tests
 * without pulling in `window` or Svelte's runes.
 *
 * @module dashboard/route-table
 */

export type ViewName =
  | 'workflow-list'
  | 'workflow-detail'
  | 'human-review-queue'
  | 'workers-and-queues'
  | 'not-found';

export interface RouteDefinition {
  pattern: RegExp;
  paramNames: string[];
  view: ViewName;
  /**
   * The Bun static-route pattern the server must mount so a hard reload of this
   * page resolves to the SPA shell. `*` covers a single path parameter. `null`
   * for routes already covered by another entry's mount pattern (e.g. the bare
   * `/workflows` list shares the `/workflows` mount with its detail route).
   */
  mountPattern: string | null;
}

export const ROUTE_TABLE: RouteDefinition[] = [
  { pattern: /^\/?$/, paramNames: [], view: 'workflow-list', mountPattern: '/' },
  {
    pattern: /^\/workflows\/?$/,
    paramNames: [],
    view: 'workflow-list',
    mountPattern: '/workflows',
  },
  {
    pattern: /^\/workflows\/([^/]+)\/?$/,
    paramNames: ['id'],
    view: 'workflow-detail',
    mountPattern: '/workflows/*',
  },
  {
    pattern: /^\/reviews\/?$/,
    paramNames: [],
    view: 'human-review-queue',
    mountPattern: '/reviews',
  },
  {
    pattern: /^\/workers\/?$/,
    paramNames: [],
    view: 'workers-and-queues',
    mountPattern: '/workers',
  },
];

/**
 * The de-duplicated set of Bun static-route patterns at which the dashboard
 * shell must be mounted, derived from {@link ROUTE_TABLE}. The server consumes
 * this so the static mount list can never silently drift from the SPA's
 * client-side routes.
 *
 * @example
 * ```ts
 * import { DASHBOARD_MOUNT_PATTERNS } from 'weft/dashboard/route-table';
 * console.log(DASHBOARD_MOUNT_PATTERNS.includes('/workflows/*')); // true
 * ```
 */
export const DASHBOARD_MOUNT_PATTERNS: readonly string[] = [
  ...new Set(
    ROUTE_TABLE.map((definition) => definition.mountPattern).filter(
      (pattern): pattern is string => pattern !== null,
    ),
  ),
];
