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

import {
  isDefinitionSchema,
  type DefinitionSchema,
  type Duration,
  type RetryPolicy,
} from './types.ts';

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
  /** Registered activity name. */
  name: string;
  /** Queue used for activity dispatch. */
  queue: string;
  /** User-facing description for catalog, code generation, and tool surfaces. */
  description?: string;
  /** User-facing grouping tags for catalog and documentation surfaces. */
  tags?: ReadonlyArray<string>;
  /** Optional input schema metadata for introspection; core execution does not validate input against it. */
  inputSchema?: DefinitionSchema;
  /** Optional output schema metadata for introspection; core execution does not validate output against it. */
  outputSchema?: DefinitionSchema;
  /** Retry policy used when the activity fails. */
  retry?: RetryPolicy;
  /** Activity execution timeout. */
  timeout?: Duration;
  /** Whether the activity can be safely repeated. */
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
  /** Queue used for activity dispatch. */
  queue?: string;
  /** User-facing description for catalog, code generation, and tool surfaces. */
  description?: string;
  /** User-facing grouping tags for catalog and documentation surfaces. */
  tags?: ReadonlyArray<string>;
  /** Optional input schema metadata for introspection; core execution validates shape but not input. */
  inputSchema?: DefinitionSchema;
  /** Optional output schema metadata for introspection; core execution validates shape but not output. */
  outputSchema?: DefinitionSchema;
  /** Retry policy used when the activity fails. */
  retry?: RetryPolicy;
  /** Activity execution timeout. */
  timeout?: Duration;
  /** Whether the activity can be safely repeated. */
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

  if ('description' in fn && typeof record['description'] === 'string') {
    result.description = record['description'];
  }
  if (
    'tags' in fn &&
    Array.isArray(record['tags']) &&
    record['tags'].every((tag) => typeof tag === 'string')
  ) {
    result.tags = [...record['tags']];
  }
  if ('inputSchema' in fn && isDefinitionSchema(record['inputSchema'])) {
    result.inputSchema = record['inputSchema'];
  }
  if ('outputSchema' in fn && isDefinitionSchema(record['outputSchema'])) {
    result.outputSchema = record['outputSchema'];
  }
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

export function copyActivityMetadata(metadata: ActivityMetadata): ActivityMetadata {
  return {
    name: metadata.name,
    queue: metadata.queue,
    ...(metadata.description === undefined ? {} : { description: metadata.description }),
    ...(metadata.tags === undefined ? {} : { tags: [...metadata.tags] }),
    ...(metadata.inputSchema === undefined ? {} : { inputSchema: metadata.inputSchema }),
    ...(metadata.outputSchema === undefined ? {} : { outputSchema: metadata.outputSchema }),
    ...(metadata.retry === undefined ? {} : { retry: copyRetryPolicy(metadata.retry) }),
    ...(metadata.timeout === undefined ? {} : { timeout: metadata.timeout }),
    ...(metadata.idempotent === undefined ? {} : { idempotent: metadata.idempotent }),
  };
}

function copyRetryPolicy(retry: RetryPolicy): RetryPolicy {
  return {
    ...retry,
    ...(retry.nonRetryableErrors === undefined
      ? {}
      : { nonRetryableErrors: [...retry.nonRetryableErrors] }),
  };
}

function validateDefinitionSchemaMetadata(value: unknown, fieldName: string): DefinitionSchema {
  if (isDefinitionSchema(value)) return value;
  throw new TypeError(`${fieldName} must be Standard Schema-compatible definition metadata.`);
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

  /** Per-name metadata used by deterministic catalog introspection. */
  #definitions: Map<string, ActivityMetadata>;

  /**
   * Name → function lookup. Holds strong references to registered functions,
   * keeping them (and their WeakMap metadata) alive until explicitly
   * unregistered.
   */
  #nameIndex: Map<string, object>;

  constructor() {
    this.#metadata = new WeakMap();
    this.#definitions = new Map();
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

    const description = options?.description ?? extracted.description;
    if (description !== undefined) metadata.description = description;

    const tags = options?.tags ?? extracted.tags;
    if (tags !== undefined) metadata.tags = [...tags];

    const inputSchema =
      options?.inputSchema === undefined
        ? extracted.inputSchema
        : validateDefinitionSchemaMetadata(
            options.inputSchema,
            `activity registration "${name}".inputSchema`,
          );
    if (inputSchema !== undefined) metadata.inputSchema = inputSchema;

    const outputSchema =
      options?.outputSchema === undefined
        ? extracted.outputSchema
        : validateDefinitionSchemaMetadata(
            options.outputSchema,
            `activity registration "${name}".outputSchema`,
          );
    if (outputSchema !== undefined) metadata.outputSchema = outputSchema;

    const retry = options?.retry ?? extracted.retry;
    if (retry !== undefined) metadata.retry = copyRetryPolicy(retry);

    const timeout = options?.timeout ?? extracted.timeout;
    if (timeout !== undefined) metadata.timeout = timeout;

    const idempotent = options?.idempotent ?? extracted.idempotent;
    if (idempotent !== undefined) metadata.idempotent = idempotent;

    this.#metadata.set(fn, metadata);
    this.#definitions.set(name, metadata);
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
    const metadata = this.#metadata.get(fn);
    return metadata === undefined ? undefined : copyActivityMetadata(metadata);
  }

  /** Get metadata by activity name. Resolves the function first, then looks up its metadata. */
  getMetadataByName(name: string): ActivityMetadata | undefined {
    return this.getDefinition(name);
  }

  /** Get catalog metadata for a registered activity name. */
  getDefinition(name: string): ActivityMetadata | undefined {
    const metadata = this.#definitions.get(name);
    return metadata === undefined ? undefined : copyActivityMetadata(metadata);
  }

  /** List catalog metadata for all registered activity names. */
  listDefinitions(): ActivityMetadata[] {
    return [...this.#nameIndex.keys()].flatMap((name) => {
      const metadata = this.getDefinition(name);
      return metadata === undefined ? [] : [metadata];
    });
  }

  /** Remove an activity registration by name. */
  unregister(name: string): void {
    const fn = this.#nameIndex.get(name);
    this.#nameIndex.delete(name);
    this.#definitions.delete(name);

    if (fn) {
      let replacementMetadata: ActivityMetadata | undefined;
      for (const [registeredName, registeredFn] of this.#nameIndex) {
        if (registeredFn === fn) {
          replacementMetadata = this.#definitions.get(registeredName);
        }
      }

      if (replacementMetadata === undefined) {
        this.#metadata.delete(fn);
      } else {
        this.#metadata.set(fn, replacementMetadata);
      }
    }
  }

  /** Iterate over all registered activity names. */
  *names(): IterableIterator<string> {
    yield* this.#nameIndex.keys();
  }
}
