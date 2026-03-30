import { describe, expect, it } from 'bun:test';

import type {
  ActivityExecutionInterception,
  ActivityInterception,
  ActivityInterceptor,
  AgentInterception,
  QueryInterception,
  SignalInterception,
  SignalReceivedInterception,
  SleepInterception,
  WorkflowInterceptor,
  WorkflowStartInterception,
} from './interceptor';
import { composeActivityInterceptors, composeWorkflowInterceptors } from './interceptor';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeHeaders(entries?: [string, string][]): Map<string, string> {
  return new Map(entries);
}

function makeActivityInterception(overrides?: Partial<ActivityInterception>): ActivityInterception {
  return {
    activityName: 'doWork',
    input: { value: 1 },
    attempt: 1,
    headers: makeHeaders(),
    ...overrides,
  };
}

function makeSleepInterception(overrides?: Partial<SleepInterception>): SleepInterception {
  return {
    duration: 1000,
    headers: makeHeaders(),
    ...overrides,
  };
}

function makeSignalInterception(overrides?: Partial<SignalInterception>): SignalInterception {
  return {
    signalName: 'approval',
    payload: null,
    headers: makeHeaders(),
    ...overrides,
  };
}

function makeWorkflowStartInterception(
  overrides?: Partial<WorkflowStartInterception>,
): WorkflowStartInterception {
  return {
    workflowId: 'wf-1',
    workflowType: 'orderFlow',
    input: { orderId: 42 },
    headers: makeHeaders(),
    ...overrides,
  };
}

function makeActivityExecutionInterception(
  overrides?: Partial<ActivityExecutionInterception>,
): ActivityExecutionInterception {
  return {
    activityName: 'fetchData',
    input: { url: 'https://example.com' },
    attempt: 1,
    headers: makeHeaders(),
    ...overrides,
  };
}

function makeAgentInterception(overrides?: Partial<AgentInterception>): AgentInterception {
  return {
    model: 'claude-sonnet-4-20250514',
    prompt: 'Summarize the data',
    headers: makeHeaders(),
    ...overrides,
  };
}

function makeQueryInterception(overrides?: Partial<QueryInterception>): QueryInterception {
  return {
    queryName: 'getStatus',
    headers: makeHeaders(),
    ...overrides,
  };
}

function makeSignalReceivedInterception(
  overrides?: Partial<SignalReceivedInterception>,
): SignalReceivedInterception {
  return {
    workflowId: 'wf-1',
    signalName: 'approval',
    payload: { approved: true },
    headers: makeHeaders(),
    ...overrides,
  };
}

/** Drive a generator to completion, returning its final value. */
function runGenerator(generator: Generator<unknown, unknown, unknown>): unknown {
  let result = generator.next();
  while (!result.done) {
    result = generator.next(result.value);
  }
  return result.value;
}

// ---------------------------------------------------------------------------
// Workflow interceptor composition
// ---------------------------------------------------------------------------

describe('composeWorkflowInterceptors', () => {
  describe('activity hook', () => {
    it('calls execute directly when interceptor array is empty', () => {
      const composed = composeWorkflowInterceptors([]);
      const interception = makeActivityInterception();
      const results: string[] = [];

      function* execute(ctx: ActivityInterception): Generator<unknown, unknown, unknown> {
        results.push(`execute:${ctx.activityName}`);
        return 'result';
      }

      const generator = composed.activity(interception, execute);
      const outcome = generator.next();

      expect(outcome.done).toBe(true);
      expect(outcome.value).toBe('result');
      expect(results).toEqual(['execute:doWork']);
    });

    it('allows a single interceptor to modify activity input before next()', () => {
      const interceptor: WorkflowInterceptor = {
        *activity(ctx, next) {
          return yield* next({ ...ctx, input: 'modified' });
        },
      };

      const composed = composeWorkflowInterceptors([interceptor]);
      let capturedInput: unknown;

      function* execute(ctx: ActivityInterception): Generator<unknown, unknown, unknown> {
        capturedInput = ctx.input;
        return 'done';
      }

      const generator = composed.activity(makeActivityInterception(), execute);
      generator.next();

      expect(capturedInput).toBe('modified');
    });

    it('allows a single interceptor to modify the result after next()', () => {
      const interceptor: WorkflowInterceptor = {
        *activity(ctx, next) {
          const result = yield* next(ctx);
          return `wrapped(${String(result)})`;
        },
      };

      const composed = composeWorkflowInterceptors([interceptor]);

      function* execute(_ctx: ActivityInterception): Generator<unknown, unknown, unknown> {
        return 'original';
      }

      const generator = composed.activity(makeActivityInterception(), execute);
      const outcome = generator.next();

      expect(outcome.done).toBe(true);
      expect(outcome.value).toBe('wrapped(original)');
    });

    it('composes two interceptors in order (first is outermost)', () => {
      const order: string[] = [];

      const first: WorkflowInterceptor = {
        *activity(ctx, next) {
          order.push('first:before');
          const result = yield* next(ctx);
          order.push('first:after');
          return result;
        },
      };

      const second: WorkflowInterceptor = {
        *activity(ctx, next) {
          order.push('second:before');
          const result = yield* next(ctx);
          order.push('second:after');
          return result;
        },
      };

      const composed = composeWorkflowInterceptors([first, second]);

      function* execute(_ctx: ActivityInterception): Generator<unknown, unknown, unknown> {
        order.push('execute');
        return 'value';
      }

      const generator = composed.activity(makeActivityInterception(), execute);
      generator.next();

      expect(order).toEqual([
        'first:before',
        'second:before',
        'execute',
        'second:after',
        'first:after',
      ]);
    });

    it('allows an interceptor to skip next() and return early', () => {
      const interceptor: WorkflowInterceptor = {
        *activity(_ctx, _next) {
          return 'short-circuited';
        },
      };

      const composed = composeWorkflowInterceptors([interceptor]);
      let executeCalled = false;

      function* execute(_ctx: ActivityInterception): Generator<unknown, unknown, unknown> {
        executeCalled = true;
        return 'never reached';
      }

      const generator = composed.activity(makeActivityInterception(), execute);
      const outcome = generator.next();

      expect(outcome.done).toBe(true);
      expect(outcome.value).toBe('short-circuited');
      expect(executeCalled).toBe(false);
    });

    it('makes headers set in one interceptor visible in the next', () => {
      const first: WorkflowInterceptor = {
        *activity(ctx, next) {
          ctx.headers.set('x-trace-id', 'abc-123');
          return yield* next(ctx);
        },
      };

      let capturedTraceId: string | undefined;

      const second: WorkflowInterceptor = {
        *activity(ctx, next) {
          capturedTraceId = ctx.headers.get('x-trace-id');
          return yield* next(ctx);
        },
      };

      const composed = composeWorkflowInterceptors([first, second]);

      function* execute(_ctx: ActivityInterception): Generator<unknown, unknown, unknown> {
        return 'ok';
      }

      const generator = composed.activity(makeActivityInterception(), execute);
      generator.next();

      expect(capturedTraceId).toBe('abc-123');
    });

    it('propagates errors from an interceptor to the caller', () => {
      const interceptor: WorkflowInterceptor = {
        *activity(_ctx, _next) {
          throw new Error('interceptor boom');
        },
      };

      const composed = composeWorkflowInterceptors([interceptor]);

      function* execute(_ctx: ActivityInterception): Generator<unknown, unknown, unknown> {
        return 'ok';
      }

      const generator = composed.activity(makeActivityInterception(), execute);

      expect(() => generator.next()).toThrow('interceptor boom');
    });

    it('passes through when an interceptor does not define the hook', () => {
      const emptyInterceptor: WorkflowInterceptor = {};

      const composed = composeWorkflowInterceptors([emptyInterceptor]);
      const results: string[] = [];

      function* execute(ctx: ActivityInterception): Generator<unknown, unknown, unknown> {
        results.push(`execute:${ctx.activityName}`);
        return 'passthrough';
      }

      const generator = composed.activity(makeActivityInterception(), execute);
      const outcome = generator.next();

      expect(outcome.done).toBe(true);
      expect(outcome.value).toBe('passthrough');
      expect(results).toEqual(['execute:doWork']);
    });

    it('handles a mix of interceptors where some have hooks and others do not', () => {
      const order: string[] = [];

      const withHook: WorkflowInterceptor = {
        *activity(ctx, next) {
          order.push('withHook');
          return yield* next(ctx);
        },
      };

      const withoutHook: WorkflowInterceptor = {};

      const anotherWithHook: WorkflowInterceptor = {
        *activity(ctx, next) {
          order.push('anotherWithHook');
          return yield* next(ctx);
        },
      };

      const composed = composeWorkflowInterceptors([withHook, withoutHook, anotherWithHook]);

      function* execute(_ctx: ActivityInterception): Generator<unknown, unknown, unknown> {
        order.push('execute');
        return 'done';
      }

      const generator = composed.activity(makeActivityInterception(), execute);
      generator.next();

      expect(order).toEqual(['withHook', 'anotherWithHook', 'execute']);
    });
  });

  describe('sleep hook', () => {
    it('allows an interceptor to modify the duration', () => {
      const interceptor: WorkflowInterceptor = {
        *sleep(ctx, next) {
          yield* next({ ...ctx, duration: ctx.duration * 2 });
        },
      };

      const composed = composeWorkflowInterceptors([interceptor]);
      let capturedDuration: number | undefined;

      function* execute(ctx: SleepInterception): Generator<unknown, void, unknown> {
        capturedDuration = ctx.duration;
      }

      const generator = composed.sleep(makeSleepInterception({ duration: 500 }), execute);
      generator.next();

      expect(capturedDuration).toBe(1000);
    });
  });

  describe('waitForSignal hook', () => {
    it('calls execute directly when no interceptor defines the hook', () => {
      const composed = composeWorkflowInterceptors([{}]);
      let capturedSignalName: string | undefined;

      function* execute(ctx: SignalInterception): Generator<unknown, unknown, unknown> {
        capturedSignalName = ctx.signalName;
        return 'signal-value';
      }

      const generator = composed.waitForSignal(makeSignalInterception(), execute);
      const outcome = generator.next();

      expect(outcome.done).toBe(true);
      expect(outcome.value).toBe('signal-value');
      expect(capturedSignalName).toBe('approval');
    });

    it('allows an interceptor to modify the signal payload before next()', () => {
      const interceptor: WorkflowInterceptor = {
        *waitForSignal(ctx, next) {
          return yield* next({ ...ctx, payload: 'intercepted' });
        },
      };

      const composed = composeWorkflowInterceptors([interceptor]);
      let capturedPayload: unknown;

      function* execute(ctx: SignalInterception): Generator<unknown, unknown, unknown> {
        capturedPayload = ctx.payload;
        return 'done';
      }

      const generator = composed.waitForSignal(makeSignalInterception(), execute);
      generator.next();

      expect(capturedPayload).toBe('intercepted');
    });

    it('composes two waitForSignal interceptors in order', () => {
      const order: string[] = [];

      const first: WorkflowInterceptor = {
        *waitForSignal(ctx, next) {
          order.push('first:before');
          const result = yield* next(ctx);
          order.push('first:after');
          return result;
        },
      };

      const second: WorkflowInterceptor = {
        *waitForSignal(ctx, next) {
          order.push('second:before');
          const result = yield* next(ctx);
          order.push('second:after');
          return result;
        },
      };

      const composed = composeWorkflowInterceptors([first, second]);

      function* execute(_ctx: SignalInterception): Generator<unknown, unknown, unknown> {
        order.push('execute');
        return 'value';
      }

      const generator = composed.waitForSignal(makeSignalInterception(), execute);
      generator.next();

      expect(order).toEqual([
        'first:before',
        'second:before',
        'execute',
        'second:after',
        'first:after',
      ]);
    });
  });

  describe('workflowStart hook', () => {
    it('fires the interceptor on workflow start', () => {
      const captured: string[] = [];

      const interceptor: WorkflowInterceptor = {
        workflowStart(ctx, next) {
          captured.push(`start:${ctx.workflowType}`);
          next(ctx);
        },
      };

      const composed = composeWorkflowInterceptors([interceptor]);

      composed.workflowStart(makeWorkflowStartInterception(), (ctx) => {
        captured.push(`execute:${ctx.workflowId}`);
      });

      expect(captured).toEqual(['start:orderFlow', 'execute:wf-1']);
    });

    it('calls execute directly when interceptor array is empty', () => {
      const composed = composeWorkflowInterceptors([]);
      let executeCalled = false;

      composed.workflowStart(makeWorkflowStartInterception(), (_ctx) => {
        executeCalled = true;
      });

      expect(executeCalled).toBe(true);
    });
  });
});

// ---------------------------------------------------------------------------
// Activity interceptor composition
// ---------------------------------------------------------------------------

describe('composeActivityInterceptors', () => {
  it('calls execute directly when interceptor array is empty', async () => {
    const composed = composeActivityInterceptors([]);
    const interception = makeActivityExecutionInterception();

    const result = await composed.execute(interception, async (ctx) => {
      return `fetched:${ctx.activityName}`;
    });

    expect(result).toBe('fetched:fetchData');
  });

  it('allows a single activity interceptor to wrap execution', async () => {
    const interceptor: ActivityInterceptor = {
      async execute(ctx, next) {
        const result = await next(ctx);
        return `cached(${String(result)})`;
      },
    };

    const composed = composeActivityInterceptors([interceptor]);

    const result = await composed.execute(makeActivityExecutionInterception(), async (_ctx) => {
      return 'raw-data';
    });

    expect(result).toBe('cached(raw-data)');
  });

  it('composes two activity interceptors in order', async () => {
    const order: string[] = [];

    const first: ActivityInterceptor = {
      async execute(ctx, next) {
        order.push('first:before');
        const result = await next(ctx);
        order.push('first:after');
        return result;
      },
    };

    const second: ActivityInterceptor = {
      async execute(ctx, next) {
        order.push('second:before');
        const result = await next(ctx);
        order.push('second:after');
        return result;
      },
    };

    const composed = composeActivityInterceptors([first, second]);

    await composed.execute(makeActivityExecutionInterception(), async (_ctx) => {
      order.push('execute');
      return 'value';
    });

    expect(order).toEqual([
      'first:before',
      'second:before',
      'execute',
      'second:after',
      'first:after',
    ]);
  });

  it('passes through when an activity interceptor does not define execute', async () => {
    const emptyInterceptor: ActivityInterceptor = {};

    const composed = composeActivityInterceptors([emptyInterceptor]);

    const result = await composed.execute(makeActivityExecutionInterception(), async (ctx) => {
      return `direct:${ctx.activityName}`;
    });

    expect(result).toBe('direct:fetchData');
  });
});

// ---------------------------------------------------------------------------
// Agent hook composition
// ---------------------------------------------------------------------------

describe('composeWorkflowInterceptors — agent hook', () => {
  it('calls execute directly when interceptor array is empty', () => {
    const composed = composeWorkflowInterceptors([]);

    const generator = composed.agent(makeAgentInterception(), function* (ctx) {
      return `result:${ctx.model}`;
    });

    const result = runGenerator(generator);
    expect(result).toBe('result:claude-sonnet-4-20250514');
  });

  it('single interceptor can modify context before calling next', () => {
    const interceptor: WorkflowInterceptor = {
      *agent(interception, next) {
        return yield* next({ ...interception, model: 'gpt-4o' });
      },
    };

    const composed = composeWorkflowInterceptors([interceptor]);

    const generator = composed.agent(makeAgentInterception(), function* (ctx) {
      return `result:${ctx.model}`;
    });

    const result = runGenerator(generator);
    expect(result).toBe('result:gpt-4o');
  });

  it('two interceptors compose in correct order (first = outermost)', () => {
    const order: string[] = [];

    const first: WorkflowInterceptor = {
      *agent(interception, next) {
        order.push('first:before');
        const result = yield* next(interception);
        order.push('first:after');
        return result;
      },
    };

    const second: WorkflowInterceptor = {
      *agent(interception, next) {
        order.push('second:before');
        const result = yield* next(interception);
        order.push('second:after');
        return result;
      },
    };

    const composed = composeWorkflowInterceptors([first, second]);

    const generator = composed.agent(makeAgentInterception(), function* () {
      order.push('execute');
      return 'done';
    });

    runGenerator(generator);
    expect(order).toEqual([
      'first:before',
      'second:before',
      'execute',
      'second:after',
      'first:after',
    ]);
  });

  it('passes through when interceptor does not define agent hook', () => {
    const empty: WorkflowInterceptor = {};

    const composed = composeWorkflowInterceptors([empty]);

    const generator = composed.agent(makeAgentInterception(), function* (ctx) {
      return `pass:${ctx.prompt}`;
    });

    const result = runGenerator(generator);
    expect(result).toBe('pass:Summarize the data');
  });

  it('propagates headers between interceptors', () => {
    const interceptor: WorkflowInterceptor = {
      *agent(interception, next) {
        interception.headers.set('x-trace', 'abc');
        return yield* next(interception);
      },
    };

    const composed = composeWorkflowInterceptors([interceptor]);
    let capturedHeaders: Map<string, string> | undefined;

    const generator = composed.agent(makeAgentInterception(), function* (ctx) {
      capturedHeaders = ctx.headers;
      return 'done';
    });

    runGenerator(generator);
    expect(capturedHeaders?.get('x-trace')).toBe('abc');
  });

  it('propagates errors from interceptor', () => {
    const interceptor: WorkflowInterceptor = {
      *agent() {
        throw new Error('agent interceptor error');
      },
    };

    const composed = composeWorkflowInterceptors([interceptor]);

    const generator = composed.agent(makeAgentInterception(), function* () {
      return 'unreachable';
    });

    expect(() => runGenerator(generator)).toThrow('agent interceptor error');
  });

  it('interceptor can skip next() and return early', () => {
    const interceptor: WorkflowInterceptor = {
      *agent() {
        return 'cached-response';
      },
    };

    const composed = composeWorkflowInterceptors([interceptor]);
    let executeCalled = false;

    const generator = composed.agent(makeAgentInterception(), function* () {
      executeCalled = true;
      return 'unreachable';
    });

    const result = runGenerator(generator);
    expect(result).toBe('cached-response');
    expect(executeCalled).toBe(false);
  });

  it('mixed interceptors where some define agent and some do not', () => {
    const order: string[] = [];

    const withHook: WorkflowInterceptor = {
      *agent(interception, next) {
        order.push('with:before');
        const result = yield* next(interception);
        order.push('with:after');
        return result;
      },
    };

    const withoutHook: WorkflowInterceptor = {};

    const composed = composeWorkflowInterceptors([withHook, withoutHook]);

    const generator = composed.agent(makeAgentInterception(), function* () {
      order.push('execute');
      return 'done';
    });

    runGenerator(generator);
    expect(order).toEqual(['with:before', 'execute', 'with:after']);
  });

  it('three interceptors compose in correct order (first = outermost)', () => {
    const order: string[] = [];

    const first: WorkflowInterceptor = {
      *agent(interception, next) {
        order.push('first:before');
        const result = yield* next(interception);
        order.push('first:after');
        return result;
      },
    };

    const second: WorkflowInterceptor = {
      *agent(interception, next) {
        order.push('second:before');
        const result = yield* next(interception);
        order.push('second:after');
        return result;
      },
    };

    const third: WorkflowInterceptor = {
      *agent(interception, next) {
        order.push('third:before');
        const result = yield* next(interception);
        order.push('third:after');
        return result;
      },
    };

    const composed = composeWorkflowInterceptors([first, second, third]);

    const generator = composed.agent(makeAgentInterception(), function* () {
      order.push('execute');
      return 'done';
    });

    runGenerator(generator);
    expect(order).toEqual([
      'first:before',
      'second:before',
      'third:before',
      'execute',
      'third:after',
      'second:after',
      'first:after',
    ]);
  });

  it('interceptor can modify the agent prompt before calling next', () => {
    const interceptor: WorkflowInterceptor = {
      *agent(interception, next) {
        return yield* next({
          ...interception,
          prompt: `[SYSTEM] ${interception.prompt}`,
        });
      },
    };

    const composed = composeWorkflowInterceptors([interceptor]);
    let capturedPrompt: string | undefined;

    const generator = composed.agent(makeAgentInterception(), function* (ctx) {
      capturedPrompt = ctx.prompt;
      return 'done';
    });

    runGenerator(generator);
    expect(capturedPrompt).toBe('[SYSTEM] Summarize the data');
  });

  it('interceptor sets headers that are visible in execute', () => {
    const interceptor: WorkflowInterceptor = {
      *agent(interception, next) {
        interception.headers.set('x-request-id', 'req-42');
        interception.headers.set('x-org-id', 'org-7');
        return yield* next(interception);
      },
    };

    const composed = composeWorkflowInterceptors([interceptor]);
    let capturedHeaders: Map<string, string> | undefined;

    const generator = composed.agent(makeAgentInterception(), function* (ctx) {
      capturedHeaders = ctx.headers;
      return 'done';
    });

    runGenerator(generator);
    expect(capturedHeaders?.get('x-request-id')).toBe('req-42');
    expect(capturedHeaders?.get('x-org-id')).toBe('org-7');
    expect(capturedHeaders?.size).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// Query hook composition
// ---------------------------------------------------------------------------

describe('composeWorkflowInterceptors — query hook', () => {
  it('calls execute directly when interceptor array is empty', () => {
    const composed = composeWorkflowInterceptors([]);

    const generator = composed.query(makeQueryInterception(), function* (ctx) {
      return `result:${ctx.queryName}`;
    });

    const result = runGenerator(generator);
    expect(result).toBe('result:getStatus');
  });

  it('single interceptor can modify context before calling next', () => {
    const interceptor: WorkflowInterceptor = {
      *query(interception, next) {
        return yield* next({ ...interception, queryName: 'getHealth' });
      },
    };

    const composed = composeWorkflowInterceptors([interceptor]);

    const generator = composed.query(makeQueryInterception(), function* (ctx) {
      return `result:${ctx.queryName}`;
    });

    const result = runGenerator(generator);
    expect(result).toBe('result:getHealth');
  });

  it('two interceptors compose in correct order', () => {
    const order: string[] = [];

    const first: WorkflowInterceptor = {
      *query(interception, next) {
        order.push('first:before');
        const result = yield* next(interception);
        order.push('first:after');
        return result;
      },
    };

    const second: WorkflowInterceptor = {
      *query(interception, next) {
        order.push('second:before');
        const result = yield* next(interception);
        order.push('second:after');
        return result;
      },
    };

    const composed = composeWorkflowInterceptors([first, second]);

    const generator = composed.query(makeQueryInterception(), function* () {
      order.push('execute');
      return 'done';
    });

    runGenerator(generator);
    expect(order).toEqual([
      'first:before',
      'second:before',
      'execute',
      'second:after',
      'first:after',
    ]);
  });

  it('passes through when interceptor does not define query hook', () => {
    const empty: WorkflowInterceptor = {};

    const composed = composeWorkflowInterceptors([empty]);

    const generator = composed.query(makeQueryInterception(), function* (ctx) {
      return `pass:${ctx.queryName}`;
    });

    const result = runGenerator(generator);
    expect(result).toBe('pass:getStatus');
  });

  it('propagates errors from interceptor', () => {
    const interceptor: WorkflowInterceptor = {
      *query() {
        throw new Error('query interceptor error');
      },
    };

    const composed = composeWorkflowInterceptors([interceptor]);

    const generator = composed.query(makeQueryInterception(), function* () {
      return 'unreachable';
    });

    expect(() => runGenerator(generator)).toThrow('query interceptor error');
  });

  it('interceptor can skip next() and return early', () => {
    const interceptor: WorkflowInterceptor = {
      *query() {
        return 'cached-result';
      },
    };

    const composed = composeWorkflowInterceptors([interceptor]);
    let executeCalled = false;

    const generator = composed.query(makeQueryInterception(), function* () {
      executeCalled = true;
      return 'unreachable';
    });

    const result = runGenerator(generator);
    expect(result).toBe('cached-result');
    expect(executeCalled).toBe(false);
  });

  it('propagates headers between interceptors', () => {
    const interceptor: WorkflowInterceptor = {
      *query(interception, next) {
        interception.headers.set('x-query-trace', 'traced');
        return yield* next(interception);
      },
    };

    const composed = composeWorkflowInterceptors([interceptor]);
    let capturedHeaders: Map<string, string> | undefined;

    const generator = composed.query(makeQueryInterception(), function* (ctx) {
      capturedHeaders = ctx.headers;
      return 'done';
    });

    runGenerator(generator);
    expect(capturedHeaders?.get('x-query-trace')).toBe('traced');
  });
});

// ---------------------------------------------------------------------------
// SignalReceived hook composition
// ---------------------------------------------------------------------------

describe('composeWorkflowInterceptors — signalReceived hook', () => {
  it('calls execute directly when interceptor array is empty', () => {
    let called = false;
    const composed = composeWorkflowInterceptors([]);

    composed.signalReceived(makeSignalReceivedInterception(), () => {
      called = true;
    });

    expect(called).toBe(true);
  });

  it('single interceptor can observe and pass through', () => {
    const observed: string[] = [];

    const interceptor: WorkflowInterceptor = {
      signalReceived(interception, next) {
        observed.push(`signal:${interception.signalName}`);
        next(interception);
      },
    };

    const composed = composeWorkflowInterceptors([interceptor]);
    let executeCalled = false;

    composed.signalReceived(makeSignalReceivedInterception(), () => {
      executeCalled = true;
    });

    expect(observed).toEqual(['signal:approval']);
    expect(executeCalled).toBe(true);
  });

  it('two interceptors compose in correct order', () => {
    const order: string[] = [];

    const first: WorkflowInterceptor = {
      signalReceived(interception, next) {
        order.push('first');
        next(interception);
      },
    };

    const second: WorkflowInterceptor = {
      signalReceived(interception, next) {
        order.push('second');
        next(interception);
      },
    };

    const composed = composeWorkflowInterceptors([first, second]);

    composed.signalReceived(makeSignalReceivedInterception(), () => {
      order.push('execute');
    });

    expect(order).toEqual(['first', 'second', 'execute']);
  });

  it('interceptor can modify payload before passing through', () => {
    const interceptor: WorkflowInterceptor = {
      signalReceived(interception, next) {
        next({ ...interception, payload: { approved: false, reason: 'overridden' } });
      },
    };

    const composed = composeWorkflowInterceptors([interceptor]);
    let capturedPayload: unknown;

    composed.signalReceived(makeSignalReceivedInterception(), (ctx) => {
      capturedPayload = ctx.payload;
    });

    expect(capturedPayload).toEqual({ approved: false, reason: 'overridden' });
  });

  it('passes through when interceptor does not define signalReceived', () => {
    const empty: WorkflowInterceptor = {};

    const composed = composeWorkflowInterceptors([empty]);
    let called = false;

    composed.signalReceived(makeSignalReceivedInterception(), () => {
      called = true;
    });

    expect(called).toBe(true);
  });

  it('propagates headers between interceptors', () => {
    const interceptor: WorkflowInterceptor = {
      signalReceived(interception, next) {
        interception.headers.set('x-signal-trace', 'traced');
        next(interception);
      },
    };

    const composed = composeWorkflowInterceptors([interceptor]);
    let capturedHeaders: Map<string, string> | undefined;

    composed.signalReceived(makeSignalReceivedInterception(), (ctx) => {
      capturedHeaders = ctx.headers;
    });

    expect(capturedHeaders?.get('x-signal-trace')).toBe('traced');
  });

  it('interceptor can block delivery by not calling next', () => {
    const interceptor: WorkflowInterceptor = {
      signalReceived() {
        // deliberately does not call next
      },
    };

    const composed = composeWorkflowInterceptors([interceptor]);
    let executeCalled = false;

    composed.signalReceived(makeSignalReceivedInterception(), () => {
      executeCalled = true;
    });

    expect(executeCalled).toBe(false);
  });

  it('mixed interceptors where some define signalReceived and some do not', () => {
    const order: string[] = [];

    const withHook: WorkflowInterceptor = {
      signalReceived(interception, next) {
        order.push('with');
        next(interception);
      },
    };

    const withoutHook: WorkflowInterceptor = {};

    const composed = composeWorkflowInterceptors([withHook, withoutHook]);

    composed.signalReceived(makeSignalReceivedInterception(), () => {
      order.push('execute');
    });

    expect(order).toEqual(['with', 'execute']);
  });
});
