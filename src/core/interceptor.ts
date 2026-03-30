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

export interface ActivityInterception {
  activityName: string;
  input: unknown;
  attempt: number;
  headers: Map<string, string>;
}

export interface SleepInterception {
  duration: number;
  headers: Map<string, string>;
}

export interface SignalInterception {
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

export interface AgentInterception {
  model: string;
  prompt: string;
  headers: Map<string, string>;
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

/** Compose multiple workflow interceptors into a single interceptor chain. */
export function composeWorkflowInterceptors(
  interceptors: WorkflowInterceptor[],
): ComposedWorkflowInterceptor {
  return {
    activity: composeActivityHook(interceptors),
    sleep: composeSleepHook(interceptors),
    waitForSignal: composeWaitForSignalHook(interceptors),
    workflowStart: composeWorkflowStartHook(interceptors),
    agent: composeAgentHook(interceptors),
    query: composeQueryHook(interceptors),
    signalReceived: composeSignalReceivedHook(interceptors),
  };
}

// ---------------------------------------------------------------------------
// Composition: activity interceptors
// ---------------------------------------------------------------------------

/** Compose multiple activity interceptors into a single interceptor chain. */
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
