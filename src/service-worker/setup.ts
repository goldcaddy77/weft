/**
 * One-call Service Worker bootstrap for Weft.
 *
 * Wires up storage, engine, scheduler, and the four event listeners
 * (`install`, `activate`, `fetch`, `periodicsync`) in a single async call.
 * Use this when your Service Worker file calls `register` from inside the
 * helper. Use the lower-level `createFetchHandler` / `createPeriodicSyncHandler`
 * / `createLifecycleHandlers` factories when you've already registered
 * workflows synchronously and want explicit listener attachment.
 *
 * @module service-worker/setup
 */

import { Engine } from '../core/engine';
import { IndexedDBStorage } from '../storage/indexeddb';
import type { Storage as WeftStorage } from '../storage/interface';
import { handleRequest } from '../server/handler';
import { ServiceWorkerScheduler } from './scheduler';

const DEFAULT_PATH_PREFIX = '/weft/';
const DEFAULT_DATABASE_NAME = 'weft';
const DEFAULT_PERIODIC_SYNC_TAG = 'weft-timers';

/**
 * Options for {@link setupServiceWorker}. All fields are optional; the
 * helper supplies sensible defaults (`/weft/` path prefix, `'weft'`
 * IndexedDB database name, `'weft-timers'` periodic-sync tag).
 *
 * @example
 * ```ts
 * import { setupServiceWorker, type SetupServiceWorkerOptions } from 'weft/service-worker';
 *
 * const options: SetupServiceWorkerOptions = {
 *   pathPrefix: '/weft/',
 *   register(engine) {
 *     engine.register('checkout', async function* () {
 *       yield;
 *       return 'done';
 *     });
 *   },
 * };
 * void setupServiceWorker(options);
 * ```
 */
export interface SetupServiceWorkerOptions {
  /** Path prefix for engine HTTP routing. Default: `'/weft/'`. */
  pathPrefix?: string;
  /** IndexedDB database name. Default: `'weft'`. */
  databaseName?: string;
  /** Periodic-sync tag the scheduler ticks on. Default: `'weft-timers'`. */
  periodicSyncTag?: string;
  /**
   * Pre-built engine. If provided, must use the same storage instance as
   * `options.storage` (or its own storage if `storage` is omitted).
   */
  engine?: Engine;
  /**
   * Pre-built storage instance. Must be the same `===` reference as the
   * engine's storage when both are provided.
   */
  storage?: WeftStorage;
  /**
   * Register workflows on the engine before listeners do real work.
   * Resolves before the helper returns. Rejection causes subsequent
   * fetch/periodic-sync handlers to fail-fast with explicit errors.
   */
  register?: (engine: Engine) => void | Promise<void>;
}

/**
 * Result returned by {@link setupServiceWorker} once registration completes.
 *
 * @example
 * ```ts
 * import { setupServiceWorker } from 'weft/service-worker';
 *
 * const setup = await setupServiceWorker();
 * await setup.ready;
 * setup.engine.register('hello', async function* () {
 *   yield;
 *   return 'world';
 * });
 * ```
 */
export interface SetupServiceWorkerResult {
  engine: Engine;
  storage: WeftStorage;
  scheduler: ServiceWorkerScheduler;
  /** Resolves when `options.register` completes. Rejects if it threw. */
  ready: Promise<void>;
}

type SetupState =
  | { status: 'initializing'; resultPromise: Promise<SetupServiceWorkerResult> }
  | { status: 'attached'; result: SetupServiceWorkerResult }
  | { status: 'failed'; error: Error };

const setupRegistry = new WeakMap<object, SetupState>();

interface MinimalFetchEvent {
  request: Request;
  respondWith(response: Response | Promise<Response>): void;
}

interface MinimalExtendableEvent {
  waitUntil(promise: Promise<unknown>): void;
}

interface MinimalPeriodicSyncEvent extends MinimalExtendableEvent {
  tag: string;
}

interface ServiceWorkerScope {
  addEventListener?: (type: string, listener: (event: unknown) => void) => void;
  skipWaiting?: () => Promise<void>;
  clients?: { claim?: () => Promise<void> };
}

function getServiceWorkerScope(): ServiceWorkerScope | null {
  if (typeof self === 'undefined') return null;
  return self as unknown as ServiceWorkerScope;
}

function buildErrorResponse(error: Error): Response {
  return new Response(`Weft service worker registration failed: ${error.message}`, {
    status: 503,
    headers: { 'Content-Type': 'text/plain' },
  });
}

function checkExistingState(scope: ServiceWorkerScope): Promise<SetupServiceWorkerResult> | null {
  const existing = setupRegistry.get(scope);
  if (existing === undefined) return null;
  if (existing.status === 'initializing') return existing.resultPromise;
  if (existing.status === 'attached') {
    throw new Error('setupServiceWorker already initialized in this scope.');
  }
  throw new Error(
    'setupServiceWorker previously failed in this scope. Re-evaluate the worker script to retry.',
    { cause: existing.error },
  );
}

function resolveStorageAndEngine(
  options: SetupServiceWorkerOptions,
): { storage: WeftStorage; engine: Engine } {
  if (options.engine !== undefined && options.storage !== undefined) {
    if (options.engine.storage !== options.storage) {
      throw new TypeError(
        'setupServiceWorker: `options.engine.storage` must be the same instance as `options.storage`. ' +
          'Mismatched storage would persist timers and checkpoints to different databases.',
      );
    }
  }
  if (options.engine !== undefined) {
    return {
      engine: options.engine,
      storage: options.storage ?? options.engine.storage,
    };
  }
  const storage =
    options.storage ?? new IndexedDBStorage(options.databaseName ?? DEFAULT_DATABASE_NAME);
  return { storage, engine: new Engine({ storage }) };
}

function buildFetchListener(
  pathPrefix: string,
  engine: Engine,
  registrationReady: Promise<void>,
): (event: MinimalFetchEvent) => void {
  return (event) => {
    const url = new URL(event.request.url);
    if (!url.pathname.startsWith(pathPrefix)) return;
    const strippedPathname = '/' + url.pathname.slice(pathPrefix.length);
    const strippedUrl = new URL(strippedPathname, url.origin);
    strippedUrl.search = url.search;
    const delegatedRequest = new Request(strippedUrl.toString(), {
      method: event.request.method,
      headers: event.request.headers,
      body: event.request.body,
    });
    event.respondWith(
      registrationReady
        .then(() => handleRequest(delegatedRequest, engine))
        .catch((error: unknown) =>
          buildErrorResponse(error instanceof Error ? error : new Error(String(error))),
        ),
    );
  };
}

function attachListeners(
  scope: ServiceWorkerScope,
  pathPrefix: string,
  periodicSyncTag: string,
  engine: Engine,
  scheduler: ServiceWorkerScheduler,
  registrationReady: Promise<void>,
): void {
  const fetchListener = buildFetchListener(pathPrefix, engine, registrationReady);
  const periodicSyncListener = (event: MinimalPeriodicSyncEvent) => {
    if (event.tag !== periodicSyncTag) return;
    event.waitUntil(registrationReady.then(() => scheduler.tick()));
  };
  const installListener = (event: MinimalExtendableEvent) => {
    const skipWaitingPromise =
      typeof scope.skipWaiting === 'function' ? scope.skipWaiting.call(scope) : Promise.resolve();
    event.waitUntil(skipWaitingPromise);
  };
  const activateListener = (event: MinimalExtendableEvent) => {
    const clients = scope.clients;
    const claimPromise =
      clients !== undefined && typeof clients.claim === 'function'
        ? clients.claim.call(clients)
        : Promise.resolve();
    event.waitUntil(claimPromise);
  };
  // scope.addEventListener was already verified non-null by the caller.
  const addEventListener = scope.addEventListener!.bind(scope);
  addEventListener('install', installListener as (event: unknown) => void);
  addEventListener('activate', activateListener as (event: unknown) => void);
  addEventListener('fetch', fetchListener as (event: unknown) => void);
  addEventListener('periodicsync', periodicSyncListener as (event: unknown) => void);
}

function normalizePathPrefix(pathPrefix: string | undefined): string {
  const value = pathPrefix ?? DEFAULT_PATH_PREFIX;
  return value.endsWith('/') ? value : `${value}/`;
}

/**
 * Bootstrap a Weft engine inside a Service Worker scope. Attaches all four
 * event listeners synchronously, then awaits `register` before any handler
 * does real work. Safe to call once per worker evaluation; concurrent calls
 * during initialization converge to the same {@link SetupServiceWorkerResult}.
 *
 * @example
 * ```ts
 * /// <reference lib="webworker" />
 * import { setupServiceWorker } from 'weft/service-worker';
 *
 * const setup = await setupServiceWorker({
 *   register(engine) {
 *     engine.register('checkout', async function* () {
 *       yield;
 *       return 'done';
 *     });
 *   },
 * });
 * void setup;
 * ```
 */
export function setupServiceWorker(
  options: SetupServiceWorkerOptions = {},
): Promise<SetupServiceWorkerResult> {
  const scope = getServiceWorkerScope();
  if (scope === null) {
    return Promise.reject(
      new Error(
        'setupServiceWorker: `self` is undefined. Call this from within a Service Worker scope.',
      ),
    );
  }
  if (typeof scope.addEventListener !== 'function') {
    return Promise.reject(
      new Error(
        'setupServiceWorker: `self.addEventListener` is not a function. Not a Service Worker scope.',
      ),
    );
  }

  let existingResult: Promise<SetupServiceWorkerResult> | null;
  try {
    existingResult = checkExistingState(scope);
  } catch (error) {
    return Promise.reject(error);
  }
  if (existingResult !== null) return existingResult;

  let resolved: { storage: WeftStorage; engine: Engine };
  try {
    resolved = resolveStorageAndEngine(options);
  } catch (error) {
    return Promise.reject(error);
  }
  const { storage, engine } = resolved;

  const periodicSyncTag = options.periodicSyncTag ?? DEFAULT_PERIODIC_SYNC_TAG;
  const pathPrefix = normalizePathPrefix(options.pathPrefix);

  const scheduler = new ServiceWorkerScheduler({
    storage,
    onTimerFired: (entry) => engine.fireTimer(entry),
    periodicSyncTag,
  });

  const registrationReady: Promise<void> = Promise.resolve().then(async () => {
    if (options.register === undefined) return;
    await options.register(engine);
  });

  attachListeners(scope, pathPrefix, periodicSyncTag, engine, scheduler, registrationReady);

  const result: SetupServiceWorkerResult = {
    engine,
    storage,
    scheduler,
    ready: registrationReady,
  };

  const resultPromise = registrationReady.then(
    () => {
      setupRegistry.set(scope, { status: 'attached', result });
      return result;
    },
    (error: unknown) => {
      const wrapped = error instanceof Error ? error : new Error(String(error));
      setupRegistry.set(scope, { status: 'failed', error: wrapped });
      throw wrapped;
    },
  );

  setupRegistry.set(scope, { status: 'initializing', resultPromise });
  return resultPromise;
}

/**
 * Test helper: clear the per-scope setup registry. Production code does not
 * call this. Exposed so tests can simulate fresh worker evaluations without
 * tearing down the scope itself.
 *
 * @example
 * ```ts
 * import { resetSetupServiceWorkerRegistry } from 'weft/service-worker';
 * declare const fakeScope: object;
 * resetSetupServiceWorkerRegistry(fakeScope);
 * ```
 */
export function resetSetupServiceWorkerRegistry(scope?: object): void {
  if (scope !== undefined) {
    setupRegistry.delete(scope);
    return;
  }
  const sw = getServiceWorkerScope();
  if (sw !== null) setupRegistry.delete(sw);
}
