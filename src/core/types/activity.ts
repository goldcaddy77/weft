import type { Duration, RetryPolicy } from './retry-retention.ts';

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
 * `ctx.run(activity, input, options)`. Any field overrides the
 * activity's own defaults for that single call. Useful for increasing the
 * timeout on a retried call or routing to a specific queue.
 *
 * @example
 * ```ts
 * import { activity, Engine, type ActivityCallOptions, type WorkflowContext } from 'weft';
 *
 * const slowTask = activity({ name: 'slowTask', execute: async (i: unknown) => i });
 * const engine = new Engine();
 *
 * engine.register('example', async function* (ctx: WorkflowContext, input: unknown) {
 *   const options: ActivityCallOptions = { timeout: '5m', queue: 'heavy' };
 *   const result = yield* ctx.run(slowTask, input, options);
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
 *   execute: async (input: { to: string; body: string }) => {
 *     const { to, body } = input;
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
 * // const user = yield* ctx.run(fetchUser, userId);
 * void fetchUser;
 * ```
 */
export function activity<TOutput>(
  options: ActivityDefinition<void, TOutput> & {
    execute: () => Promise<TOutput> | TOutput;
  },
): ActivityDefinition<void, TOutput> & (() => Promise<TOutput>);
export function activity<TInput, TOutput>(
  options: ActivityDefinition<TInput, TOutput>,
): ActivityDefinition<TInput, TOutput> & ((...args: [TInput]) => Promise<TOutput>);
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
