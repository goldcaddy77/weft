import { afterEach, describe, expect, it } from 'bun:test';

import { InlineExecutionStrategy } from './inline-execution-strategy.ts';
import type { WorkerOutboundMessage, WorkflowFunction } from './types.ts';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createStrategy(
  registrations: Map<string, { handler: WorkflowFunction; version: string }>,
): InlineExecutionStrategy {
  return new InlineExecutionStrategy({
    getRegistration: (type: string) => registrations.get(type),
    getNow: Date.now,
    maxNestingDepth: 10,
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('InlineExecutionStrategy', () => {
  let strategy: InlineExecutionStrategy;
  let messages: WorkerOutboundMessage[];
  let registrations: Map<string, { handler: WorkflowFunction; version: string }>;

  afterEach(() => {
    strategy?.[Symbol.dispose]();
  });

  function setup(): void {
    registrations = new Map();
    strategy = createStrategy(registrations);
    messages = [];
    strategy.onMessage((message) => messages.push(message));
  }

  /** Return the first message, asserting it exists. */
  function firstMessage(): WorkerOutboundMessage {
    expect(messages).toHaveLength(1);
    const message = messages[0];
    expect(message).toBeDefined();
    return message!;
  }

  // -------------------------------------------------------------------------
  // startWorkflow
  // -------------------------------------------------------------------------

  describe('startWorkflow', () => {
    it('emits completed for a workflow that returns immediately', async () => {
      setup();

      registrations.set('immediate', {
        handler: async function* (_context, _input) {
          return 'done';
        },
        version: '1',
      });

      strategy.startWorkflow({
        workflowId: 'wf-1',
        workflowType: 'immediate',
        input: null,
        checkpoint: new ArrayBuffer(0),
      });

      // Allow microtask to complete
      await Bun.sleep(10);

      const message = firstMessage();
      expect(message.type).toBe('completed');
      if (message.type === 'completed') {
        expect(message.result).toBe('done');
      }
    });

    it('emits checkpoint for a workflow that yields', async () => {
      setup();

      registrations.set('yielding', {
        handler: async function* (_context, _input) {
          const value: unknown = yield {
            type: 'activity',
            operationId: 'op-1',
            activityName: 'doWork',
            fn: () => 42,
            args: [],
          };
          return value;
        },
        version: '1',
      });

      strategy.startWorkflow({
        workflowId: 'wf-1',
        workflowType: 'yielding',
        input: null,
        checkpoint: new ArrayBuffer(0),
      });

      await Bun.sleep(10);

      const message = firstMessage();
      expect(message.type).toBe('checkpoint');
    });

    it('emits failed for unknown workflow types', async () => {
      setup();

      strategy.startWorkflow({
        workflowId: 'wf-1',
        workflowType: 'nonexistent',
        input: null,
        checkpoint: new ArrayBuffer(0),
      });

      await Bun.sleep(10);

      const message = firstMessage();
      expect(message.type).toBe('failed');
      if (message.type === 'failed') {
        expect(message.error).toContain('No workflow registered');
      }
    });

    it('emits failed when the generator throws', async () => {
      setup();

      registrations.set('failing', {
        handler: async function* () {
          throw new Error('boom');
        },
        version: '1',
      });

      strategy.startWorkflow({
        workflowId: 'wf-1',
        workflowType: 'failing',
        input: null,
        checkpoint: new ArrayBuffer(0),
      });

      await Bun.sleep(10);

      const message = firstMessage();
      expect(message.type).toBe('failed');
      if (message.type === 'failed') {
        expect(message.error).toBe('boom');
      }
    });
  });

  // -------------------------------------------------------------------------
  // continueWorkflow
  // -------------------------------------------------------------------------

  describe('continueWorkflow', () => {
    it('feeds a value into the generator and emits completed', async () => {
      setup();

      registrations.set('yielding', {
        handler: async function* (_context, _input) {
          const value: unknown = yield {
            type: 'activity',
            operationId: 'op-1',
            activityName: 'doWork',
            fn: () => {},
            args: [],
          };
          return `got:${String(value)}`;
        },
        version: '1',
      });

      strategy.startWorkflow({
        workflowId: 'wf-1',
        workflowType: 'yielding',
        input: null,
        checkpoint: new ArrayBuffer(0),
      });

      await Bun.sleep(10);
      messages.length = 0;

      strategy.continueWorkflow('wf-1', 42);

      await Bun.sleep(10);

      const message = firstMessage();
      expect(message.type).toBe('completed');
      if (message.type === 'completed') {
        expect(message.result).toBe('got:42');
      }
    });
  });

  // -------------------------------------------------------------------------
  // throwIntoWorkflow
  // -------------------------------------------------------------------------

  describe('throwIntoWorkflow', () => {
    it('propagates an error and emits failed when unhandled', async () => {
      setup();

      registrations.set('yielding', {
        handler: async function* (_context, _input) {
          const value: unknown = yield {
            type: 'activity',
            operationId: 'op-1',
            activityName: 'doWork',
            fn: () => {},
            args: [],
          };
          return value;
        },
        version: '1',
      });

      strategy.startWorkflow({
        workflowId: 'wf-1',
        workflowType: 'yielding',
        input: null,
        checkpoint: new ArrayBuffer(0),
      });

      await Bun.sleep(10);
      messages.length = 0;

      strategy.throwIntoWorkflow('wf-1', new Error('activity failed'));

      await Bun.sleep(10);

      const message = firstMessage();
      expect(message.type).toBe('failed');
      if (message.type === 'failed') {
        expect(message.error).toBe('activity failed');
      }
    });

    it('allows the generator to catch and recover', async () => {
      setup();

      registrations.set('resilient', {
        handler: async function* (_context, _input) {
          try {
            yield {
              type: 'activity',
              operationId: 'op-1',
              activityName: 'mayFail',
              fn: () => {},
              args: [],
            };
          } catch {
            return 'recovered';
          }
          return 'unreachable';
        },
        version: '1',
      });

      strategy.startWorkflow({
        workflowId: 'wf-1',
        workflowType: 'resilient',
        input: null,
        checkpoint: new ArrayBuffer(0),
      });

      await Bun.sleep(10);
      messages.length = 0;

      strategy.throwIntoWorkflow('wf-1', new Error('oops'));

      await Bun.sleep(10);

      const message = firstMessage();
      expect(message.type).toBe('completed');
      if (message.type === 'completed') {
        expect(message.result).toBe('recovered');
      }
    });
  });

  // -------------------------------------------------------------------------
  // cancelWorkflow
  // -------------------------------------------------------------------------

  describe('cancelWorkflow', () => {
    it('cleans up the generator and context', async () => {
      setup();

      registrations.set('yielding', {
        handler: async function* (_context, _input) {
          yield {
            type: 'activity',
            operationId: 'op-1',
            activityName: 'doWork',
            fn: () => {},
            args: [],
          };
        },
        version: '1',
      });

      strategy.startWorkflow({
        workflowId: 'wf-1',
        workflowType: 'yielding',
        input: null,
        checkpoint: new ArrayBuffer(0),
      });

      await Bun.sleep(10);

      expect(strategy.hasGenerator('wf-1')).toBe(true);
      expect(strategy.getContext('wf-1')).toBeDefined();
      expect(strategy.getAbortController('wf-1')).toBeDefined();

      strategy.cancelWorkflow('wf-1');

      expect(strategy.hasGenerator('wf-1')).toBe(false);
      expect(strategy.getContext('wf-1')).toBeUndefined();
      expect(strategy.getAbortController('wf-1')).toBeUndefined();
    });
  });

  // -------------------------------------------------------------------------
  // resumeWorkflow (via the ExecutionStrategy interface)
  // -------------------------------------------------------------------------

  describe('resumeWorkflow', () => {
    it('feeds a completed result into the generator', async () => {
      setup();

      registrations.set('yielding', {
        handler: async function* (_context, _input) {
          const value: unknown = yield {
            type: 'activity',
            operationId: 'op-1',
            activityName: 'doWork',
            fn: () => {},
            args: [],
          };
          return `result:${String(value)}`;
        },
        version: '1',
      });

      strategy.startWorkflow({
        workflowId: 'wf-1',
        workflowType: 'yielding',
        input: null,
        checkpoint: new ArrayBuffer(0),
      });

      await Bun.sleep(10);
      messages.length = 0;

      strategy.resumeWorkflow({
        workflowId: 'wf-1',
        checkpoint: new ArrayBuffer(0),
        operationResult: { status: 'completed', value: 'hello' },
      });

      await Bun.sleep(10);

      const message = firstMessage();
      expect(message.type).toBe('completed');
      if (message.type === 'completed') {
        expect(message.result).toBe('result:hello');
      }
    });

    it('throws a failed result into the generator', async () => {
      setup();

      registrations.set('yielding', {
        handler: async function* (_context, _input) {
          yield {
            type: 'activity',
            operationId: 'op-1',
            activityName: 'doWork',
            fn: () => {},
            args: [],
          };
        },
        version: '1',
      });

      strategy.startWorkflow({
        workflowId: 'wf-1',
        workflowType: 'yielding',
        input: null,
        checkpoint: new ArrayBuffer(0),
      });

      await Bun.sleep(10);
      messages.length = 0;

      strategy.resumeWorkflow({
        workflowId: 'wf-1',
        checkpoint: new ArrayBuffer(0),
        operationResult: { status: 'failed', error: 'oops' },
      });

      await Bun.sleep(10);

      const message = firstMessage();
      expect(message.type).toBe('failed');
      if (message.type === 'failed') {
        expect(message.error).toBe('oops');
      }
    });
  });

  // -------------------------------------------------------------------------
  // Disposal
  // -------------------------------------------------------------------------

  describe('disposal', () => {
    it('clears all state on dispose', async () => {
      setup();

      registrations.set('yielding', {
        handler: async function* (_context, _input) {
          yield {
            type: 'activity',
            operationId: 'op-1',
            activityName: 'doWork',
            fn: () => {},
            args: [],
          };
        },
        version: '1',
      });

      strategy.startWorkflow({
        workflowId: 'wf-1',
        workflowType: 'yielding',
        input: null,
        checkpoint: new ArrayBuffer(0),
      });

      await Bun.sleep(10);

      strategy[Symbol.dispose]();

      expect(strategy.hasGenerator('wf-1')).toBe(false);
      expect(strategy.getContext('wf-1')).toBeUndefined();
    });
  });
});
