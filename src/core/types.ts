import type { ModelRouter } from '../ai/model-router.ts';
import type { AlertingOptions } from '../alerting/types.ts';
import type { Storage as WeftStorage } from '../storage/interface.ts';
import type { CompressionAlgorithm, CompressionOptions } from './compression.ts';
import type { ConstraintDefinition } from './constraint.ts';
import type { WorkflowVersionTuple } from './workflow-version-tuple.ts';

// ---------------------------------------------------------------------------
// Workflow identity
// ---------------------------------------------------------------------------

/**
 * Opaque string identifier for a workflow instance. Generated automatically
 * by the engine at start time, or supplied via {@link StartOptions.id}. Pass
 * to {@link Engine.getHandle} or {@link Engine.get} to look up a running or
 * completed workflow.
 *
 * @example
 * ```ts
 * import { Engine, type WorkflowId } from 'weft';
 *
 * const engine = new Engine();
 * engine.register('ping', async function* () { return 'pong'; });
 *
 * const handle = await engine.start('ping', null);
 * const id: WorkflowId = handle.id;
 * const state = await engine.get(id);
 * console.log(state?.status); // 'completed'
 * ```
 */
export type WorkflowId = string;
export type OperationId = string;

// ---------------------------------------------------------------------------
// Failure category — populated on all failed workflows
// ---------------------------------------------------------------------------

/**
 * Classifies why a workflow failed. Populated automatically by the engine on
 * failure so operators can query e.g. "all planning failures in the last hour"
 * via `engine.list({ attributes: [{ key: 'failureCategory', value: 'planning' }] })`.
 *
 * - `'memory'`    — context window exceeded (LLM / agent)
 * - `'reflection'` — reserved for future use (complex to detect automatically)
 * - `'planning'`  — LLM produced an invalid tool call or schema violation
 * - `'action'`    — an agent tool execution threw
 * - `'system'`    — any other failure (default for non-agent errors, storage errors, etc.)
 *
 * @example
 * ```ts
 * import { Engine, type FailureCategory } from 'weft';
 *
 * const engine = new Engine();
 * // Query all workflows that failed due to a planning error:
 * const results = await engine.list({
 *   status: 'failed',
 *   attributes: [{ key: 'failureCategory', value: 'planning' as FailureCategory }],
 * });
 * void results;
 * ```
 */
export type FailureCategory = 'memory' | 'reflection' | 'planning' | 'action' | 'system';

// ---------------------------------------------------------------------------
// Workflow status state machine
// ---------------------------------------------------------------------------

/**
 * Lifecycle states a workflow moves through, from registration to terminal
 * state.
 *
 * Read this off `(await handle.state()).status` to learn whether a workflow
 * is still running, finished cleanly, or failed. Pass it to `engine.list()`
 * filters to scope queries by status.
 */
export type WorkflowStatus =
  | 'pending'
  | 'running'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'timed-out';

// ---------------------------------------------------------------------------
// Workflow state persisted in storage
// ---------------------------------------------------------------------------

/**
 * Snapshot of a workflow's persisted state.
 *
 * Returned by `handle.state()` and `engine.get(workflowId)`. Users observe
 * this shape — they don't construct it. Includes the input, current status,
 * tenant, attributes, retention policy snapshot, and lineage information.
 */
export interface WorkflowState {
  id: WorkflowId;
  type: string;
  status: WorkflowStatus;
  tags?: string[];
  input: unknown;
  result?: unknown;
  error?: string;
  errorStack?: string;
  /**
   * Classifies why this workflow failed. Populated automatically on failure;
   * absent (`undefined`) on workflows that have not failed. `null` indicates
   * a failure occurred but the category could not be determined.
   *
   * Also indexed as a search attribute so callers can query via:
   * `engine.list({ attributes: [{ key: 'failureCategory', value: 'planning' }] })`
   */
  failureCategory?: FailureCategory | null;
  version: string;
  /**
   * Semantic version of the agent definition at the time this workflow was
   * started. Populated when the workflow was registered via an
   * {@link AgentDefinition}; absent for plain workflow functions.
   */
  agentVersion?: string;
  /**
   * Sorted `"${name}@${version}"` tool version strings captured from the
   * effective tool list at workflow start. Populated when the workflow was
   * registered via an {@link AgentDefinition} with tools; absent otherwise.
   */
  toolVersions?: string[];
  createdAt: number;
  startedAt?: number;
  updatedAt: number;
  terminalCleanupToken?: string;
  executionDeadline?: number;
  /**
   * Optional {@link TenantContext} resolved at start time by the engine's
   * `tenantResolver`. Persisted here so it survives workflow recovery — the
   * field is only present on workflows started while a resolver was
   * configured and the resolver returned a value.
   */
  tenant?: import('./tenant.ts').TenantContext;
  /**
   * Lineage metadata recorded when this workflow was created by a fork from
   * another workflow checkpoint. Absent for workflows started normally.
   */
  forkedFrom?: ForkLineage;
}

/**
 * Lineage metadata recorded when a workflow was created by forking another
 * workflow at a checkpoint boundary. Absent on workflows started normally via
 * {@link Engine.start}. Available on {@link WorkflowState.forkedFrom}.
 */
export interface ForkLineage {
  workflowId: WorkflowId;
  step: number;
}

// ---------------------------------------------------------------------------
// Duration: number (milliseconds) or human-readable string
// ---------------------------------------------------------------------------

/**
 * A length of time accepted across the engine API.
 *
 * Either a number of milliseconds (`5000`) or a human-readable string
 * (`'30s'`, `'5m'`, `'2h'`, `'1d'`). Supplies values for {@link RetryPolicy},
 * `ctx.sleep()`, retention windows, schedule timing, and timeouts.
 *
 * @example Use a Duration in a retry policy
 * ```ts
 * import type { Duration, RetryPolicy } from 'weft';
 *
 * const initialBackoff: Duration = '500ms';
 * const maxBackoff: Duration = '30s';
 *
 * const retry: RetryPolicy = {
 *   maxAttempts: 5,
 *   initialBackoff,
 *   backoffMultiplier: 2,
 *   maxBackoff,
 * };
 * void retry;
 * ```
 */
export type Duration = number | string;

// ---------------------------------------------------------------------------
// Workflow retention
// ---------------------------------------------------------------------------

/**
 * How long the engine retains workflows in each terminal state before the
 * retention sweep deletes them. All fields are optional {@link Duration}
 * values (milliseconds or strings like `'7d'`). Pass via
 * {@link EngineOptions.retention} for engine-wide defaults, or per-workflow
 * in {@link WorkflowRegistration.retention}.
 *
 * @example
 * ```ts
 * import { Engine, type RetentionPolicy } from 'weft';
 *
 * const retention: RetentionPolicy = {
 *   completed: '7d',
 *   failed: '30d',
 *   cancelled: '3d',
 * };
 * const engine = new Engine({ retention });
 * void engine;
 * ```
 */
export interface RetentionPolicy {
  completed?: Duration;
  failed?: Duration;
  cancelled?: Duration;
  timedOut?: Duration;
}

/**
 * Retention policy after {@link Duration} values have been normalised to
 * milliseconds. Used internally by the engine's retention sweep; callers
 * configure retention via {@link RetentionPolicy} which accepts human-readable
 * strings like `'7d'`.
 */
export interface NormalizedRetentionPolicy {
  completed?: number;
  failed?: number;
  cancelled?: number;
  timedOut?: number;
}

// ---------------------------------------------------------------------------
// Checkpoint: snapshot of workflow at a yield* boundary
// ---------------------------------------------------------------------------

/**
 * Durable snapshot of a workflow's execution state persisted at each
 * `yield` boundary. Contains the accumulated operation results, local
 * variables, pending signals, search attributes, and the step counter.
 * Users don't construct checkpoints directly; the engine manages them.
 * Available via time-travel APIs and {@link WorkflowReplay}.
 *
 * @example
 * ```ts
 * import { Engine, type Checkpoint } from 'weft';
 *
 * const engine = new Engine({ checkpointHistory: 5 });
 * engine.register('counter', async function* () { return 42; });
 * const handle = await engine.start('counter', null);
 * await handle.result();
 * // Checkpoints are persisted by the engine; retrieve via engine.getCheckpoint()
 * const _engine: typeof engine = engine;
 * void _engine;
 * ```
 */
export interface Checkpoint {
  workflowId: WorkflowId;
  step: number;
  locals: Record<string, unknown>;
  accumulatedResults: Array<[number, unknown]>;
  pendingSignals: string[];
  searchAttributes: Record<string, SearchAttributeValue>;
  version: string;
  createdAt: number;
}

// ---------------------------------------------------------------------------
// Checkpoint history: time-travel debugging
// ---------------------------------------------------------------------------

/** Summary metadata for a single checkpoint history entry. */
export type CheckpointSummary = {
  step: number;
  timestamp: number;
  sizeBytes: number;
};

/** Full deserialized state at a specific checkpoint step. */
export type CheckpointState = Pick<
  Checkpoint,
  'step' | 'locals' | 'searchAttributes' | 'version' | 'createdAt'
>;

/**
 * Status of an individual entry in the workflow execution timeline. Mirrors
 * {@link WorkflowStatus} but scoped to a single timeline step rather than the
 * whole workflow. Used in {@link WorkflowTimelineEntry}.
 */
export type WorkflowTimelineStatus = 'running' | 'completed' | 'failed' | 'cancelled' | 'timed-out';

/**
 * A single chronological entry in a workflow's execution timeline, summarising
 * one operation (activity call, sleep, signal wait, etc.). Returned by
 * `engine.getTimeline(workflowId)` for replay and debugging.
 */
export type WorkflowTimelineEntry = {
  step: number;
  operationType: string;
  operationLabel: string;
  inputSummary: string;
  outputSummary?: string;
  duration?: number;
  timestamp: number;
  status: WorkflowTimelineStatus;
  versionTuple?: WorkflowVersionTuple;
};

// ---------------------------------------------------------------------------
// Retry policy for activities
// ---------------------------------------------------------------------------

/**
 * Exponential-backoff retry policy for activities.
 *
 * Pass on `ActivityDefinition.retry` (set per-activity) or via the engine
 * default policy. Backoff between attempts grows by `backoffMultiplier` and
 * caps at `maxBackoff`. Errors whose `name` (or message) matches an entry in
 * `nonRetryableErrors` skip the retry loop and fail fast.
 *
 * @example Configure a retry policy on an activity
 * ```ts
 * import { activity, type RetryPolicy } from 'weft';
 *
 * const retry: RetryPolicy = {
 *   maxAttempts: 5,
 *   initialBackoff: '500ms',
 *   backoffMultiplier: 2,
 *   maxBackoff: '30s',
 *   nonRetryableErrors: ['ValidationError'],
 * };
 *
 * const fetchUser = activity({
 *   name: 'fetchUser',
 *   retry,
 *   execute: async (input: unknown) => {
 *     return { id: input as string };
 *   },
 * });
 * void fetchUser;
 * ```
 */
export interface RetryPolicy {
  maxAttempts: number;
  initialBackoff: Duration;
  backoffMultiplier: number;
  maxBackoff: Duration;
  nonRetryableErrors?: string[];
}

// ---------------------------------------------------------------------------
// Operation types
// ---------------------------------------------------------------------------

export type OperationKind = 'activity' | 'timer' | 'signal-wait' | 'child-workflow';

export interface OperationRequest {
  id: OperationId;
  workflowId: WorkflowId;
  kind: OperationKind;
  queue: string;
  activityName?: string;
  input?: unknown;
  attempt: number;
  retryPolicy: RetryPolicy;
  scheduledAt: number;
  timeout?: Duration;
  idempotencyKey?: string;
  /** Visibility timeout in milliseconds. Defaults to 30 000. */
  visibilityTimeout?: number;
}

export type OperationOutcome =
  | { status: 'completed'; value: unknown }
  | { status: 'failed'; error: string };

// ---------------------------------------------------------------------------
// Search attributes
// ---------------------------------------------------------------------------

/**
 * Union of scalar types accepted as search attribute values. Pass when calling
 * `engine.setAttributes` or in {@link StartOptions.searchAttributes}. The
 * engine indexes values of these types so callers can filter via
 * `engine.list({ attributes: [...] })`.
 *
 * @example
 * ```ts
 * import { Engine, type SearchAttributeValue } from 'weft';
 *
 * const engine = new Engine();
 * engine.register('order', async function* () { return 'shipped'; });
 * const handle = await engine.start('order', null, {
 *   searchAttributes: { region: 'us-east' as SearchAttributeValue },
 * });
 * void handle;
 * ```
 */
export type SearchAttributeValue = string | number | boolean | Date | string[];

export interface SearchAttributeDefinition {
  type: 'string' | 'number' | 'boolean' | 'datetime' | 'keyword_list';
}

/**
 * Registry of named search attribute definitions for a workflow type. Each key
 * is an attribute name; each value is a `SearchAttributeDefinition` describing
 * the expected type. Pass via {@link WorkflowRegistration.searchAttributes} so
 * the engine validates and indexes attributes at runtime.
 *
 * @example
 * ```ts
 * import { Engine, type SearchAttributeSchema } from 'weft';
 *
 * const schema: SearchAttributeSchema = {
 *   customerId: { type: 'string' },
 *   orderValue:  { type: 'number' },
 *   isPriority:  { type: 'boolean' },
 * };
 * const engine = new Engine();
 * engine.register('order', { handler: async function* () { return 'ok'; }, searchAttributes: schema });
 * void engine;
 * ```
 */
export type SearchAttributeSchema = Record<string, SearchAttributeDefinition>;

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
// Serializer interface (pluggable serialization)
// ---------------------------------------------------------------------------

/**
 * Pluggable serialization interface for workflow checkpoints and activity
 * payloads. Implement this to substitute MessagePack with a custom codec
 * (e.g. CBOR, Protobuf, JSON). Pass an instance to {@link EngineOptions.serializer}.
 *
 * @example
 * ```ts
 * import { Engine, type Serializer } from 'weft';
 *
 * const jsonSerializer: Serializer = {
 *   serialize(value) {
 *     return new TextEncoder().encode(JSON.stringify(value));
 *   },
 *   deserialize(bytes) {
 *     return JSON.parse(new TextDecoder().decode(bytes)) as unknown;
 *   },
 * };
 *
 * const engine = new Engine({ serializer: jsonSerializer });
 * void engine;
 * ```
 */
export interface Serializer {
  serialize(value: unknown): Uint8Array;
  deserialize(bytes: Uint8Array): unknown;
}

// ---------------------------------------------------------------------------
// Engine configuration
// ---------------------------------------------------------------------------

/**
 * Configuration options for the {@link Engine} constructor.
 *
 * All fields are optional. The most common overrides are `storage` (swap
 * in-memory for a durable backend), `retention` (auto-delete old workflows),
 * and `development` (enable extra runtime warnings). For multi-tenant
 * deployments combine `tenantResolver` with `quotas`.
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
   * Default model router applied to all `ctx.agent()` calls that don't
   * provide their own `modelRouter`. Per-call routers override this.
   */
  defaultModelRouter?: ModelRouter | undefined;

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
   * Optional {@link TenantResolver} that populates `ctx.tenant` for every new
   * workflow. When set, the engine calls `resolver.resolve(workflowId, input)`
   * once at `start()` time and persists the returned context on the workflow
   * state so it survives recovery. Leave unset for single-tenant deployments.
   */
  tenantResolver?: import('./tenant.ts').TenantResolver;
  /**
   * Optional per-tenant admission control limits enforced when a workflow is
   * created for a resolved tenant.
   */
  quotas?: TenantQuotaOptions;
}

// ---------------------------------------------------------------------------
// Activity function type
// ---------------------------------------------------------------------------

/**
 * Type signature for an activity execute function. Receives the activity
 * input and an optional {@link ActivityContext} (for heartbeating and
 * cancellation signals), and returns a value or a promise. Use this type
 * when defining the `execute` field of an {@link ActivityDefinition}.
 *
 * @example
 * ```ts
 * import type { ActivityFunction } from 'weft';
 *
 * const fetchUserFn: ActivityFunction<string, { id: string; name: string }> =
 *   async (input, ctx) => {
 *     ctx?.signal.throwIfAborted();
 *     const response = await fetch(`https://api.example.com/users/${input}`);
 *     return (await response.json()) as { id: string; name: string };
 *   };
 * void fetchUserFn;
 * ```
 */
export type ActivityFunction<TInput = unknown, TOutput = unknown> = (
  input: TInput,
  context?: ActivityContext,
) => Promise<TOutput> | TOutput;

// ---------------------------------------------------------------------------
// Activity context passed to activity functions
// ---------------------------------------------------------------------------

/**
 * Runtime context injected as the second argument of every activity execute
 * function. Use `signal` to honour cancellation, and call `heartbeat` to
 * report progress and extend the activity's visibility timeout on long-running
 * work.
 *
 * @example
 * ```ts
 * import { activity, type ActivityContext } from 'weft';
 *
 * const processChunks = activity({
 *   name: 'processChunks',
 *   execute: async (input: unknown, ctx?: ActivityContext) => {
 *     const items = input as string[];
 *     for (const item of items) {
 *       ctx?.signal.throwIfAborted();
 *       ctx?.heartbeat({ processed: item });
 *     }
 *     return items.length;
 *   },
 * });
 * void processChunks;
 * ```
 */
export interface ActivityContext {
  signal: AbortSignal;
  heartbeat(details?: unknown): void;
}

// ---------------------------------------------------------------------------
// Per-invocation activity options
// ---------------------------------------------------------------------------

/**
 * Per-invocation overrides when calling an activity from a workflow via
 * `(ctx as Context).run(activity, input, options)`. Any field overrides the
 * activity's own defaults for that single call. Useful for increasing the
 * timeout on a retried call or routing to a specific queue.
 *
 * @example
 * ```ts
 * import { activity, Engine, type ActivityCallOptions } from 'weft';
 * import type { Context, WorkflowContext } from 'weft';
 *
 * const slowTask = activity({ name: 'slowTask', execute: async (i: unknown) => i });
 * const engine = new Engine();
 *
 * engine.register('example', async function* (ctx: WorkflowContext, input: unknown) {
 *   const options: ActivityCallOptions = { timeout: '5m', queue: 'heavy' };
 *   const result = yield* (ctx as Context).run(slowTask, input, options);
 *   return result;
 * });
 * void engine;
 * ```
 */
export interface ActivityCallOptions {
  timeout?: Duration;
  queue?: string;
  retry?: Partial<RetryPolicy>;
  idempotencyKey?: string;
  sticky?: boolean;
  /** Override the default visibility timeout for this invocation. */
  visibilityTimeout?: Duration;
}

// ---------------------------------------------------------------------------
// Activity metadata (from activity() helper)
// ---------------------------------------------------------------------------

/**
 * Full metadata for an activity, combining the execute function with optional
 * retry policy, timeout, queue routing, compensation, and idempotency. Built
 * by the {@link activity} helper which returns a value that satisfies both
 * `ActivityDefinition` and the callable function interface.
 *
 * @example
 * ```ts
 * import { activity, type ActivityDefinition } from 'weft';
 *
 * const sendEmail: ActivityDefinition<{ to: string; body: string }, void> = activity({
 *   name: 'sendEmail',
 *   timeout: '30s',
 *   retry: { maxAttempts: 3, initialBackoff: '1s', backoffMultiplier: 2, maxBackoff: '10s' },
 *   execute: async (input: unknown) => {
 *     const { to, body } = input as { to: string; body: string };
 *     console.log(`Sending to ${to}: ${body}`);
 *   },
 * });
 * void sendEmail;
 * ```
 */
export interface ActivityDefinition<TInput = unknown, TOutput = unknown> {
  name: string;
  execute: ActivityFunction<TInput, TOutput>;
  /**
   * Optional post-execution verifier.
   *
   * Return `true` to confirm the activity result, or `false` to reject it.
   * Throwing is treated the same as a failed verification.
   */
  verify?: (result: TOutput) => Promise<boolean> | boolean;
  retry?: RetryPolicy;
  timeout?: Duration;
  queue?: string;
  idempotent?: boolean;
  /** Visibility timeout for this activity. Defaults to 30 seconds. */
  visibilityTimeout?: Duration;
  /**
   * Optional compensation function. When defined and a saga step that ran this
   * activity needs to be rolled back, the engine calls `compensate(input, output)`
   * in reverse order for every step that completed before the failure.
   *
   * `input` is the original input passed to `execute`.
   * `output` is the value returned by `execute` for that invocation.
   */
  compensate?: (input: TInput, output: TOutput) => Promise<void> | void;
  /**
   * Optional function that returns a resource scope string for this activity.
   * Used for resource-level locking or throttling; the returned string is
   * treated as an opaque identifier by the engine.
   */
  resourceScope?: (input: TInput) => string;
  /**
   * Optional function that returns an idempotency key specific to an
   * invocation. Takes precedence over `ActivityCallOptions.idempotencyKey`.
   */
  idempotencyKey?: (input: TInput) => string;
}

// ---------------------------------------------------------------------------
// Timer entry for scheduler
// ---------------------------------------------------------------------------

export interface TimerEntry {
  id: string;
  workflowId: WorkflowId;
  fireAt: number;
  kind:
    | 'sleep'
    | 'visibility-timeout'
    | 'execution-deadline'
    | 'delayed-start'
    | 'schedule'
    | 'terminal-cleanup';
  executionTimeoutMs?: number;
}

// ---------------------------------------------------------------------------
// Worker message protocol (postMessage between main thread and Web Workers)
// ---------------------------------------------------------------------------

export type WorkerInboundMessage =
  | {
      type: 'run';
      workflowId: WorkflowId;
      workflowType: string;
      checkpoint: ArrayBuffer;
      input: unknown;
      deadline?: number;
      headers?: [string, string][];
      /**
       * Resolved tenant context for this workflow run, forwarded across the
       * `postMessage` boundary. The `attributes` values MUST be
       * structured-clone safe — functions, class instances, and DOM nodes
       * will crash the transfer with `DataCloneError`. Stick to plain
       * objects, arrays, strings, numbers, booleans, and null.
       */
      tenant?: import('./tenant.ts').TenantContext;
    }
  | {
      type: 'resume';
      workflowId: WorkflowId;
      checkpoint: ArrayBuffer;
      operationResult: OperationOutcome;
    }
  | { type: 'cancel'; workflowId: WorkflowId };

export type WorkerOutboundMessage =
  | {
      type: 'checkpoint';
      workflowId: WorkflowId;
      checkpoint: ArrayBuffer;
      operationRequest: OperationRequest;
    }
  | { type: 'completed'; workflowId: WorkflowId; result: unknown }
  | {
      type: 'failed';
      workflowId: WorkflowId;
      error: string;
      errorStack?: string;
      /** Populated when the inline strategy can classify the failure cause. */
      failureCategory?: FailureCategory;
    };

// ---------------------------------------------------------------------------
// Workflow function signature
// ---------------------------------------------------------------------------

/**
 * Signature of a durable workflow generator function registered via
 * {@link Engine.register}. The engine calls it with a {@link WorkflowContext}
 * and the start `input`, then drives the generator by feeding operation
 * results back via `next`. Cast `ctx` to the concrete {@link Context} class
 * to access `run`, `sleep`, `agent`, and other execution primitives.
 *
 * @example
 * ```ts
 * import { activity, Engine, type WorkflowFunction } from 'weft';
 * import type { Context, WorkflowContext } from 'weft';
 *
 * const greet = activity({ name: 'greet', execute: async (i: unknown) => `hello ${i}` });
 *
 * const myWorkflow: WorkflowFunction =
 *   async function* (ctx: WorkflowContext, input: unknown) {
 *     return yield* (ctx as Context).run(greet, input);
 *   };
 *
 * const engine = new Engine();
 * engine.register('myWorkflow', myWorkflow);
 * void engine;
 * ```
 */
export type WorkflowFunction<TInput = unknown, TOutput = unknown> = (
  context: WorkflowContext,
  input: TInput,
) => AsyncGenerator<unknown, TOutput, unknown>;

// ---------------------------------------------------------------------------
// Step-based workflow types (progressive disclosure API)
// ---------------------------------------------------------------------------

/**
 * Simplified context for step-based ("progressive disclosure") workflows.
 * Instead of yielding operations via a generator, write a plain `async`
 * function and call `ctx.step(name, fn)` for each durable step. Compile the
 * function to a generator via {@link compileStepWorkflow}.
 *
 * @example
 * ```ts
 * import { Engine, compileStepWorkflow, type StepWorkflowContext } from 'weft';
 *
 * async function myStepWorkflow(ctx: StepWorkflowContext, input: unknown) {
 *   const result = await ctx.step('fetchData', async () => {
 *     return { data: input };
 *   });
 *   return result;
 * }
 *
 * const engine = new Engine();
 * engine.register('stepWorkflow', compileStepWorkflow(myStepWorkflow));
 * void engine;
 * ```
 */
export interface StepWorkflowContext {
  readonly workflowId: string;
  readonly signal: AbortSignal;
  step<T>(name: string, fn: () => Promise<T> | T): Promise<T>;
}

/**
 * Type alias for a plain async function that uses {@link StepWorkflowContext}
 * instead of a generator. Use with {@link compileStepWorkflow} to register
 * it on the engine. This is the "progressive disclosure" API for users who
 * prefer async/await over generator syntax.
 *
 * @example
 * ```ts
 * import { Engine, compileStepWorkflow, type StepWorkflowFunction } from 'weft';
 *
 * const process: StepWorkflowFunction = async (ctx, input) => {
 *   return ctx.step('transform', () => (input as string).toUpperCase());
 * };
 *
 * const engine = new Engine();
 * engine.register('process', compileStepWorkflow(process));
 * void engine;
 * ```
 */
export type StepWorkflowFunction<TInput = unknown, TOutput = unknown> = (
  context: StepWorkflowContext,
  input: TInput,
) => Promise<TOutput>;

/**
 * The generator type returned by operations on {@link WorkflowContext} such as
 * `ctx.pipe()`, `ctx.map()`, and `ctx.reduce()`. Use `yield*` to consume it
 * inside a workflow generator function; the result type is `TResult`.
 *
 * @example
 * ```ts
 * import { Engine, type WorkflowOperation, type WorkflowContext } from 'weft';
 * import type { Context } from 'weft';
 *
 * const engine = new Engine();
 * engine.register('parent', async function* (ctx: WorkflowContext, input: unknown) {
 *   const items = input as string[];
 *   const op: WorkflowOperation<string[]> = ctx.map(items, 'child');
 *   return yield* op;
 * });
 * engine.register('child', async function* (_ctx: WorkflowContext, s: unknown) {
 *   return String(s).toUpperCase();
 * });
 * void engine;
 * ```
 */
export type WorkflowOperation<TResult> = Generator<unknown, TResult, unknown>;

/**
 * Typed per-workflow session state slot returned by `ctx.sessionState(key)`.
 * Survives checkpoint recovery but is scoped to the current workflow instance.
 * Use `get` to read the current value, `set` or `update` to write, and `run`
 * to execute a function with access to the stored value as a generator operation.
 */
export interface WorkflowSessionState<T> {
  get(): T | undefined;
  set(value: T): T;
  update(updater: (current: T | undefined) => T): T;
  clear(): void;
  run<TResult>(
    fn: (...args: unknown[]) => Promise<TResult> | TResult,
    ...rest: unknown[]
  ): WorkflowOperation<TResult>;
}

/**
 * Accepted forms for specifying a child workflow in composition operators
 * (`ctx.pipe`, `ctx.map`, `ctx.reduce`): a registered workflow name string,
 * a {@link WorkflowFunction} reference, or a {@link StepWorkflowFunction}
 * reference. The engine resolves the actual workflow type at runtime.
 *
 * @example
 * ```ts
 * import { Engine, type ChildWorkflowTarget, type WorkflowContext } from 'weft';
 * import type { Context } from 'weft';
 *
 * const engine = new Engine();
 * engine.register('transform', async function* (_ctx: WorkflowContext, input: unknown) {
 *   return String(input).toUpperCase();
 * });
 *
 * const target: ChildWorkflowTarget<unknown, string> = 'transform';
 * engine.register('parent', async function* (ctx: WorkflowContext, input: unknown) {
 *   return yield* (ctx as Context).map([input], target);
 * });
 * void engine;
 * ```
 */
export type ChildWorkflowTarget<TInput = unknown, TOutput = unknown> =
  | string
  | WorkflowFunction<TInput, TOutput>
  | StepWorkflowFunction<TInput, TOutput>;

/**
 * Options passed to child workflow invocations within `ctx.pipe`, `ctx.map`,
 * or `ctx.reduce`. Currently accepts an optional `id` to control the child
 * workflow ID; additional fields are passed through as-is for future extension.
 */
export type ChildWorkflowOptions = Record<string, unknown> & {
  id?: string;
};

/**
 * A single stage in a `ctx.pipe(stages, input)` composition chain. Pairs a
 * {@link ChildWorkflowTarget} with optional {@link ChildWorkflowOptions} such
 * as a custom child workflow ID. Use the object form when you need to pass
 * per-stage options; otherwise a bare {@link ChildWorkflowTarget} also works.
 *
 * @example
 * ```ts
 * import { Engine, type WorkflowPipeStage, type WorkflowContext } from 'weft';
 * import type { Context } from 'weft';
 *
 * const engine = new Engine();
 * engine.register('step1', async function* (_ctx: WorkflowContext, i: unknown) { return String(i); });
 * engine.register('step2', async function* (_ctx: WorkflowContext, i: unknown) { return (i as string).trim(); });
 *
 * engine.register('pipeline', async function* (ctx: WorkflowContext, input: unknown) {
 *   const stages: [WorkflowPipeStage, WorkflowPipeStage] = [
 *     { type: 'step1' },
 *     { type: 'step2', options: { id: 'trim-step' } },
 *   ];
 *   return yield* ctx.pipe(stages, input);
 * });
 * void engine;
 * ```
 */
export interface WorkflowPipeStage<TInput = unknown, TOutput = unknown> {
  type: ChildWorkflowTarget<TInput, TOutput>;
  options?: ChildWorkflowOptions;
}

/**
 * Union of the two accepted formats for each stage passed to `ctx.pipe`:
 * either a full {@link WorkflowPipeStage} object with a `type` and optional
 * `options`, or a bare {@link ChildWorkflowTarget} (a string name or function
 * reference). The engine normalises both forms before executing.
 *
 * @example
 * ```ts
 * import { Engine, type WorkflowPipeStageDefinition, type WorkflowContext } from 'weft';
 * import type { Context } from 'weft';
 *
 * const engine = new Engine();
 * engine.register('upper', async function* (_ctx: WorkflowContext, i: unknown) {
 *   return String(i).toUpperCase();
 * });
 * engine.register('trim', async function* (_ctx: WorkflowContext, i: unknown) {
 *   return String(i).trim();
 * });
 *
 * const stages: [WorkflowPipeStageDefinition, WorkflowPipeStageDefinition] = ['upper', 'trim'];
 * engine.register('pipeline', async function* (ctx: WorkflowContext, input: unknown) {
 *   return yield* ctx.pipe(stages, input);
 * });
 * void engine;
 * ```
 */
export type WorkflowPipeStageDefinition<TInput = unknown, TOutput = unknown> =
  | WorkflowPipeStage<TInput, TOutput>
  | ChildWorkflowTarget<TInput, TOutput>;

/**
 * Options for `ctx.map(items, workflowType, options)`. Controls the maximum
 * number of child workflows that run simultaneously. Defaults to running all
 * items in parallel when `concurrency` is not set.
 *
 * @example
 * ```ts
 * import { Engine, type WorkflowMapOptions, type WorkflowContext } from 'weft';
 * import type { Context } from 'weft';
 *
 * const engine = new Engine();
 * engine.register('processItem', async function* (_ctx: WorkflowContext, item: unknown) {
 *   return String(item).toUpperCase();
 * });
 * engine.register('batchProcess', async function* (ctx: WorkflowContext, input: unknown) {
 *   const items = input as string[];
 *   const options: WorkflowMapOptions = { concurrency: 3 };
 *   return yield* (ctx as Context).map(items, 'processItem', options);
 * });
 * void engine;
 * ```
 */
export interface WorkflowMapOptions {
  concurrency?: number;
}

/**
 * Input shape passed to each child workflow invocation within `ctx.reduce`.
 * Contains the running `accumulator`, the current `item`, and its zero-based
 * `index`. The child workflow's return value becomes the next accumulator.
 *
 * @example
 * ```ts
 * import { Engine, type WorkflowReduceInput, type WorkflowContext } from 'weft';
 * import type { Context } from 'weft';
 *
 * const engine = new Engine();
 * engine.register('sumStep', async function* (_ctx: WorkflowContext, input: unknown) {
 *   const { accumulator, item } = input as WorkflowReduceInput<number, number>;
 *   return accumulator + item;
 * });
 *
 * engine.register('sumAll', async function* (ctx: WorkflowContext, input: unknown) {
 *   const items = input as number[];
 *   return yield* (ctx as Context).reduce(items, 'sumStep', 0);
 * });
 * void engine;
 * ```
 */
export interface WorkflowReduceInput<TAccumulator, TItem> {
  accumulator: TAccumulator;
  item: TItem;
  index: number;
}

/**
 * Options for `ctx.reduce(items, workflowType, initialValue, options)`.
 * Supply `idPrefix` to give each generated child workflow ID a deterministic
 * prefix, which helps with idempotency and debugging.
 *
 * @example
 * ```ts
 * import { Engine, type WorkflowReduceOptions, type WorkflowContext } from 'weft';
 * import type { Context } from 'weft';
 *
 * const engine = new Engine();
 * engine.register('merge', async function* (_ctx: WorkflowContext, input: unknown) {
 *   const { accumulator, item } = input as { accumulator: string[]; item: string };
 *   return [...accumulator, item];
 * });
 * engine.register('collect', async function* (ctx: WorkflowContext, input: unknown) {
 *   const items = input as string[];
 *   const opts: WorkflowReduceOptions = { idPrefix: 'collect-merge' };
 *   return yield* (ctx as Context).reduce(items, 'merge', [], opts);
 * });
 * void engine;
 * ```
 */
export interface WorkflowReduceOptions extends Record<string, unknown> {
  idPrefix?: string;
}

// ---------------------------------------------------------------------------
// Forward-declared WorkflowContext interface (full implementation in context.ts)
// ---------------------------------------------------------------------------

/**
 * The minimal context contract that every workflow function receives. For
 * most operations — `run`, `sleep`, `waitForSignal`, `setAttribute`,
 * `stream`, `suspendUntil`, `agent`, and the multi-agent primitives — cast
 * to the concrete `Context` class from `src/core/context.ts`:
 *
 * ```ts
 * import type { Context } from 'weft';
 *
 * engine.register('example', async function* (ctx) {
 *   const result = yield* (ctx as Context).run(myActivity, input);
 *   yield* (ctx as Context).suspendUntil('resume-token');
 * });
 * ```
 *
 * Composition operators are available directly on `WorkflowContext`, so
 * `ctx.pipe(...)`, `ctx.map(...)`, and `ctx.reduce(...)` do not require a
 * cast.
 *
 * `tenant` is surfaced directly on this interface (not via the cast) because
 * reading it is a common lightweight path that doesn't need the full method
 * surface.
 *
 * @example
 * ```ts
 * import { Engine, activity, type WorkflowContext } from 'weft';
 * import type { Context } from 'weft';
 *
 * const engine = new Engine();
 * const noop = activity({ name: 'noop', execute: async (i: unknown) => i });
 *
 * engine.register('myWorkflow', async function* (ctx: WorkflowContext, input: unknown) {
 *   const id = ctx.workflowId;
 *   const remaining = ctx.executionTimeRemaining;
 *   // For run/sleep/signal, cast to the concrete Context class:
 *   const result = yield* (ctx as Context).run(noop, input);
 *   return result;
 * });
 * void engine;
 * ```
 */
export interface WorkflowContext {
  readonly workflowId: WorkflowId;
  readonly signal: AbortSignal;
  readonly executionTimeRemaining: number;
  readonly startedAt: number;
  /**
   * The {@link import('./tenant.ts').TenantContext} this workflow is running
   * on behalf of, populated from the engine's `tenantResolver` at start time
   * and restored from persisted state on recovery. `undefined` when the
   * engine has no resolver configured or the resolver returned `undefined`.
   *
   * Declared as `T | undefined` rather than `tenant?: T` so the field is
   * always present on the type — the `Context` class implementation has a
   * getter that returns `undefined` when absent, and under
   * `exactOptionalPropertyTypes` the optional-key form would be a stricter
   * contract that the getter can't satisfy.
   */
  readonly tenant: import('./tenant.ts').TenantContext | undefined;
  sessionState<T>(key: string, initialValue?: T): WorkflowSessionState<T>;
  pipe<TInput, TOutput>(
    stages: [WorkflowPipeStageDefinition<TInput, TOutput>],
    input: TInput,
  ): WorkflowOperation<TOutput>;
  pipe<TInput, TIntermediate, TOutput>(
    stages: [
      WorkflowPipeStageDefinition<TInput, TIntermediate>,
      WorkflowPipeStageDefinition<TIntermediate, TOutput>,
    ],
    input: TInput,
  ): WorkflowOperation<TOutput>;
  pipe<TInput, TFirst, TSecond, TOutput>(
    stages: [
      WorkflowPipeStageDefinition<TInput, TFirst>,
      WorkflowPipeStageDefinition<TFirst, TSecond>,
      WorkflowPipeStageDefinition<TSecond, TOutput>,
    ],
    input: TInput,
  ): WorkflowOperation<TOutput>;
  pipe<TInput, TFirst, TSecond, TThird, TOutput>(
    stages: [
      WorkflowPipeStageDefinition<TInput, TFirst>,
      WorkflowPipeStageDefinition<TFirst, TSecond>,
      WorkflowPipeStageDefinition<TSecond, TThird>,
      WorkflowPipeStageDefinition<TThird, TOutput>,
    ],
    input: TInput,
  ): WorkflowOperation<TOutput>;
  pipe<TResult = unknown>(
    stages: Array<WorkflowPipeStage | ChildWorkflowTarget>,
    input: unknown,
  ): WorkflowOperation<TResult>;
  map<TItem, TResult>(
    items: readonly TItem[],
    workflowType: ChildWorkflowTarget<TItem, TResult>,
    options?: WorkflowMapOptions,
  ): WorkflowOperation<TResult[]>;
  reduce<TItem, TAccumulator>(
    items: readonly TItem[],
    workflowType: ChildWorkflowTarget<WorkflowReduceInput<TAccumulator, TItem>, TAccumulator>,
    initialValue: TAccumulator,
    options?: WorkflowReduceOptions,
  ): WorkflowOperation<TAccumulator>;
}

// ---------------------------------------------------------------------------
// Workflow registration
// ---------------------------------------------------------------------------

/**
 * Full registration descriptor used when calling `engine.register(type, registration)`.
 * Bundles the workflow handler with optional metadata: version for live
 * migration, `searchAttributes` schema for indexing, a `retention` policy,
 * and domain `constraints` evaluated at every checkpoint.
 *
 * @example
 * ```ts
 * import { activity, Engine, type WorkflowRegistration, type WorkflowContext } from 'weft';
 * import type { Context } from 'weft';
 *
 * const noop = activity({ name: 'noop', execute: async (i: unknown) => i });
 * const registration: WorkflowRegistration = {
 *   version: '1.0.0',
 *   retention: { completed: '7d' },
 *   handler: async function* (ctx: WorkflowContext, input: unknown) {
 *     return yield* (ctx as Context).run(noop, input);
 *   },
 * };
 * const engine = new Engine();
 * engine.register('myWorkflow', registration);
 * void engine;
 * ```
 */
export interface WorkflowRegistration<TInput = unknown, TOutput = unknown> {
  version?: string;
  handler: WorkflowFunction<TInput, TOutput>;
  migrate?: (checkpoint: unknown, fromVersion: string) => unknown;
  searchAttributes?: SearchAttributeSchema;
  retention?: RetentionPolicy;
  /**
   * Domain constraints evaluated at every checkpoint commit. When a constraint's
   * `check` returns false, the engine dispatches a `ConstraintViolatedEvent`
   * and reacts per `onViolation` ('fail' | 'compensate' | 'warn').
   *
   * **Note**: Constraints are only evaluated when using the default inline
   * execution strategy. Workflows running in a Web Worker
   * (`workerExecution` option) will silently skip constraint evaluation.
   */
  constraints?: ConstraintDefinition[];
}

// ---------------------------------------------------------------------------
// Workflow registry for typed Engine<TRegistry>
// ---------------------------------------------------------------------------

/**
 * Type-level map of workflow names to their input and output shapes. Pass as
 * the generic parameter to `Engine<TRegistry>` to get type-safe `start`,
 * `get`, and `getHandle` calls. Each key is a workflow name; each value
 * declares the `input` type and `output` type.
 *
 * @example
 * ```ts
 * import { Engine, type WorkflowRegistry } from 'weft';
 *
 * type MyRegistry = WorkflowRegistry & {
 *   greet: { input: string; output: string };
 * };
 *
 * // WorkflowRegistry documents the shape contract for type-safe engine wrappers
 * const _registry: MyRegistry = { greet: { input: '', output: '' } };
 * void _registry;
 * ```
 */
export type WorkflowRegistry = Record<string, { input: unknown; output: unknown }>;

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

// ---------------------------------------------------------------------------
// Per-tenant quotas
// ---------------------------------------------------------------------------

/**
 * Rate-limit configuration for tenant workflow creation. `count` is the
 * maximum number of workflows allowed within `window`. Pass as
 * {@link TenantQuotaOptions.maxWorkflowCreationRate} to enforce burst
 * protection per tenant.
 *
 * @example
 * ```ts
 * import { Engine, type TenantWorkflowCreationRateLimit } from 'weft';
 *
 * const rateLimit: TenantWorkflowCreationRateLimit = { count: 100, window: '1m' };
 * const engine = new Engine({ quotas: { maxWorkflowCreationRate: rateLimit } });
 * void engine;
 * ```
 */
export interface TenantWorkflowCreationRateLimit {
  count: number;
  window: Duration;
}

/**
 * Per-tenant admission control limits enforced by the engine when a
 * `tenantResolver` is configured. Set limits on concurrent running workflows,
 * creation rate, and total storage. Any limit can be omitted to leave that
 * dimension unconstrained. Pass as {@link EngineOptions.quotas}.
 *
 * @example
 * ```ts
 * import { Engine, type TenantQuotaOptions } from 'weft';
 *
 * const quotas: TenantQuotaOptions = {
 *   maxConcurrentWorkflows: 50,
 *   maxWorkflowCreationRate: { count: 100, window: '1m' },
 *   maxStorageBytes: 10_000_000,
 * };
 * const engine = new Engine({ quotas });
 * void engine;
 * ```
 */
export interface TenantQuotaOptions {
  maxConcurrentWorkflows?: number;
  maxWorkflowCreationRate?: TenantWorkflowCreationRateLimit;
  maxStorageBytes?: number;
}

/**
 * Current usage and configured limit for a single tenant quota dimension.
 * `limit` is `null` when no limit was configured for this dimension.
 * Returned as part of {@link TenantQuotaUsage} from `engine.getTenantQuotaUsage`.
 */
export interface TenantQuotaMetricUsage {
  used: number;
  limit: number | null;
}

/**
 * Rate-limit usage for workflow creation, extending {@link TenantQuotaMetricUsage}
 * with the `windowMilliseconds` field. `null` when no rate limit was configured.
 * Returned as the `workflowCreationRate` field of {@link TenantQuotaUsage}.
 */
export interface TenantWorkflowCreationRateUsage extends TenantQuotaMetricUsage {
  windowMilliseconds: number | null;
}

/**
 * Snapshot of all quota usage metrics for a specific tenant. Returned by
 * `engine.getTenantQuotaUsage(tenantId)`. Read `activeWorkflows.used` vs
 * `activeWorkflows.limit` to determine headroom before hitting concurrency limits.
 */
export interface TenantQuotaUsage {
  tenantId: string;
  activeWorkflows: TenantQuotaMetricUsage;
  storageBytes: TenantQuotaMetricUsage;
  workflowCreationRate: TenantWorkflowCreationRateUsage;
}

export interface AttributeFilter {
  key: string;
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
 * matching the filter; `items` is the current page slice.
 */
export interface PaginatedResult<T> {
  items: T[];
  total: number;
  offset: number;
  limit: number;
}

// ---------------------------------------------------------------------------
// Workflow summary (returned by list)
// ---------------------------------------------------------------------------

/**
 * Lightweight summary of a workflow returned by list operations. Contains
 * identity and lifecycle fields but not the full input, result, or checkpoint.
 * Use {@link Engine.get} to retrieve the complete {@link WorkflowState}.
 */
export interface WorkflowSummary {
  id: WorkflowId;
  type: string;
  status: WorkflowStatus;
  tags?: string[];
  version: string;
  createdAt: number;
  updatedAt: number;
}

/**
 * Retention policy entry for a specific workflow type, as reported by
 * `engine.getRetentionOverview`. `source` indicates whether the policy
 * came from the engine-level default, a per-workflow registration, or is
 * absent entirely (`'none'`).
 *
 * @example
 * ```ts
 * import { Engine, type WorkflowTypeRetentionPolicy } from 'weft';
 *
 * const engine = new Engine({ retention: { completed: '7d' } });
 * engine.register('ping', async function* () { return 'pong'; });
 * const overview = await engine.getRetentionOverview();
 * const policy: WorkflowTypeRetentionPolicy = overview.workflowTypes[0]!;
 * console.log(policy.source); // 'engine'
 * ```
 */
export interface WorkflowTypeRetentionPolicy {
  type: string;
  source: 'engine' | 'workflow' | 'none';
  retention: NormalizedRetentionPolicy | null;
}

/**
 * Summary of the engine's retention configuration, returned by
 * `engine.getRetentionOverview()`. Lists the default retention policy,
 * sweep schedule, and per-workflow-type overrides so operators can
 * audit what cleanup behaviour is active.
 *
 * @example
 * ```ts
 * import { Engine, type RetentionOverview } from 'weft';
 *
 * const engine = new Engine({ retention: { completed: '7d' } });
 * const overview: RetentionOverview = await engine.getRetentionOverview();
 * console.log(overview.sweepIntervalMs);
 * console.log(overview.workflowTypes.length);
 * ```
 */
export interface RetentionOverview {
  defaultRetention: NormalizedRetentionPolicy | null;
  sweepIntervalMs: number;
  sweepBatchSize: number;
  nextSweepAt: number | null;
  workflowTypes: WorkflowTypeRetentionPolicy[];
}

// ---------------------------------------------------------------------------
// Recurring schedule state
// ---------------------------------------------------------------------------

/**
 * Lifecycle state of a recurring schedule managed by {@link Engine.schedule}.
 * `'active'` fires on cron cadence; `'paused'` skips upcoming runs without
 * deleting the schedule; `'cancelled'` is the terminal removed state.
 */
export type ScheduleStatus = 'active' | 'paused' | 'cancelled';

/**
 * Behaviour when a scheduled cron tick fires while a previous run is still
 * active. `'skip'` drops the new run; `'queue'` buffers it; `'cancel-running'`
 * cancels the active workflow and starts fresh; `'allow'` starts both
 * concurrently. Pass via {@link ScheduleOptions.overlap}.
 *
 * @example
 * ```ts
 * import { Engine, type ScheduleOverlapPolicy } from 'weft';
 *
 * const engine = new Engine();
 * engine.register('hourly', async function* () { return 'done'; });
 * const policy: ScheduleOverlapPolicy = 'skip';
 * await engine.schedule('0 * * * *', 'hourly', '', { overlap: policy });
 * ```
 */
export type ScheduleOverlapPolicy = 'skip' | 'queue' | 'cancel-running' | 'allow';

/**
 * Options accepted by {@link Engine.schedule}. `id` assigns a deterministic
 * schedule identifier; `overlap` controls what happens when a cron tick fires
 * while a previous run is still active; `backfill` triggers immediate runs for
 * any cron ticks that were missed since the schedule was created.
 *
 * @example
 * ```ts
 * import { Engine, type ScheduleOptions } from 'weft';
 *
 * const engine = new Engine();
 * engine.register('report', async function* () { return 'ok'; });
 * const options: ScheduleOptions = { id: 'daily-report', overlap: 'skip', backfill: false };
 * const handle = await engine.schedule('0 9 * * *', 'report', '', options);
 * void handle;
 * ```
 */
export interface ScheduleOptions {
  id?: string;
  overlap?: ScheduleOverlapPolicy;
  backfill?: boolean;
}

/**
 * Full persisted state of a recurring schedule. Returned by
 * `engine.getSchedule(id)`. Use {@link ScheduleSummary} for the lightweight
 * list variant that omits the tenant field.
 */
export interface ScheduleState {
  id: string;
  workflowType: string;
  input: unknown;
  cronExpression: string;
  status: ScheduleStatus;
  overlap: ScheduleOverlapPolicy;
  backfill: boolean;
  createdAt: number;
  updatedAt: number;
  lastFireAt?: number;
  nextFireAt: number | null;
  currentWorkflowId?: string;
  queuedRuns: number;
  tenant?: import('./tenant.ts').TenantContext;
}

/**
 * Lightweight summary of a recurring schedule returned by list operations.
 * Contains cron expression, status, timing metadata, and the ID of the
 * currently running workflow (if any). For the full record including the
 * tenant field, use {@link ScheduleState}.
 */
export interface ScheduleSummary {
  id: string;
  workflowType: string;
  cronExpression: string;
  status: ScheduleStatus;
  overlap: ScheduleOverlapPolicy;
  backfill: boolean;
  createdAt: number;
  updatedAt: number;
  lastFireAt?: number;
  nextFireAt: number | null;
  currentWorkflowId?: string;
  queuedRuns: number;
}

/**
 * Optional tenant-scoping parameter accepted by schedule management methods
 * (`pauseSchedule`, `resumeSchedule`, `cancelSchedule`, etc.). Pass `tenantId`
 * to ensure the operation is only applied to schedules belonging to that tenant.
 */
export interface ScheduleAccessOptions {
  tenantId?: string;
}

/**
 * Filter criteria for `engine.listSchedules`. All fields are optional.
 * `status` accepts one or more values; `tenantId` scopes results to a specific
 * tenant; `limit` and `offset` control pagination.
 */
export interface ScheduleFilter {
  status?: ScheduleStatus | ScheduleStatus[];
  workflowType?: string;
  tenantId?: string;
  limit?: number;
  offset?: number;
}

// ---------------------------------------------------------------------------
// Workflow event (returned by engine.getEvents)
// ---------------------------------------------------------------------------

/**
 * Raw event record stored in the engine's event log for a workflow. Returned
 * by `engine.getEvents(workflowId)`. Each entry carries a free-form `data`
 * map; use the typed {@link WeftEventMap} subclasses for richer access.
 */
export interface WorkflowEvent {
  type: string;
  timestamp: number;
  data: Record<string, unknown>;
}

/**
 * Full replay package for a workflow step, combining the checkpoint state,
 * the accumulated operation results up to that step, and the event log.
 * Returned by `engine.replayWorkflow` for time-travel debugging.
 */
export type WorkflowReplay = {
  checkpoint: CheckpointState;
  accumulatedResults: Array<[number, unknown]>;
  events: WorkflowEvent[];
};

// ---------------------------------------------------------------------------
// Review decision types (for engine.submitReview)
// ---------------------------------------------------------------------------

/**
 * Outcome of a human review step initiated by `ctx.waitForReview`. Pass as
 * the `decision` field in {@link SubmitReviewOptions} when calling
 * `engine.submitReview`.
 */
export type ReviewDecision = 'approved' | 'rejected' | 'needs-changes';

/**
 * Options for `engine.submitReview`. Supply the `decision`, the `reviewer`
 * identifier, and optional `feedback`. For workflows with partial approval
 * semantics, provide `sectionDecisions`. Pass `workflowId` when you know the
 * target workflow ID to avoid a full storage scan.
 *
 * @example
 * ```ts
 * import { Engine, type SubmitReviewOptions } from 'weft';
 *
 * const engine = new Engine();
 * const options: SubmitReviewOptions = {
 *   decision: 'approved',
 *   reviewer: 'alice@example.com',
 *   feedback: 'Looks good',
 *   workflowId: 'wf-123',
 * };
 * // await engine.submitReview('review-key', options);
 * void options;
 * ```
 */
export interface SubmitReviewOptions {
  decision: ReviewDecision;
  reviewer: string;
  feedback?: string;
  /** Per-section decisions for partial approval workflows. */
  sectionDecisions?: Record<string, 'approved' | 'rejected'>;
  /** When provided, enables O(1) direct key lookup instead of scanning. */
  workflowId?: string;
}

// ---------------------------------------------------------------------------
// Coordinated update result (for engine.submitCoordinatedUpdate)
// ---------------------------------------------------------------------------

/**
 * Result of a coordinated update sent via `engine.submitCoordinatedUpdate`.
 * Contains the `updateId` and either the resolved `result` or an `error`
 * string if the workflow handler threw.
 */
export interface CoordinatedUpdateResult {
  updateId: string;
  result?: unknown;
  error?: string;
}

/**
 * Per-workflow error entry in bulk operation results. `id` identifies the
 * workflow that failed; `error` is the error message string.
 */
export type BulkOperationError = {
  id: WorkflowId;
  error: string;
};

/**
 * Result of a bulk cancel operation (`engine.cancelAll`). Reports the count
 * of successfully cancelled workflows, the number that failed, and per-workflow
 * error details in `errors`.
 */
export type BulkCancelResult = {
  cancelled: number;
  failed: number;
  errors: BulkOperationError[];
};

/**
 * Result of a bulk signal operation (`engine.signalAll`). Reports the number
 * of workflows that received the signal and the number for which delivery failed.
 */
export type BulkSignalResult = {
  signalled: number;
  failed: number;
};

/**
 * Result of a bulk delete operation (`engine.deleteAll`). Reports how many
 * terminal workflows were deleted from storage.
 */
export type BulkDeleteResult = {
  deleted: number;
};

/**
 * Result of a bulk tag operation (`engine.addTagsAll` / `engine.removeTagsAll`).
 * Reports how many workflows had their tags modified.
 */
export type BulkTagResult = {
  modified: number;
};

/**
 * Result of a purge operation (`engine.purge`). Reports how many workflow
 * records were permanently removed from storage.
 */
export interface PurgeResult {
  deleted: number;
}

// ---------------------------------------------------------------------------
// Default constants
// ---------------------------------------------------------------------------

/**
 * Built-in retry policy applied to all activities that do not specify their
 * own. Retries up to 3 times with 1 s initial backoff, doubling on each
 * attempt and capping at 30 s. Override per-activity via
 * {@link ActivityDefinition.retry} or per-call via {@link ActivityCallOptions.retry}.
 *
 * @example
 * ```ts
 * import { DEFAULT_RETRY_POLICY, type RetryPolicy } from 'weft';
 *
 * // Extend the default policy with a custom non-retryable error list:
 * const policy: RetryPolicy = {
 *   ...DEFAULT_RETRY_POLICY,
 *   nonRetryableErrors: ['ValidationError'],
 * };
 * void policy;
 * ```
 */
export const DEFAULT_RETRY_POLICY: RetryPolicy = {
  maxAttempts: 3,
  initialBackoff: 1000,
  backoffMultiplier: 2,
  maxBackoff: 30_000,
};

/**
 * Default checkpoint size (in bytes) above which the engine emits a
 * {@link CheckpointSizeWarningEvent}. Currently 64 KB. Override via
 * {@link EngineOptions.checkpointSizeWarningThreshold}.
 *
 * @example
 * ```ts
 * import { Engine, DEFAULT_CHECKPOINT_SIZE_WARNING_THRESHOLD } from 'weft';
 *
 * const engine = new Engine({
 *   checkpointSizeWarningThreshold: DEFAULT_CHECKPOINT_SIZE_WARNING_THRESHOLD * 2,
 * });
 * void engine;
 * ```
 */
export const DEFAULT_CHECKPOINT_SIZE_WARNING_THRESHOLD = 65_536; // 64KB
/**
 * Maximum allowed nesting depth for child workflow invocations before the
 * engine throws. Prevents unbounded recursion. Override via
 * {@link EngineOptions.maxNestingDepth}.
 *
 * @example
 * ```ts
 * import { Engine, DEFAULT_MAX_NESTING_DEPTH } from 'weft';
 *
 * const engine = new Engine({ maxNestingDepth: DEFAULT_MAX_NESTING_DEPTH + 5 });
 * void engine;
 * ```
 */
export const DEFAULT_MAX_NESTING_DEPTH = 10;
export const DEFAULT_POLL_INTERVAL_MS = 1000;
/**
 * Default activity visibility timeout in milliseconds (30 seconds). The engine
 * marks an activity as failed if no heartbeat or result is received within this
 * window. Override per-activity via {@link ActivityDefinition.visibilityTimeout}
 * or per-call via {@link ActivityCallOptions.visibilityTimeout}.
 *
 * @example
 * ```ts
 * import { Engine, DEFAULT_VISIBILITY_TIMEOUT_MS, activity } from 'weft';
 *
 * const longTask = activity({
 *   name: 'longTask',
 *   visibilityTimeout: DEFAULT_VISIBILITY_TIMEOUT_MS * 4, // 2 minutes
 *   execute: async (input: unknown) => input,
 * });
 * const engine = new Engine();
 * void engine;
 * void longTask;
 * ```
 */
export const DEFAULT_VISIBILITY_TIMEOUT_MS = 30_000;
export const DEFAULT_RETENTION_SWEEP_INTERVAL_MS = 300_000;
export const DEFAULT_RETENTION_SWEEP_BATCH_SIZE = 1000;

// ---------------------------------------------------------------------------
// activity() helper — wraps a function with colocated configuration
// ---------------------------------------------------------------------------

/**
 * Create an activity with colocated configuration.
 * The returned value is both an ActivityDefinition and a callable function.
 *
 * @example
 * ```ts
 * import { activity } from 'weft';
 *
 * const fetchUser = activity({
 *   name: 'fetchUser',
 *   execute: async (input: unknown) => {
 *     const id = input as string;
 *     return { id, name: 'Alice' };
 *   },
 * });
 *
 * // Use in a workflow via ctx.run:
 * // const user = yield* (ctx as Context).run(fetchUser, userId);
 * void fetchUser;
 * ```
 */
export function activity<TInput, TOutput>(
  options: ActivityDefinition<TInput, TOutput>,
): ActivityDefinition<TInput, TOutput> & ((...args: [TInput]) => Promise<TOutput>) {
  const fn = ((...args: [TInput]) => options.execute(...args)) as (
    ...args: [TInput]
  ) => Promise<TOutput>;

  // Assign non-function-builtin properties from options to the function
  const { name, execute, ...rest } = options;
  Object.assign(fn, rest);

  // Set name and execute as own properties (name is non-writable on functions,
  // so we must use defineProperty)
  Object.defineProperty(fn, 'name', { value: name, configurable: true });
  Object.defineProperty(fn, 'execute', { value: execute, enumerable: true, configurable: true });

  return fn as ActivityDefinition<TInput, TOutput> & ((...args: [TInput]) => Promise<TOutput>);
}
