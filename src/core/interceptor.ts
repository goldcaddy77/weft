/**
 * Interceptor interfaces and composition logic for cross-cutting concerns.
 *
 * Interceptors compose like middleware: the first registered interceptor is
 * the outermost wrapper. Each interceptor receives an interception context and
 * a `next` function that delegates to the next interceptor (or the final
 * execute function at the end of the chain).
 *
 * @module interceptor
 */

// ---------------------------------------------------------------------------
// Interception contexts (what each hook receives)
// ---------------------------------------------------------------------------

/**
 * Context object passed to workflow interceptors when an activity is scheduled.
 * Read-only snapshot of the activity call — modify via the `next` callback.
 *
 * @example
 * ```ts
 * import { Engine, type ActivityInterception } from 'weft';
 * import type { WorkflowInterceptor } from 'weft';
 *
 * const loggingInterceptor: WorkflowInterceptor = {
 *   *activity(ctx: ActivityInterception, next) {
 *     console.log('activity:', ctx.activityName, 'attempt:', ctx.attempt);
 *     return yield* next(ctx);
 *   },
 * };
 * // const engine = new Engine(); engine.addInterceptor(loggingInterceptor);
 * void loggingInterceptor;
 * ```
 */
export interface ActivityInterception {
  workflowId: string;
  activityName: string;
  input: unknown;
  attempt: number;
  headers: Map<string, string>;
}

/**
 * Context object passed to a workflow interceptor's `sleep` hook. Contains the
 * workflow ID, the requested sleep duration in milliseconds, and the outgoing
 * headers map. Modify headers inside the hook to propagate trace context.
 *
 * @example
 * ```ts
 * import { Engine, type SleepInterception } from 'weft';
 * import type { WorkflowInterceptor } from 'weft';
 *
 * const tracer: WorkflowInterceptor = {
 *   *sleep(ctx: SleepInterception, next) {
 *     console.log('sleep', ctx.duration, 'ms for', ctx.workflowId);
 *     return yield* next(ctx);
 *   },
 * };
 * void tracer;
 * ```
 */
export interface SleepInterception {
  workflowId: string;
  duration: number;
  headers: Map<string, string>;
}

/**
 * Context object passed to a workflow interceptor's `waitForSignal` hook.
 * Contains the workflow ID, signal name, optional payload, and outgoing headers.
 *
 * @example
 * ```ts
 * import { type SignalInterception, type WorkflowInterceptor } from 'weft';
 *
 * const tracer: WorkflowInterceptor = {
 *   *waitForSignal(ctx: SignalInterception, next) {
 *     console.log('waiting for signal', ctx.signalName);
 *     return yield* next(ctx);
 *   },
 * };
 * void tracer;
 * ```
 */
export interface SignalInterception {
  workflowId: string;
  signalName: string;
  payload: unknown;
  headers: Map<string, string>;
}

/**
 * Context object passed to a workflow interceptor's `workflowStart` hook when
 * a new workflow begins executing. Useful for injecting trace headers or
 * enforcing tenant-level policies at start time.
 *
 * @example
 * ```ts
 * import { type WorkflowStartInterception, type WorkflowInterceptor } from 'weft';
 *
 * const tracer: WorkflowInterceptor = {
 *   workflowStart(ctx: WorkflowStartInterception, next) {
 *     ctx.headers.set('x-trace-id', crypto.randomUUID());
 *     next(ctx);
 *   },
 * };
 * void tracer;
 * ```
 */
export interface WorkflowStartInterception {
  workflowId: string;
  workflowType: string;
  input: unknown;
  headers: Map<string, string>;
}

/**
 * Context object passed to an {@link ActivityInterceptor}'s `execute` hook
 * during activity execution. Provides the activity name, input, attempt count,
 * headers, and optional cancellation signal for remote-worker execution.
 *
 * @example
 * ```ts
 * import { type ActivityExecutionInterception, type ActivityInterceptor } from 'weft';
 *
 * const logger: ActivityInterceptor = {
 *   async execute(ctx: ActivityExecutionInterception, next) {
 *     console.log('executing', ctx.activityName, 'attempt', ctx.attempt);
 *     const result = await next(ctx);
 *     return result;
 *   },
 * };
 * void logger;
 * ```
 */
export interface ActivityExecutionInterception {
  activityName: string;
  input: unknown;
  attempt: number;
  headers: Map<string, string>;
  /** Operation identifier, available when executing on a remote worker. */
  operationId?: string;
  /** Abort signal for cancellation, available when executing on a remote worker. */
  signal?: AbortSignal;
}

/** Callback info passed to agent turn-lifecycle hooks. */
export interface AgentTurnInfo {
  turnIndex: number;
  model: string;
}

/** Callback info passed after an agent turn completes. */
export interface AgentTurnResultInfo {
  turnIndex: number;
  model: string;
  inputTokens: number;
  outputTokens: number;
  cost: number;
  duration: number;
  toolCallCount: number;
}

/** Callback info passed when a tool is called during an agent turn. */
export interface AgentToolCallInfo {
  turnIndex: number;
  toolName: string;
}

/** Callback info passed when a tool call returns during an agent turn. */
export interface AgentToolReturnInfo {
  turnIndex: number;
  toolName: string;
  duration: number;
  success: boolean;
}

/**
 * Context object passed to a workflow interceptor's `childWorkflow` hook when
 * a workflow spawns a child via `ctx.pipe`, `ctx.map`, or `ctx.reduce`.
 * Includes both the child's own headers and the parent's headers for trace
 * span linking.
 *
 * @example
 * ```ts
 * import { type ChildWorkflowInterception, type WorkflowInterceptor } from 'weft';
 *
 * const tracer: WorkflowInterceptor = {
 *   async childWorkflow(ctx: ChildWorkflowInterception, next) {
 *     console.log('spawning child', ctx.childWorkflowId, 'type:', ctx.workflowType);
 *     return next(ctx);
 *   },
 * };
 * void tracer;
 * ```
 */
export interface ChildWorkflowInterception {
  workflowId: string;
  childWorkflowId: string;
  workflowType: string;
  input: unknown;
  headers: Map<string, string>;
  /** Headers from the parent workflow, used for span link creation. */
  parentHeaders: Map<string, string>;
}

/**
 * Context object passed to a workflow interceptor's `agent` hook when a
 * workflow calls `ctx.agent()`. Includes the model, prompt, headers, and
 * optional turn-lifecycle callbacks for telemetry.
 *
 * @example
 * ```ts
 * import { type AgentInterception, type WorkflowInterceptor } from 'weft';
 *
 * const monitor: WorkflowInterceptor = {
 *   *agent(ctx: AgentInterception, next) {
 *     console.log('agent call model:', ctx.model);
 *     return yield* next(ctx);
 *   },
 * };
 * void monitor;
 * ```
 */
export interface AgentInterception {
  workflowId: string;
  model: string;
  prompt: string;
  headers: Map<string, string>;
  /** Optional callback invoked when each agent turn starts. */
  onTurnStarted?: (info: AgentTurnInfo) => void;
  /** Optional callback invoked when each agent turn completes. */
  onTurnCompleted?: (info: AgentTurnResultInfo) => void;
  /** Optional callback invoked when a tool is called. */
  onToolCalled?: (info: AgentToolCallInfo) => void;
  /** Optional callback invoked when a tool call returns. */
  onToolReturned?: (info: AgentToolReturnInfo) => void;
}

/**
 * Context object passed to a workflow interceptor's `query` hook when a
 * query is evaluated. Modify `headers` to propagate trace context; read
 * `queryName` for logging.
 *
 * @example
 * ```ts
 * import { type QueryInterception, type WorkflowInterceptor } from 'weft';
 *
 * const tracer: WorkflowInterceptor = {
 *   *query(ctx: QueryInterception, next) {
 *     console.log('query:', ctx.queryName);
 *     return yield* next(ctx);
 *   },
 * };
 * void tracer;
 * ```
 */
export interface QueryInterception {
  queryName: string;
  headers: Map<string, string>;
}

/**
 * Context object passed to a workflow interceptor's `signalReceived` hook
 * when an inbound signal arrives at the workflow. Allows interceptors to
 * inspect or modify the payload before the workflow handler processes it.
 *
 * @example
 * ```ts
 * import { type SignalReceivedInterception, type WorkflowInterceptor } from 'weft';
 *
 * const tracer: WorkflowInterceptor = {
 *   signalReceived(ctx: SignalReceivedInterception, next) {
 *     console.log('signal received:', ctx.signalName, 'for', ctx.workflowId);
 *     next(ctx);
 *   },
 * };
 * void tracer;
 * ```
 */
export interface SignalReceivedInterception {
  workflowId: string;
  signalName: string;
  payload: unknown;
  headers: Map<string, string>;
}

// ---------------------------------------------------------------------------
// Interceptor interfaces
// ---------------------------------------------------------------------------

/**
 * Middleware interface for workflow-side interception. Each hook is optional
 * — implement only the hooks you need. Hooks are generator functions that
 * receive an interception context and a `next` callback; call `yield* next(ctx)`
 * to pass control to the next interceptor in the chain.
 *
 * @example
 * ```ts
 * import { Engine, type WorkflowInterceptor } from 'weft';
 *
 * const tracer: WorkflowInterceptor = {
 *   *activity(ctx, next) {
 *     console.log('activity started:', ctx.activityName);
 *     const result = yield* next(ctx);
 *     console.log('activity done:', ctx.activityName);
 *     return result;
 *   },
 * };
 *
 * const engine = new Engine();
 * engine.register('ping', async function* () { return 'pong'; });
 * void engine;
 * void tracer;
 * ```
 */
export interface WorkflowInterceptor {
  activity?(
    interception: ActivityInterception,
    next: (interception: ActivityInterception) => Generator<unknown, unknown, unknown>,
  ): Generator<unknown, unknown, unknown>;

  sleep?(
    interception: SleepInterception,
    next: (interception: SleepInterception) => Generator<unknown, void, unknown>,
  ): Generator<unknown, void, unknown>;

  waitForSignal?(
    interception: SignalInterception,
    next: (interception: SignalInterception) => Generator<unknown, unknown, unknown>,
  ): Generator<unknown, unknown, unknown>;

  workflowStart?(
    interception: WorkflowStartInterception,
    next: (interception: WorkflowStartInterception) => void,
  ): void;

  childWorkflow?(
    interception: ChildWorkflowInterception,
    next: (interception: ChildWorkflowInterception) => Promise<unknown>,
  ): Promise<unknown>;

  agent?(
    interception: AgentInterception,
    next: (interception: AgentInterception) => Generator<unknown, unknown, unknown>,
  ): Generator<unknown, unknown, unknown>;

  query?(
    interception: QueryInterception,
    next: (interception: QueryInterception) => Generator<unknown, unknown, unknown>,
  ): Generator<unknown, unknown, unknown>;

  signalReceived?(
    interception: SignalReceivedInterception,
    next: (interception: SignalReceivedInterception) => void,
  ): void;
}

/**
 * Middleware interface for activity-execution interception. Runs on the
 * side that actually executes the activity function (main thread or worker).
 * Implement `execute` to add retry logging, tracing, or input/output transforms.
 *
 * @example
 * ```ts
 * import { Engine, type ActivityInterceptor } from 'weft';
 *
 * const logger: ActivityInterceptor = {
 *   async execute(ctx, next) {
 *     const result = await next(ctx);
 *     console.log(ctx.activityName, 'attempt', ctx.attempt, 'succeeded');
 *     return result;
 *   },
 * };
 * void logger;
 * ```
 */
export interface ActivityInterceptor {
  execute?(
    interception: ActivityExecutionInterception,
    next: (interception: ActivityExecutionInterception) => Promise<unknown>,
  ): Promise<unknown>;
}

// ---------------------------------------------------------------------------
// Composed interceptor interfaces
// ---------------------------------------------------------------------------

/**
 * The fully-composed workflow interceptor produced by
 * {@link composeWorkflowInterceptors}. All hooks are non-optional — the
 * composition fills in pass-through implementations for any hooks not
 * provided by the individual interceptors. Used internally by the engine.
 *
 * @example
 * ```ts
 * import { composeWorkflowInterceptors, type ComposedWorkflowInterceptor } from 'weft';
 * import type { WorkflowInterceptor } from 'weft';
 *
 * const tracer: WorkflowInterceptor = {
 *   *activity(ctx, next) {
 *     console.log('activity:', ctx.activityName);
 *     return yield* next(ctx);
 *   },
 * };
 *
 * const composed: ComposedWorkflowInterceptor = composeWorkflowInterceptors([tracer]);
 * void composed;
 * ```
 */
export interface ComposedWorkflowInterceptor {
  activity(
    interception: ActivityInterception,
    execute: (interception: ActivityInterception) => Generator<unknown, unknown, unknown>,
  ): Generator<unknown, unknown, unknown>;

  sleep(
    interception: SleepInterception,
    execute: (interception: SleepInterception) => Generator<unknown, void, unknown>,
  ): Generator<unknown, void, unknown>;

  waitForSignal(
    interception: SignalInterception,
    execute: (interception: SignalInterception) => Generator<unknown, unknown, unknown>,
  ): Generator<unknown, unknown, unknown>;

  workflowStart(
    interception: WorkflowStartInterception,
    execute: (interception: WorkflowStartInterception) => void,
  ): void;

  childWorkflow(
    interception: ChildWorkflowInterception,
    execute: (interception: ChildWorkflowInterception) => Promise<unknown>,
  ): Promise<unknown>;

  agent(
    interception: AgentInterception,
    execute: (interception: AgentInterception) => Generator<unknown, unknown, unknown>,
  ): Generator<unknown, unknown, unknown>;

  query(
    interception: QueryInterception,
    execute: (interception: QueryInterception) => Generator<unknown, unknown, unknown>,
  ): Generator<unknown, unknown, unknown>;

  signalReceived(
    interception: SignalReceivedInterception,
    execute: (interception: SignalReceivedInterception) => void,
  ): void;
}

/**
 * The fully-composed activity interceptor produced by
 * {@link composeActivityInterceptors}. The `execute` hook is always present.
 * Used internally by the engine to drive activity execution.
 *
 * @example
 * ```ts
 * import { composeActivityInterceptors, type ComposedActivityInterceptor } from 'weft';
 * import type { ActivityInterceptor } from 'weft';
 *
 * const logger: ActivityInterceptor = {
 *   async execute(ctx, next) {
 *     const result = await next(ctx);
 *     console.log(ctx.activityName, 'done');
 *     return result;
 *   },
 * };
 *
 * const composed: ComposedActivityInterceptor = composeActivityInterceptors([logger]);
 * void composed;
 * ```
 */
export interface ComposedActivityInterceptor {
  execute(
    interception: ActivityExecutionInterception,
    execute: (interception: ActivityExecutionInterception) => Promise<unknown>,
  ): Promise<unknown>;
}

// ---------------------------------------------------------------------------
// Composition: workflow interceptors
// ---------------------------------------------------------------------------

/**
 * Compose the `activity` hooks of all workflow interceptors into a single
 * generator chain.
 */
function composeActivityHook(
  interceptors: WorkflowInterceptor[],
): ComposedWorkflowInterceptor['activity'] {
  return function* composedActivity(
    interception: ActivityInterception,
    execute: (interception: ActivityInterception) => Generator<unknown, unknown, unknown>,
  ): Generator<unknown, unknown, unknown> {
    type Next = (ctx: ActivityInterception) => Generator<unknown, unknown, unknown>;

    let chain: Next = execute;

    for (let i = interceptors.length - 1; i >= 0; i--) {
      const interceptor = interceptors[i]!;

      if (interceptor.activity) {
        const innerNext = chain;
        const bound = interceptor.activity.bind(interceptor);
        chain = function* (ctx: ActivityInterception): Generator<unknown, unknown, unknown> {
          return yield* bound(ctx, innerNext);
        };
      }
    }

    return yield* chain(interception);
  };
}

/**
 * Compose the `sleep` hooks of all workflow interceptors into a single
 * generator chain.
 */
function composeSleepHook(
  interceptors: WorkflowInterceptor[],
): ComposedWorkflowInterceptor['sleep'] {
  return function* composedSleep(
    interception: SleepInterception,
    execute: (interception: SleepInterception) => Generator<unknown, void, unknown>,
  ): Generator<unknown, void, unknown> {
    type Next = (ctx: SleepInterception) => Generator<unknown, void, unknown>;

    let chain: Next = execute;

    for (let i = interceptors.length - 1; i >= 0; i--) {
      const interceptor = interceptors[i]!;

      if (interceptor.sleep) {
        const innerNext = chain;
        const bound = interceptor.sleep.bind(interceptor);
        chain = function* (ctx: SleepInterception): Generator<unknown, void, unknown> {
          yield* bound(ctx, innerNext);
        };
      }
    }

    yield* chain(interception);
  };
}

/**
 * Compose the `waitForSignal` hooks of all workflow interceptors into a single
 * generator chain.
 */
function composeWaitForSignalHook(
  interceptors: WorkflowInterceptor[],
): ComposedWorkflowInterceptor['waitForSignal'] {
  return function* composedWaitForSignal(
    interception: SignalInterception,
    execute: (interception: SignalInterception) => Generator<unknown, unknown, unknown>,
  ): Generator<unknown, unknown, unknown> {
    type Next = (ctx: SignalInterception) => Generator<unknown, unknown, unknown>;

    let chain: Next = execute;

    for (let i = interceptors.length - 1; i >= 0; i--) {
      const interceptor = interceptors[i]!;

      if (interceptor.waitForSignal) {
        const innerNext = chain;
        const bound = interceptor.waitForSignal.bind(interceptor);
        chain = function* (ctx: SignalInterception): Generator<unknown, unknown, unknown> {
          return yield* bound(ctx, innerNext);
        };
      }
    }

    return yield* chain(interception);
  };
}

/**
 * Compose the `workflowStart` hooks of all workflow interceptors into a single
 * chain.
 */
function composeWorkflowStartHook(
  interceptors: WorkflowInterceptor[],
): ComposedWorkflowInterceptor['workflowStart'] {
  return function composedWorkflowStart(
    interception: WorkflowStartInterception,
    execute: (interception: WorkflowStartInterception) => void,
  ): void {
    type Next = (ctx: WorkflowStartInterception) => void;

    let chain: Next = execute;

    for (let i = interceptors.length - 1; i >= 0; i--) {
      const interceptor = interceptors[i]!;

      if (interceptor.workflowStart) {
        const innerNext = chain;
        const bound = interceptor.workflowStart.bind(interceptor);
        chain = (ctx: WorkflowStartInterception): void => {
          bound(ctx, innerNext);
        };
      }
    }

    chain(interception);
  };
}

/**
 * Compose the `childWorkflow` hooks of all workflow interceptors into a single
 * async chain.
 */
function composeChildWorkflowHook(
  interceptors: WorkflowInterceptor[],
): ComposedWorkflowInterceptor['childWorkflow'] {
  return async function composedChildWorkflow(
    interception: ChildWorkflowInterception,
    execute: (interception: ChildWorkflowInterception) => Promise<unknown>,
  ): Promise<unknown> {
    type Next = (ctx: ChildWorkflowInterception) => Promise<unknown>;

    let chain: Next = execute;

    for (let i = interceptors.length - 1; i >= 0; i--) {
      const interceptor = interceptors[i]!;

      if (interceptor.childWorkflow) {
        const innerNext = chain;
        const bound = interceptor.childWorkflow.bind(interceptor);
        chain = (ctx: ChildWorkflowInterception): Promise<unknown> => {
          return bound(ctx, innerNext);
        };
      }
    }

    return chain(interception);
  };
}

/**
 * Compose the `agent` hooks of all workflow interceptors into a single
 * generator chain.
 */
function composeAgentHook(
  interceptors: WorkflowInterceptor[],
): ComposedWorkflowInterceptor['agent'] {
  return function* composedAgent(
    interception: AgentInterception,
    execute: (interception: AgentInterception) => Generator<unknown, unknown, unknown>,
  ): Generator<unknown, unknown, unknown> {
    type Next = (ctx: AgentInterception) => Generator<unknown, unknown, unknown>;

    let chain: Next = execute;

    for (let i = interceptors.length - 1; i >= 0; i--) {
      const interceptor = interceptors[i]!;

      if (interceptor.agent) {
        const innerNext = chain;
        const bound = interceptor.agent.bind(interceptor);
        chain = function* (ctx: AgentInterception): Generator<unknown, unknown, unknown> {
          return yield* bound(ctx, innerNext);
        };
      }
    }

    return yield* chain(interception);
  };
}

/**
 * Compose the `query` hooks of all workflow interceptors into a single
 * generator chain.
 */
function composeQueryHook(
  interceptors: WorkflowInterceptor[],
): ComposedWorkflowInterceptor['query'] {
  return function* composedQuery(
    interception: QueryInterception,
    execute: (interception: QueryInterception) => Generator<unknown, unknown, unknown>,
  ): Generator<unknown, unknown, unknown> {
    type Next = (ctx: QueryInterception) => Generator<unknown, unknown, unknown>;

    let chain: Next = execute;

    for (let i = interceptors.length - 1; i >= 0; i--) {
      const interceptor = interceptors[i]!;

      if (interceptor.query) {
        const innerNext = chain;
        const bound = interceptor.query.bind(interceptor);
        chain = function* (ctx: QueryInterception): Generator<unknown, unknown, unknown> {
          return yield* bound(ctx, innerNext);
        };
      }
    }

    return yield* chain(interception);
  };
}

/**
 * Compose the `signalReceived` hooks of all workflow interceptors into a
 * single chain.
 */
function composeSignalReceivedHook(
  interceptors: WorkflowInterceptor[],
): ComposedWorkflowInterceptor['signalReceived'] {
  return function composedSignalReceived(
    interception: SignalReceivedInterception,
    execute: (interception: SignalReceivedInterception) => void,
  ): void {
    type Next = (ctx: SignalReceivedInterception) => void;

    let chain: Next = execute;

    for (let i = interceptors.length - 1; i >= 0; i--) {
      const interceptor = interceptors[i]!;

      if (interceptor.signalReceived) {
        const innerNext = chain;
        const bound = interceptor.signalReceived.bind(interceptor);
        chain = (ctx: SignalReceivedInterception): void => {
          bound(ctx, innerNext);
        };
      }
    }

    chain(interception);
  };
}

/**
 * Compose multiple workflow interceptors into a single interceptor chain.
 *
 * @example
 * ```ts
 * import { composeWorkflowInterceptors, type WorkflowInterceptor } from 'weft';
 *
 * const tracing: WorkflowInterceptor = {
 *   *activity(ctx, next) {
 *     console.log('start', ctx.activityName);
 *     const result = yield* next(ctx);
 *     console.log('end', ctx.activityName);
 *     return result;
 *   },
 * };
 * const composed = composeWorkflowInterceptors([tracing]);
 * void composed;
 * ```
 */
export function composeWorkflowInterceptors(
  interceptors: WorkflowInterceptor[],
): ComposedWorkflowInterceptor {
  return {
    activity: composeActivityHook(interceptors),
    sleep: composeSleepHook(interceptors),
    waitForSignal: composeWaitForSignalHook(interceptors),
    workflowStart: composeWorkflowStartHook(interceptors),
    childWorkflow: composeChildWorkflowHook(interceptors),
    agent: composeAgentHook(interceptors),
    query: composeQueryHook(interceptors),
    signalReceived: composeSignalReceivedHook(interceptors),
  };
}

// ---------------------------------------------------------------------------
// Composition: activity interceptors
// ---------------------------------------------------------------------------

/**
 * Compose multiple activity interceptors into a single interceptor chain.
 *
 * @example
 * ```ts
 * import { composeActivityInterceptors, type ActivityInterceptor } from 'weft';
 *
 * const retryLogger: ActivityInterceptor = {
 *   async execute(ctx, next) {
 *     const result = await next(ctx);
 *     console.log(ctx.activityName, 'attempt', ctx.attempt, 'succeeded');
 *     return result;
 *   },
 * };
 * const composed = composeActivityInterceptors([retryLogger]);
 * void composed;
 * ```
 */
export function composeActivityInterceptors(
  interceptors: ActivityInterceptor[],
): ComposedActivityInterceptor {
  return {
    async execute(
      interception: ActivityExecutionInterception,
      execute: (interception: ActivityExecutionInterception) => Promise<unknown>,
    ): Promise<unknown> {
      type Next = (ctx: ActivityExecutionInterception) => Promise<unknown>;

      let chain: Next = execute;

      for (let i = interceptors.length - 1; i >= 0; i--) {
        const interceptor = interceptors[i]!;

        if (interceptor.execute) {
          const innerNext = chain;
          const bound = interceptor.execute.bind(interceptor);
          chain = (ctx: ActivityExecutionInterception): Promise<unknown> => {
            return bound(ctx, innerNext);
          };
        }
      }

      return chain(interception);
    },
  };
}
