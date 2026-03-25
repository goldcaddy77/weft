import { describe, expect, it } from 'bun:test';

import type {
  ActivityExecutionInterception,
  ActivityInterception,
  ActivityInterceptor,
  SignalInterception,
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
