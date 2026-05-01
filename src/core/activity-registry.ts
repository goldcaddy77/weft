/**
 * WeakMap-backed activity registry.
 *
 * Metadata is keyed to function references in a WeakMap so that lookup by
 * function reference is O(1). A separate name index (plain Map) holds strong
 * references to registered functions, keeping them alive until explicitly
 * unregistered. When a function is unregistered, removing it from the name
 * index releases the strong reference and allows the WeakMap entry to be
 * collected.
 *
 * @module core/activity-registry
 */

import type { Duration, RetryPolicy } from './types.ts';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * Metadata stored per-activity, keyed to the function reference in a WeakMap.
 *
 * @example
 * ```ts
 * import { ActivityRegistry, type ActivityMetadata } from 'weft';
 *
 * const registry = new ActivityRegistry();
 * const fn = async (input: unknown) => ({ result: input });
 * registry.register('processOrder', fn, { queue: 'orders', timeout: '30s' });
 *
 * const meta: ActivityMetadata | undefined = registry.getMetadata(fn);
 * console.log(meta?.name);   // 'processOrder'
 * console.log(meta?.queue);  // 'orders'
 * ```
 */
export interface ActivityMetadata {
  name: string;
  queue: string;
  retry?: RetryPolicy;
  timeout?: Duration;
  idempotent?: boolean;
}

/**
 * Optional overrides when registering an activity.
 *
 * @example
 * ```ts
 * import { ActivityRegistry, type ActivityRegistrationOptions } from 'weft';
 *
 * const options: ActivityRegistrationOptions = {
 *   queue: 'high-priority',
 *   timeout: '60s',
 *   idempotent: true,
 * };
 *
 * const registry = new ActivityRegistry();
 * const fn = async (input: unknown) => input;
 * registry.register('sendNotification', fn, options);
 * ```
 */
export interface ActivityRegistrationOptions {
  queue?: string;
  retry?: RetryPolicy;
  timeout?: Duration;
  idempotent?: boolean;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Detect whether `fn` carries colocated metadata from the `activity()` helper.
 * The helper assigns `name`, `execute`, and optionally `retry`, `timeout`,
 * `queue`, and `idempotent` as own properties on the returned function.
 */
// oxlint-disable-next-line complexity -- ID:core-activity-registry-extract-definition-metadata-complexity
function extractDefinitionMetadata(fn: object): Partial<ActivityRegistrationOptions> {
  const result: Partial<ActivityRegistrationOptions> = {};
  const record = fn as Record<string, unknown>;

  if ('queue' in fn && typeof record['queue'] === 'string') {
    result.queue = record['queue'];
  }
  if ('retry' in fn && typeof record['retry'] === 'object' && record['retry'] !== null) {
    result.retry = record['retry'] as RetryPolicy;
  }
  if (
    'timeout' in fn &&
    (typeof record['timeout'] === 'string' || typeof record['timeout'] === 'number')
  ) {
    result.timeout = record['timeout'];
  }
  if ('idempotent' in fn && typeof record['idempotent'] === 'boolean') {
    result.idempotent = record['idempotent'];
  }

  return result;
}

// ---------------------------------------------------------------------------
// ActivityRegistry
// ---------------------------------------------------------------------------

/**
 * WeakMap-backed registry mapping activity names to their execute functions
 * and metadata. Used internally by the {@link Engine} to dispatch activities
 * by name. Call `engine.registerActivity(name, fn, options)` rather than
 * constructing an `ActivityRegistry` directly — the engine manages the
 * registry lifecycle.
 *
 * @example
 * ```ts
 * import { ActivityRegistry } from 'weft';
 *
 * const registry = new ActivityRegistry();
 * const fn = async (input: unknown) => ({ result: input });
 * registry.register('processOrder', fn, { queue: 'orders', timeout: '30s' });
 *
 * const meta = registry.getMetadata(fn);
 * console.log(meta?.name);   // 'processOrder'
 * console.log(meta?.queue);  // 'orders'
 * ```
 */
export class ActivityRegistry {
  /** Metadata keyed to the activity function object. */
  #metadata: WeakMap<object, ActivityMetadata>;

  /**
   * Name → function lookup. Holds strong references to registered functions,
   * keeping them (and their WeakMap metadata) alive until explicitly
   * unregistered.
   */
  #nameIndex: Map<string, object>;

  constructor() {
    this.#metadata = new WeakMap();
    this.#nameIndex = new Map();
  }

  /**
   * Register an activity function with associated metadata.
   *
   * If `fn` was created via the `activity()` helper, metadata is
   * auto-extracted from its colocated properties. Explicit `options`
   * take precedence over auto-extracted values.
   */
  // `any` to accept functions of any parameter type (contravariance prevents `unknown` here).
  // oxlint-disable-next-line complexity -- ID:core-activity-registry-constructor-complexity
  register<T extends (...arguments_: any[]) => any>(
    name: string,
    fn: T,
    options?: ActivityRegistrationOptions,
  ): void {
    // Clean up any previous registration under this name to avoid leaking
    // the old function in #metadata. Only delete metadata if no other name
    // still references the same function.
    const existingFn = this.#nameIndex.get(name);
    if (existingFn && existingFn !== fn) {
      let stillReferenced = false;
      for (const [registeredName, registeredFn] of this.#nameIndex) {
        if (registeredName !== name && registeredFn === existingFn) {
          stillReferenced = true;
          break;
        }
      }

      if (!stillReferenced) {
        this.#metadata.delete(existingFn);
      }
    }

    const extracted = extractDefinitionMetadata(fn);

    const metadata: ActivityMetadata = {
      name,
      queue: options?.queue ?? extracted.queue ?? 'default',
    };

    const retry = options?.retry ?? extracted.retry;
    if (retry !== undefined) metadata.retry = retry;

    const timeout = options?.timeout ?? extracted.timeout;
    if (timeout !== undefined) metadata.timeout = timeout;

    const idempotent = options?.idempotent ?? extracted.idempotent;
    if (idempotent !== undefined) metadata.idempotent = idempotent;

    this.#metadata.set(fn, metadata);
    this.#nameIndex.set(name, fn);
  }

  /** Check whether an activity is registered under the given name. */
  has(name: string): boolean {
    return this.#nameIndex.has(name);
  }

  /** Resolve a function by its registered name. Returns `undefined` if not found. */
  resolve(name: string): ((...arguments_: unknown[]) => unknown) | undefined {
    const fn = this.#nameIndex.get(name);
    if (!fn) return undefined;
    return fn as (...arguments_: unknown[]) => unknown;
  }

  /** Get metadata for a function reference. Returns `undefined` if the function was never registered. */
  getMetadata<T extends (...arguments_: any[]) => any>(fn: T): ActivityMetadata | undefined {
    return this.#metadata.get(fn);
  }

  /** Get metadata by activity name. Resolves the function first, then looks up its metadata. */
  getMetadataByName(name: string): ActivityMetadata | undefined {
    const fn = this.resolve(name);
    if (!fn) return undefined;
    return this.#metadata.get(fn);
  }

  /** Remove an activity registration by name. */
  unregister(name: string): void {
    const fn = this.#nameIndex.get(name);
    this.#nameIndex.delete(name);

    if (fn) {
      let stillReferenced = false;
      for (const registeredFn of this.#nameIndex.values()) {
        if (registeredFn === fn) {
          stillReferenced = true;
          break;
        }
      }

      if (!stillReferenced) {
        this.#metadata.delete(fn);
      }
    }
  }

  /** Iterate over all registered activity names. */
  *names(): IterableIterator<string> {
    yield* this.#nameIndex.keys();
  }
}
