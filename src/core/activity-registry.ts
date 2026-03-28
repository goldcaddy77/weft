/**
 * WeakMap-backed activity registry.
 *
 * Metadata is keyed to function references so that when an activity function
 * is garbage collected, its metadata is automatically cleaned up. A name
 * index backed by `WeakRef` enables lookup by string name; a
 * `FinalizationRegistry` prunes stale name entries when the underlying
 * function is collected.
 *
 * @module core/activity-registry
 */

import type { Duration, RetryPolicy } from './types.ts';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** Metadata stored per-activity, keyed to the function reference in a WeakMap. */
export interface ActivityMetadata {
  name: string;
  queue: string;
  retry?: RetryPolicy;
  timeout?: Duration;
  idempotent?: boolean;
}

/** Optional overrides when registering an activity. */
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
function extractDefinitionMetadata(fn: object): Partial<ActivityRegistrationOptions> {
  const result: Partial<ActivityRegistrationOptions> = {};
  const record = fn as Record<string, unknown>;

  if ('queue' in fn && typeof record['queue'] === 'string') {
    result.queue = record['queue'];
  }
  if ('retry' in fn && typeof record['retry'] === 'object' && record['retry'] !== null) {
    result.retry = record['retry'] as RetryPolicy;
  }
  if ('timeout' in fn) {
    result.timeout = record['timeout'] as Duration;
  }
  if ('idempotent' in fn && typeof record['idempotent'] === 'boolean') {
    result.idempotent = record['idempotent'];
  }

  return result;
}

// ---------------------------------------------------------------------------
// ActivityRegistry
// ---------------------------------------------------------------------------

export class ActivityRegistry {
  /**
   * Primary storage: metadata keyed to the activity function object.
   * When the function is GC'd, the entry is automatically removed.
   */
  #metadata = new WeakMap<object, ActivityMetadata>();

  /**
   * Name → function lookup via WeakRef. Enables resolving activities by
   * string name (required for worker-based execution where the generator
   * yields a name, not a function reference).
   */
  #nameIndex = new Map<string, WeakRef<object>>();

  /**
   * Prunes stale #nameIndex entries when a function is garbage collected.
   */
  #finalization = new FinalizationRegistry<string>((name) => {
    this.#nameIndex.delete(name);
  });

  /**
   * Register an activity function with associated metadata.
   *
   * If `fn` was created via the `activity()` helper, metadata is
   * auto-extracted from its colocated properties. Explicit `options`
   * take precedence over auto-extracted values.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- generic constraint must use
  // `any` to accept functions of any parameter type (contravariance prevents `unknown` here).
  register<T extends (...arguments_: any[]) => any>(
    name: string,
    fn: T,
    options?: ActivityRegistrationOptions,
  ): void {
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
    this.#nameIndex.set(name, new WeakRef(fn));
    this.#finalization.register(fn, name);
  }

  /** Check whether an activity is registered under the given name. */
  has(name: string): boolean {
    const ref = this.#nameIndex.get(name);
    if (!ref) return false;
    const fn = ref.deref();
    if (!fn) {
      this.#nameIndex.delete(name);
      return false;
    }
    return true;
  }

  /** Resolve a function by its registered name. Returns `undefined` if not found or collected. */
  resolve(name: string): ((...arguments_: unknown[]) => unknown) | undefined {
    const ref = this.#nameIndex.get(name);
    if (!ref) return undefined;
    const fn = ref.deref();
    if (!fn) {
      this.#nameIndex.delete(name);
      return undefined;
    }
    return fn as (...arguments_: unknown[]) => unknown;
  }

  /** Get metadata for a function reference. Returns `undefined` if the function was never registered. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
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
    const ref = this.#nameIndex.get(name);
    const fn = ref?.deref();
    if (fn) {
      this.#metadata.delete(fn);
    }
    this.#nameIndex.delete(name);
  }

  /** Iterate over all registered activity names. */
  *names(): IterableIterator<string> {
    for (const [name, ref] of this.#nameIndex) {
      if (ref.deref()) {
        yield name;
      } else {
        this.#nameIndex.delete(name);
      }
    }
  }
}
