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
 * // Pass interceptors when constructing the engine:
 * // const engine = new Engine({ workflowInterceptors: [loggingInterceptor] });
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

export interface SleepInterception {
  workflowId: string;
  duration: number;
  headers: Map<string, string>;
}

export interface SignalInterception {
  workflowId: string;
  signalName: string;
  payload: unknown;
  headers: Map<string, string>;
}

export interface WorkflowStartInterception {
  workflowId: string;
  workflowType: string;
  input: unknown;
  headers: Map<string, string>;
}

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

export interface ChildWorkflowInterception {
  workflowId: string;
  childWorkflowId: string;
  workflowType: string;
  input: unknown;
  headers: Map<string, string>;
  /** Headers from the parent workflow, used for span link creation. */
  parentHeaders: Map<string, string>;
}

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

export interface QueryInterception {
  queryName: string;
  headers: Map<string, string>;
}

export interface SignalReceivedInterception {
  workflowId: string;
  signalName: string;
  payload: unknown;
  headers: Map<string, string>;
}

// ---------------------------------------------------------------------------
// Interceptor interfaces
// ---------------------------------------------------------------------------

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

export interface ActivityInterceptor {
  execute?(
    interception: ActivityExecutionInterception,
    next: (interception: ActivityExecutionInterception) => Promise<unknown>,
  ): Promise<unknown>;
}

// ---------------------------------------------------------------------------
// Composed interceptor interfaces
// ---------------------------------------------------------------------------

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
