/**
 * Service Worker bootstrap functions for Weft.
 *
 * Composable functions that users wire up in their own Service Worker file.
 * Does NOT auto-register event listeners.
 *
 * @module service-worker
 */

import type { Engine } from '../core/engine';
import { handleRequest } from '../server/handler';
import type { ServiceWorkerScheduler } from './scheduler';

// ---------------------------------------------------------------------------
// Minimal Service Worker type interfaces
// (avoids conflicts between webworker and Bun type libs)
// ---------------------------------------------------------------------------

/** Minimal FetchEvent shape for Service Worker compatibility. */
interface MinimalFetchEvent {
  request: Request;
  respondWith(response: Response | Promise<Response>): void;
}

/** Minimal ExtendableEvent shape for Service Worker compatibility. */
interface MinimalExtendableEvent {
  waitUntil(promise: Promise<unknown>): void;
}

/** Periodic sync event shape. */
interface MinimalPeriodicSyncEvent extends MinimalExtendableEvent {
  tag: string;
}

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export interface ServiceWorkerOptions {
  engine: Engine;
  pathPrefix?: string;
}

// ---------------------------------------------------------------------------
// Default constants
// ---------------------------------------------------------------------------

const DEFAULT_PATH_PREFIX = '/weft/';
const DEFAULT_PERIODIC_SYNC_TAG = 'weft-timers';

// ---------------------------------------------------------------------------
// createFetchHandler
// ---------------------------------------------------------------------------

/**
 * Create a fetch event handler that intercepts requests matching the given
 * path prefix and delegates them to the Weft HTTP handler.
 */
export function createFetchHandler(
  options: ServiceWorkerOptions,
): (event: MinimalFetchEvent) => void {
  const { engine } = options;
  let pathPrefix = options.pathPrefix ?? DEFAULT_PATH_PREFIX;

  // Normalize: ensure it ends with /
  if (!pathPrefix.endsWith('/')) {
    pathPrefix += '/';
  }

  return (event: MinimalFetchEvent) => {
    const url = new URL(event.request.url);
    const pathname = url.pathname;

    if (!pathname.startsWith(pathPrefix)) return;

    // Strip the prefix to produce the path that handleRequest expects.
    // e.g. /weft/v1/health -> /v1/health
    const strippedPathname = '/' + pathname.slice(pathPrefix.length);
    const strippedUrl = new URL(strippedPathname, url.origin);
    strippedUrl.search = url.search;

    const delegatedRequest = new Request(strippedUrl.toString(), {
      method: event.request.method,
      headers: event.request.headers,
      body: event.request.body,
    });

    event.respondWith(handleRequest(delegatedRequest, engine));
  };
}

// ---------------------------------------------------------------------------
// createPeriodicSyncHandler
// ---------------------------------------------------------------------------

/**
 * Create a periodic sync event handler that ticks the scheduler
 * when the matching tag fires.
 */
export function createPeriodicSyncHandler(
  scheduler: ServiceWorkerScheduler,
  tag?: string,
): (event: MinimalPeriodicSyncEvent) => void {
  const syncTag = tag ?? DEFAULT_PERIODIC_SYNC_TAG;

  return (event: MinimalPeriodicSyncEvent) => {
    if (event.tag !== syncTag) return;

    event.waitUntil(scheduler.tick());
  };
}

// ---------------------------------------------------------------------------
// createLifecycleHandlers
// ---------------------------------------------------------------------------

/**
 * Create install and activate lifecycle event handlers.
 *
 * - `install`: Calls `skipWaiting()` so the new Service Worker activates immediately.
 * - `activate`: Calls `clients.claim()` so open tabs use the new Service Worker.
 */
export function createLifecycleHandlers(): {
  install: (event: MinimalExtendableEvent) => void;
  activate: (event: MinimalExtendableEvent) => void;
} {
  // Access the global scope in a lint-safe way.
  const serviceWorkerScope = globalThis as Record<string, unknown>;

  return {
    install: (event: MinimalExtendableEvent) => {
      // In a real Service Worker, self.skipWaiting() is available globally.
      // We wrap it in a resolved promise for environments where it may not exist.
      const skipWaiting = serviceWorkerScope['skipWaiting'];
      const skipWaitingPromise =
        typeof skipWaiting === 'function' ? (skipWaiting() as Promise<void>) : Promise.resolve();
      event.waitUntil(skipWaitingPromise);
    },
    activate: (event: MinimalExtendableEvent) => {
      // In a real Service Worker, self.clients.claim() is available globally.
      const clients = serviceWorkerScope['clients'] as { claim?: () => Promise<void> } | undefined;
      const claimPromise =
        clients !== undefined && clients !== null && typeof clients.claim === 'function'
          ? clients.claim()
          : Promise.resolve();
      event.waitUntil(claimPromise);
    },
  };
}
