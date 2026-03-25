import { describe, expect, it } from 'bun:test';

import { Context, type ContextOperationRequest } from './context.ts';
import type { SearchAttributeValue } from './types.ts';

function createContext(overrides: Partial<ConstructorParameters<typeof Context>[0]> = {}) {
  return new Context({
    workflowId: 'wf-test-123',
    workflowType: 'test-workflow',
    startedAt: 1000,
    abortController: new AbortController(),
    ...overrides,
  });
}

const UUID_PATTERN = /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i;

// Helper functions used as activity stubs (at module scope to satisfy consistent-function-scoping)
function greet(...args: unknown[]) {
  return `Hello, ${String(args[0])}!`;
}

function sendEmail(...args: unknown[]) {
  return `Sent to ${String(args[0])}`;
}

function taskA() {
  return 'a';
}

function taskB() {
  return 'b';
}

function task() {
  return 'result';
}

const handler = (payload: unknown) => payload;
const accessor = () => 42;

/** Narrow a yielded ContextOperationRequest by its type discriminant. */
function expectRequest<T extends ContextOperationRequest['type']>(
  yielded: IteratorResult<ContextOperationRequest, unknown>,
  expectedType: T,
): Extract<ContextOperationRequest, { type: T }> {
  expect(yielded.done).toBe(false);
  const request = yielded.value as ContextOperationRequest;
  expect(request.type).toBe(expectedType);
  return request as Extract<ContextOperationRequest, { type: T }>;
}

describe('Context', () => {
  describe('ctx.run', () => {
    it('yields an activity request', () => {
      const context = createContext();

      const generator = context.run(greet, 'Alice');
      const request = expectRequest(generator.next(), 'activity');

      expect(request.activityName).toBe('greet');
      expect(request.fn).toBe(greet);
      expect(request.args).toEqual(['Alice']);
    });

    it('returns the fed-back result', () => {
      const context = createContext();

      const generator = context.run(greet, 'Alice');
      generator.next(); // yield

      const result = generator.next('Hello, Alice!');
      expect(result.done).toBe(true);
      expect(result.value).toBe('Hello, Alice!');
    });

    it('on recovery returns cached result without yielding', () => {
      const accumulatedResults = new Map<number, unknown>();
      accumulatedResults.set(0, 'cached-result');
      const context = createContext({ accumulatedResults });

      const generator = context.run(greet, 'Alice');
      const result = generator.next();

      expect(result.done).toBe(true);
      expect(result.value).toBe('cached-result');
    });

    it('derives activity name from function name', () => {
      const context = createContext();

      const generator = context.run(sendEmail, 'bob@example.com');
      const request = expectRequest(generator.next(), 'activity');

      expect(request.activityName).toBe('sendEmail');
    });
  });

  describe('ctx.sleep', () => {
    it('yields a sleep request with parsed duration from string', () => {
      const now = 1_000_000;
      const context = createContext({ getNow: () => now });

      const generator = context.sleep('1 hour');
      const request = expectRequest(generator.next(), 'sleep');

      expect(request.duration).toBe(3_600_000);
      expect(request.scheduledFireAt).toBe(now + 3_600_000);
    });

    it('yields a sleep request with numeric duration', () => {
      const now = 1_000_000;
      const context = createContext({ getNow: () => now });

      const generator = context.sleep(5000);
      const request = expectRequest(generator.next(), 'sleep');

      expect(request.duration).toBe(5000);
      expect(request.scheduledFireAt).toBe(now + 5000);
    });
  });

  describe('ctx.waitForSignal', () => {
    it('yields a wait-signal request with the signal name', () => {
      const context = createContext();

      const generator = context.waitForSignal('approval');
      const request = expectRequest(generator.next(), 'wait-signal');

      expect(request.signalName).toBe('approval');
    });
  });

  describe('ctx.all', () => {
    it('yields a parallel request containing sub-operations', () => {
      const context = createContext();

      const generator = context.all([context.run(taskA), context.run(taskB)]);
      const request = expectRequest(generator.next(), 'parallel');

      expect(request.operations).toHaveLength(2);
      expect(request.operations[0]!.type).toBe('activity');
      expect(request.operations[1]!.type).toBe('activity');
    });
  });

  describe('ctx.race', () => {
    it('yields a race request containing sub-operations', () => {
      const context = createContext();

      const generator = context.race([context.run(taskA), context.run(taskB)]);
      const request = expectRequest(generator.next(), 'race');

      expect(request.operations).toHaveLength(2);
    });
  });

  describe('ctx.memo', () => {
    it('returns cached value on second call without re-yielding', () => {
      const context = createContext();

      let _callCount = 0;
      const compute = () => {
        _callCount++;
        return 42;
      };

      // First call: yields
      const generator1 = context.memo('key1', compute);
      const yielded = generator1.next();
      expect(yielded.done).toBe(false);
      const request = yielded.value as ContextOperationRequest;
      expect(request.type).toBe('memo');
      // Feed the result back
      const result1 = generator1.next(42);
      expect(result1.done).toBe(true);
      expect(result1.value).toBe(42);

      // Second call: returns from memo cache without yielding
      const generator2 = context.memo('key1', compute);
      const result2 = generator2.next();
      expect(result2.done).toBe(true);
      expect(result2.value).toBe(42);
    });

    it('on recovery returns checkpoint-cached value', () => {
      const accumulatedResults = new Map<number, unknown>();
      accumulatedResults.set(0, 'recovered-value');
      const context = createContext({ accumulatedResults });

      const generator = context.memo('key1', () => 'computed');
      const result = generator.next();

      expect(result.done).toBe(true);
      expect(result.value).toBe('recovered-value');
    });
  });

  describe('ctx.waitForUpdate', () => {
    it('yields a wait-update request', () => {
      const context = createContext();

      const generator = context.waitForUpdate('updateName');
      const request = expectRequest(generator.next(), 'wait-update');

      expect(request.updateName).toBe('updateName');
    });
  });

  describe('setAttribute / getAttribute', () => {
    it('stores and retrieves an attribute', () => {
      const context = createContext();
      context.setAttribute('region', 'us-east-1');
      expect(context.getAttribute('region')).toBe('us-east-1');
    });

    it('setAttributes merges with existing attributes', () => {
      const context = createContext();
      context.setAttribute('region', 'us-east-1');
      context.setAttributes({ priority: 5, region: 'eu-west-1' });

      expect(context.getAttribute('region')).toBe('eu-west-1');
      expect(context.getAttribute('priority')).toBe(5);
    });

    it('getAttributes returns a readonly copy that cannot mutate internal state', () => {
      const context = createContext();
      context.setAttribute('key', 'value');

      const attributes = context.getAttributes() as Record<string, SearchAttributeValue>;
      attributes['key'] = 'mutated';

      expect(context.getAttribute('key')).toBe('value');
    });
  });

  describe('ctx.onUpdate', () => {
    it('registers an update handler', () => {
      const context = createContext();
      context.onUpdate('myUpdate', handler);

      expect(context.updateHandlers.get('myUpdate')).toBe(handler);
    });
  });

  describe('ctx.expose', () => {
    it('stores accessor functions', () => {
      const context = createContext();
      context.expose({ counter: accessor });

      expect(context.exposedAccessors.get('counter')).toBe(accessor);
    });
  });

  describe('ctx.signal', () => {
    it('returns an AbortSignal', () => {
      const context = createContext();
      expect(context.signal).toBeInstanceOf(AbortSignal);
    });
  });

  describe('ctx.executionTimeRemaining', () => {
    it('returns the time remaining when deadline is set', () => {
      const now = 10_000;
      const deadline = 20_000;
      const context = createContext({ deadline, getNow: () => now });

      expect(context.executionTimeRemaining).toBe(10_000);
    });

    it('returns Infinity when no deadline is set', () => {
      const context = createContext();
      expect(context.executionTimeRemaining).toBe(Infinity);
    });
  });

  describe('step index', () => {
    it('increments monotonically across different operations', () => {
      const context = createContext();

      // Step 0: run
      const runGenerator = context.run(taskA);
      runGenerator.next();
      runGenerator.next('result-a');

      // Step 1: sleep
      const sleepGenerator = context.sleep(1000);
      sleepGenerator.next();
      sleepGenerator.next(undefined);

      // Step 2: run
      const runGenerator2 = context.run(taskB);
      runGenerator2.next();
      runGenerator2.next('result-b');

      expect(context.stepIndex).toBe(3);
    });
  });

  describe('operationId', () => {
    it('is a valid UUID', () => {
      const context = createContext();

      const generator = context.run(task);
      const request = expectRequest(generator.next(), 'activity');

      expect(request.operationId).toMatch(UUID_PATTERN);
    });
  });

  describe('pendingAttributeChanges', () => {
    it('tracks attribute changes separately', () => {
      const context = createContext();
      context.setAttribute('key', 'value');

      expect(context.pendingAttributeChanges).toEqual({ key: 'value' });
    });
  });

  describe('constructor options', () => {
    it('initializes with provided search attributes', () => {
      const context = createContext({
        searchAttributes: { region: 'us-east-1' },
      });
      expect(context.getAttribute('region')).toBe('us-east-1');
    });

    it('initializes with a provided initial step', () => {
      const context = createContext({ initialStep: 5 });
      expect(context.stepIndex).toBe(5);
    });
  });
});
