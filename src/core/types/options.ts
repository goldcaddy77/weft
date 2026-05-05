import type { AlertingOptions } from '../../alerting/types.ts';
import type { Storage as WeftStorage } from '../../storage/interface.ts';
import type { CompressionAlgorithm, CompressionOptions } from '../compression.ts';
import type { Interceptor } from '../interceptor.ts';
import type { TenantResolver } from '../tenant.ts';
import type { WorkflowStatus } from './identity.ts';
import type { Duration, RetentionPolicy } from './retry-retention.ts';
import type { SearchAttributeHandle, SearchAttributeValue } from './search-attributes.ts';
import type { Serializer } from './serializer.ts';
import type { TenantQuotaOptions } from './tenants.ts';

// ---------------------------------------------------------------------------
// Start options for engine.start()
// ---------------------------------------------------------------------------

/**
 * Options accepted by `engine.start(type, input, options?)`.
 *
 * Every field is optional. `id` lets you specify your own workflow ID;
 * `idempotencyKey` enforces single-execution semantics within a window;
 * `executionTimeout` caps wall-clock time; `startAt`/`startAfter` defer
 * execution; `tags` and `searchAttributes` make the workflow discoverable
 * via filters.
 *
 * `HttpClient.start` does not yet forward `idempotencyKey` or
 * `searchAttributes` to the server (silent drop) — pass `LocalClient` for
 * full StartOptions support, or add the fields after start via `setAttributes`.
 *
 * @example Start a delayed workflow with tags and search attributes
 * ```ts
 * import { Engine, type StartOptions } from 'weft';
 *
 * const engine = new Engine();
 * engine.register('greet', async function* () {
 *   return 'hi';
 * });
 *
 * const options: StartOptions = {
 *   id: 'greeting-2026-04-29',
 *   startAfter: '5m',
 *   tags: ['nightly', 'ops'],
 *   searchAttributes: { customerId: 'acme' },
 * };
 * const handle = await engine.start('greet', null, options);
 * void handle;
 * ```
 */
export interface StartOptions {
  id?: string;
  idempotencyKey?: string;
  executionTimeout?: Duration;
  startAt?: number;
  startAfter?: Duration;
  tags?: string[];
  searchAttributes?: Record<string, SearchAttributeValue>;
}

/**
 * Options for {@link Engine.fork}. Controls which checkpoint step to fork
 * from; defaults to the latest persisted checkpoint when omitted.
 *
 * @example
 * ```ts
 * import { Engine, type ForkOptions } from 'weft';
 *
 * const engine = new Engine();
 * engine.register('process', async function* () { return 'done'; });
 *
 * const original = await engine.start('process', null);
 * await original.result();
 *
 * const options: ForkOptions = { fromStep: 2 };
 * const forked = await engine.fork(original.id, options);
 * void forked;
 * ```
 */
export interface ForkOptions {
  fromStep?: number;
}

// ---------------------------------------------------------------------------
// Engine configuration
// ---------------------------------------------------------------------------

/**
 * Configuration options for the {@link Engine} constructor.
 *
 * All fields are optional. Common overrides include `storage`, `retention`,
 * `development`, `serializer`, `compression`, `workerExecution`,
 * `alerts`, and `tenantResolver`/`quotas` for
 * multi-tenant deployments.
 *
 * @example
 * ```ts
 * import { Engine, type EngineOptions } from 'weft';
 *
 * const options: EngineOptions = {
 *   development: true,
 *   retention: { completed: '7d', failed: '30d' },
 *   checkpointSizeWarningThreshold: 128_000,
 * };
 *
 * const engine = new Engine(options);
 * void engine;
 * ```
 */
export interface EngineOptions {
  storage?: WeftStorage;
  development?: boolean;
  serializer?: Serializer;
  retention?: RetentionPolicy;
  retentionSweepInterval?: Duration;
  retentionSweepBatchSize?: number;
  /** Payload compression applied at the storage layer. */
  compression?: CompressionOptions & {
    /** Compression algorithm for agent workflow checkpoints. Default: 'brotli'. */
    agentAlgorithm?: CompressionAlgorithm;
    /** Compression threshold for agent workflow checkpoints. Default: same as main threshold. */
    agentThreshold?: number;
  };
  checkpointHistory?: number;
  checkpointSizeWarningThreshold?: number;
  maxNestingDepth?: number;
  /** Enable BroadcastChannel for cross-worker event coordination. Default: false. */
  broadcastEvents?: boolean;
  /**
   * Enable worker-based execution. When provided, workflows run in isolated
   * Web Workers instead of inline on the main thread. Activities are still
   * executed on the main thread via the activity registry (unless
   * `activityExecution` is also configured).
   */
  workerExecution?: {
    /** URL of the worker script (created via `createWorkerEntryUrl`). */
    workerUrl: string | URL;
    /** Maximum number of concurrent workers. Default: 4. */
    concurrency?: number;
    /** Use Bun's `smol` worker option for smaller memory footprint. */
    smol?: boolean;
  };

  /**
   * Enable worker-based activity execution. When provided, activity functions
   * run in isolated Web Workers instead of on the main thread. Activities must
   * be pre-registered in the worker via `createActivityWorkerEntryUrl`.
   */
  activityExecution?: {
    /** URL of the activity worker script (created via `createActivityWorkerEntryUrl`). */
    workerUrl: string | URL;
    /** Maximum number of concurrent activity workers. Default: 4. */
    poolSize?: number;
    /** Use Bun's `smol` worker option for smaller memory footprint. */
    smol?: boolean;
  };

  /**
   * When providers expose async resume hints, park inline `ctx.agent()` turns
   * before the blocking LLM call begins. Non-parkable contexts fall back to an
   * in-memory wait. Off by default because only some providers can participate
   * in asynchronous resume flows.
   */
  suspendOnLlmWait?: boolean;

  /** Built-in alerting configuration. */
  alerts?: AlertingOptions;

  /**
   * Unified interceptors registered at construction. This is equivalent to
   * calling `addInterceptor` for each entry; each interceptor participates in
   * the workflow and/or activity pipeline based on which hooks it implements.
   * The engine takes a defensive copy at construction — mutating this array
   * after passing it has no effect.
   */
  interceptors?: readonly Interceptor[];

  /**
   * Optional {@link TenantResolver} that populates `ctx.tenant` for every new
   * workflow. When set, the engine calls `resolver.resolve(workflowId, input)`
   * once at `start()` time and persists the returned context on the workflow
   * state so it survives recovery. Leave unset for single-tenant deployments.
   */
  tenantResolver?: TenantResolver;
  /**
   * Optional per-tenant admission control limits enforced when a workflow is
   * created for a resolved tenant.
   */
  quotas?: TenantQuotaOptions;
}

// ---------------------------------------------------------------------------
// List/filter options
// ---------------------------------------------------------------------------

/**
 * Filter criteria for {@link Engine.list}. All fields are optional and
 * combine with AND semantics. `status` accepts a single value or an array;
 * `attributes` is a list of attribute predicates evaluated on indexed search
 * attributes. Pairs with `limit`/`offset` for pagination.
 *
 * @example
 * ```ts
 * import { Engine, type ListFilter } from 'weft';
 *
 * const engine = new Engine();
 * const filter: ListFilter = {
 *   status: ['running', 'pending'],
 *   tags: ['nightly'],
 *   attributes: [{ key: 'customerId', value: 'acme' }],
 *   limit: 20,
 *   offset: 0,
 * };
 * const result = await engine.list(filter);
 * console.log(result.items.length);
 * ```
 */
export interface ListFilter {
  status?: WorkflowStatus | WorkflowStatus[];
  type?: string;
  tags?: string[];
  attributes?: AttributeFilter[];
  limit?: number;
  offset?: number;
}

export interface AttributeFilter {
  key: string | SearchAttributeHandle;
  value?: SearchAttributeValue;
  gt?: SearchAttributeValue;
  lt?: SearchAttributeValue;
  gte?: SearchAttributeValue;
  lte?: SearchAttributeValue;
}

// ---------------------------------------------------------------------------
// Paginated result
// ---------------------------------------------------------------------------

/**
 * Generic paginated response envelope returned by list operations such as
 * {@link Engine.list} and `engine.listSchedules`. `total` is the full count
 * matching the filter; `items` is the current page slice. `items.length` is
 * bounded by `limit`; the consumer reaches the end of the result set when
 * `offset + items.length >= total`.
 */
export interface PaginatedResult<T> {
  items: T[];
  total: number;
  offset: number;
  limit: number;
}
