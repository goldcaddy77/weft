import { describe, expect, it } from 'bun:test';

import {
  AgentToolCalledEvent,
  AgentToolReturnedEvent,
  AgentTurnCompletedEvent,
  AgentTurnStartedEvent,
} from '../ai/events';
import type {
  ActivityInterception,
  AgentInterception,
  ChildWorkflowInterception,
  SignalInterception,
  SleepInterception,
} from '../core/interceptor';
import { createObservabilityInterceptors } from './index';
import { MetricsCollector } from './metrics';
import type { OtelApi, OtelSpan, OtelTracer, SpanLink } from './no-op-telemetry';

// ---------------------------------------------------------------------------
// Recording tracer: captures all span operations for assertions
// ---------------------------------------------------------------------------

type RecordedSpan = {
  name: string;
  attributes: Record<string, string | number | boolean>;
  status?: { code: number; message?: string };
  exceptions: Array<Error | string>;
  ended: boolean;
  parentContext?: unknown;
  links?: SpanLink[];
};

function createRecordingTracer(): {
  tracer: OtelTracer;
  spans: RecordedSpan[];
} {
  const spans: RecordedSpan[] = [];

  const tracer: OtelTracer = {
    startSpan(name: string, options?, _context?): OtelSpan {
      const recorded: RecordedSpan = {
        name,
        attributes: { ...options?.attributes },
        exceptions: [],
        ended: false,
        parentContext: _context,
        links: options?.links ?? [],
      };
      spans.push(recorded);

      return {
        setAttribute(key: string, value: string | number | boolean) {
          recorded.attributes[key] = value;
        },
        setStatus(status: { code: number; message?: string }) {
          recorded.status = status;
        },
        recordException(exception: Error | string) {
          recorded.exceptions.push(exception);
        },
        end() {
          recorded.ended = true;
        },
        spanContext() {
          return {
            traceId: 'abcd1234abcd1234abcd1234abcd1234',
            spanId: 'ef56ef56ef56ef56',
            traceFlags: 1,
          };
        },
      };
    },
  };

  return { tracer, spans };
}

/**
 * Build a mock OTel API that uses our recording tracer.
 * This lets us verify that the interceptors call OTel correctly.
 */
function createMockOtelApi(tracer: OtelTracer): OtelApi {
  return {
    trace: {
      getTracer() {
        return tracer;
      },
      setSpan(context: unknown) {
        return context;
      },
    },
    metrics: {
      getMeter() {
        return {
          createHistogram() {
            return { record() {} };
          },
          createCounter() {
            return { add() {} };
          },
          createUpDownCounter() {
            return { add() {} };
          },
        };
      },
    },
    context: {
      ROOT_CONTEXT: Symbol.for('ROOT'),
      with<T>(_ctx: unknown, fn: () => T): T {
        return fn();
      },
    },
    SpanStatusCode: { OK: 1, ERROR: 2, UNSET: 0 },
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('createObservabilityInterceptors', () => {
  it('returns workflow and activity interceptors', () => {
    const interceptors = createObservabilityInterceptors();
    expect(interceptors.workflow).toBeDefined();
    expect(interceptors.activity).toBeDefined();
  });

  it('returns a metrics collector even when not explicitly provided', () => {
    const { metrics } = createObservabilityInterceptors();
    expect(metrics).toBeDefined();
    expect(typeof metrics.increment).toBe('function');
    expect(typeof metrics.snapshot).toBe('function');
  });

  describe('workflow interceptor', () => {
    it('injects traceparent header on workflowStart', () => {
      const { tracer } = createRecordingTracer();
      const { workflow } = createObservabilityInterceptors({
        otelApi: createMockOtelApi(tracer),
      });

      const headers = new Map<string, string>();
      workflow.workflowStart!(
        {
          workflowId: 'wf-1',
          workflowType: 'TestWorkflow',
          input: undefined,
          headers,
        },
        () => {},
      );

      expect(headers.has('traceparent')).toBe(true);
      const traceparent = headers.get('traceparent')!;
      expect(traceparent).toContain('abcd1234abcd1234abcd1234abcd1234');
    });

    it('creates a span for workflowStart with correct attributes', () => {
      const { tracer, spans } = createRecordingTracer();
      const { workflow } = createObservabilityInterceptors({
        otelApi: createMockOtelApi(tracer),
      });

      workflow.workflowStart!(
        {
          workflowId: 'wf-1',
          workflowType: 'TestWorkflow',
          input: undefined,
          headers: new Map<string, string>(),
        },
        () => {},
      );

      expect(spans).toHaveLength(1);
      expect(spans[0]!.name).toBe('workflow:TestWorkflow');
      expect(spans[0]!.attributes['weft.workflow.id']).toBe('wf-1');
      expect(spans[0]!.attributes['weft.workflow.type']).toBe('TestWorkflow');
    });

    it('injects traceparent header on activity', () => {
      const { tracer } = createRecordingTracer();
      const { workflow } = createObservabilityInterceptors({
        otelApi: createMockOtelApi(tracer),
      });

      workflow.workflowStart!(
        {
          workflowId: 'wf-1',
          workflowType: 'TestWorkflow',
          input: undefined,
          headers: new Map<string, string>(),
        },
        () => {},
      );

      const headers = new Map<string, string>();
      const interception = {
        workflowId: 'wf-1',
        activityName: 'doSomething',
        input: 'hello',
        attempt: 1,
        headers,
      };

      const mockResult = 'activity-result';
      const next = function* (ctx: ActivityInterception) {
        expect(ctx.headers.has('traceparent')).toBe(true);
        return mockResult;
      };

      const generator = workflow.activity!(interception, next);
      let step = generator.next();
      while (!step.done) {
        step = generator.next(step.value);
      }

      expect(step.value).toBe(mockResult);
      expect(headers.has('traceparent')).toBe(true);
    });

    it('creates a span for activity with correct attributes', () => {
      const { tracer, spans } = createRecordingTracer();
      const { workflow } = createObservabilityInterceptors({
        otelApi: createMockOtelApi(tracer),
      });

      workflow.workflowStart!(
        {
          workflowId: 'wf-1',
          workflowType: 'TestWorkflow',
          input: undefined,
          headers: new Map<string, string>(),
        },
        () => {},
      );

      const next = function* (_ctx: ActivityInterception) {
        return 'result';
      };

      const generator = workflow.activity!(
        {
          workflowId: 'wf-1',
          activityName: 'doSomething',
          input: undefined,
          attempt: 1,
          headers: new Map(),
        },
        next,
      );
      let step = generator.next();
      while (!step.done) {
        step = generator.next(step.value);
      }

      // spans[0] is workflowStart, spans[1] is activity
      const activitySpan = spans.find((s) => s.name.startsWith('activity:'));
      expect(activitySpan).toBeDefined();
      expect(activitySpan!.name).toBe('activity:doSomething');
      expect(activitySpan!.attributes['weft.activity.name']).toBe('doSomething');
      expect(activitySpan!.attributes['weft.activity.attempt']).toBe(1);
      expect(activitySpan!.status?.code).toBe(1); // OK
      expect(activitySpan!.ended).toBe(true);
    });

    it('records error span when activity generator throws', () => {
      const { tracer, spans } = createRecordingTracer();
      const { workflow } = createObservabilityInterceptors({
        otelApi: createMockOtelApi(tracer),
      });

      workflow.workflowStart!(
        {
          workflowId: 'wf-err',
          workflowType: 'TestWorkflow',
          input: undefined,
          headers: new Map<string, string>(),
        },
        () => {},
      );

      const theError = new Error('activity failed');
      const next = function* (_ctx: ActivityInterception) {
        throw theError;
      };

      const generator = workflow.activity!(
        {
          workflowId: 'wf-err',
          activityName: 'failingActivity',
          input: undefined,
          attempt: 1,
          headers: new Map(),
        },
        next,
      );

      let caught = false;
      try {
        let step = generator.next();
        while (!step.done) {
          step = generator.next(step.value);
        }
      } catch (error) {
        caught = true;
        expect(error).toBe(theError);
      }
      expect(caught).toBe(true);

      const errorSpan = spans.find((s) => s.name === 'activity:failingActivity');
      expect(errorSpan).toBeDefined();
      expect(errorSpan!.status?.code).toBe(2); // ERROR
      expect(errorSpan!.status?.message).toBe('activity failed');
      expect(errorSpan!.exceptions).toHaveLength(1);
      expect(errorSpan!.ended).toBe(true);
    });

    it('records span for sleep with correct attributes', () => {
      const { tracer, spans } = createRecordingTracer();
      const { workflow } = createObservabilityInterceptors({
        otelApi: createMockOtelApi(tracer),
      });

      workflow.workflowStart!(
        {
          workflowId: 'wf-1',
          workflowType: 'TestWorkflow',
          input: undefined,
          headers: new Map<string, string>(),
        },
        () => {},
      );

      const next = function* (_ctx: SleepInterception) {};

      const generator = workflow.sleep!(
        { workflowId: 'wf-1', duration: 5000, headers: new Map() },
        next,
      );
      let step = generator.next();
      while (!step.done) {
        step = generator.next(step.value);
      }

      const sleepSpan = spans.find((s) => s.name === 'sleep');
      expect(sleepSpan).toBeDefined();
      expect(sleepSpan!.attributes['weft.sleep.duration']).toBe(5000);
      expect(sleepSpan!.status?.code).toBe(1); // OK
      expect(sleepSpan!.ended).toBe(true);
    });

    it('records span for waitForSignal with correct attributes', () => {
      const { tracer, spans } = createRecordingTracer();
      const { workflow } = createObservabilityInterceptors({
        otelApi: createMockOtelApi(tracer),
      });

      workflow.workflowStart!(
        {
          workflowId: 'wf-1',
          workflowType: 'TestWorkflow',
          input: undefined,
          headers: new Map<string, string>(),
        },
        () => {},
      );

      const next = function* (_ctx: SignalInterception) {
        return 'signal-result';
      };

      const generator = workflow.waitForSignal!(
        {
          workflowId: 'wf-1',
          signalName: 'approval',
          payload: { approved: true },
          headers: new Map(),
        },
        next,
      );
      let step = generator.next();
      while (!step.done) {
        step = generator.next(step.value);
      }

      const signalSpan = spans.find((s) => s.name === 'waitForSignal');
      expect(signalSpan).toBeDefined();
      expect(signalSpan!.attributes['weft.signal.name']).toBe('approval');
      expect(signalSpan!.status?.code).toBe(1); // OK
      expect(signalSpan!.ended).toBe(true);
    });

    it('records error span when waitForSignal throws', () => {
      const { tracer, spans } = createRecordingTracer();
      const { workflow } = createObservabilityInterceptors({
        otelApi: createMockOtelApi(tracer),
      });

      workflow.workflowStart!(
        {
          workflowId: 'wf-sig-err',
          workflowType: 'TestWorkflow',
          input: undefined,
          headers: new Map<string, string>(),
        },
        () => {},
      );

      const theError = new Error('signal failed');
      const next = function* (_ctx: SignalInterception) {
        throw theError;
      };

      const generator = workflow.waitForSignal!(
        {
          workflowId: 'wf-sig-err',
          signalName: 'test-signal',
          payload: undefined,
          headers: new Map(),
        },
        next,
      );

      let caught = false;
      try {
        let step = generator.next();
        while (!step.done) {
          step = generator.next(step.value);
        }
      } catch (error) {
        caught = true;
        expect(error).toBe(theError);
      }
      expect(caught).toBe(true);

      const errorSpan = spans.find((s) => s.name === 'waitForSignal');
      expect(errorSpan).toBeDefined();
      expect(errorSpan!.status?.code).toBe(2); // ERROR
      expect(errorSpan!.exceptions).toHaveLength(1);
      expect(errorSpan!.ended).toBe(true);
    });

    it('records span for agent with correct attributes', () => {
      const { tracer, spans } = createRecordingTracer();
      const { workflow } = createObservabilityInterceptors({
        otelApi: createMockOtelApi(tracer),
      });

      workflow.workflowStart!(
        {
          workflowId: 'wf-1',
          workflowType: 'TestWorkflow',
          input: undefined,
          headers: new Map<string, string>(),
        },
        () => {},
      );

      const next = function* (_ctx: AgentInterception) {
        return 'agent-result';
      };

      const generator = workflow.agent!(
        { workflowId: 'wf-1', model: 'gpt-4', prompt: 'hello', headers: new Map() },
        next,
      );
      let step = generator.next();
      while (!step.done) {
        step = generator.next(step.value);
      }

      const agentSpan = spans.find((s) => s.name === 'agent');
      expect(agentSpan).toBeDefined();
      expect(agentSpan!.attributes['weft.agent.model']).toBe('gpt-4');
      expect(agentSpan!.status?.code).toBe(1); // OK
      expect(agentSpan!.ended).toBe(true);
    });

    it('records error span when agent throws', () => {
      const { tracer, spans } = createRecordingTracer();
      const { workflow } = createObservabilityInterceptors({
        otelApi: createMockOtelApi(tracer),
      });

      workflow.workflowStart!(
        {
          workflowId: 'wf-agent-err',
          workflowType: 'TestWorkflow',
          input: undefined,
          headers: new Map<string, string>(),
        },
        () => {},
      );

      const theError = new Error('agent failed');
      const next = function* (_ctx: AgentInterception) {
        throw theError;
      };

      const generator = workflow.agent!(
        { workflowId: 'wf-agent-err', model: 'gpt-4', prompt: 'hello', headers: new Map() },
        next,
      );

      let caught = false;
      try {
        let step = generator.next();
        while (!step.done) {
          step = generator.next(step.value);
        }
      } catch (error) {
        caught = true;
        expect(error).toBe(theError);
      }
      expect(caught).toBe(true);

      const errorSpan = spans.find((s) => s.name === 'agent');
      expect(errorSpan).toBeDefined();
      expect(errorSpan!.status?.code).toBe(2); // ERROR
      expect(errorSpan!.ended).toBe(true);
    });

    it('creates standalone span for signalReceived', () => {
      const { tracer, spans } = createRecordingTracer();
      const { workflow } = createObservabilityInterceptors({
        otelApi: createMockOtelApi(tracer),
      });

      workflow.signalReceived!(
        {
          workflowId: 'wf-1',
          signalName: 'approval',
          payload: undefined,
          headers: new Map(),
        },
        () => {},
      );

      const signalSpan = spans.find((s) => s.name === 'signal:received:approval');
      expect(signalSpan).toBeDefined();
      expect(signalSpan!.attributes['weft.signal.name']).toBe('approval');
      expect(signalSpan!.attributes['weft.signal.workflow_id']).toBe('wf-1');
      expect(signalSpan!.status?.code).toBe(1); // OK
      expect(signalSpan!.ended).toBe(true);
    });

    it('records error span when signalReceived throws', () => {
      const { tracer, spans } = createRecordingTracer();
      const { workflow } = createObservabilityInterceptors({
        otelApi: createMockOtelApi(tracer),
      });

      const theError = new Error('signal handler failed');
      expect(() => {
        workflow.signalReceived!(
          {
            workflowId: 'wf-1',
            signalName: 'approval',
            payload: undefined,
            headers: new Map(),
          },
          () => {
            throw theError;
          },
        );
      }).toThrow(theError);

      const signalSpan = spans.find((s) => s.name === 'signal:received:approval');
      expect(signalSpan).toBeDefined();
      expect(signalSpan!.status?.code).toBe(2); // ERROR
      expect(signalSpan!.ended).toBe(true);
    });
  });

  describe('activity interceptor', () => {
    it('extracts trace context from headers and creates child span', async () => {
      const { tracer, spans } = createRecordingTracer();
      const { activity } = createObservabilityInterceptors({
        otelApi: createMockOtelApi(tracer),
      });

      const headers = new Map<string, string>([
        ['traceparent', '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01'],
      ]);

      const result = await activity.execute!(
        { activityName: 'doSomething', input: 'hello', attempt: 1, headers },
        async () => 'result',
      );

      expect(result).toBe('result');
      expect(spans).toHaveLength(1);
      expect(spans[0]!.name).toBe('activity:execute:doSomething');
      expect(spans[0]!.status?.code).toBe(1); // OK
      expect(spans[0]!.ended).toBe(true);
    });

    it('handles errors in activity execution', async () => {
      const { tracer, spans } = createRecordingTracer();
      const { activity } = createObservabilityInterceptors({
        otelApi: createMockOtelApi(tracer),
      });

      const headers = new Map<string, string>([
        ['traceparent', '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01'],
      ]);

      try {
        await activity.execute!(
          { activityName: 'failingActivity', input: undefined, attempt: 1, headers },
          async () => {
            throw new Error('something went wrong');
          },
        );
      } catch {
        // Expected
      }

      expect(spans).toHaveLength(1);
      expect(spans[0]!.status?.code).toBe(2); // ERROR
      expect(spans[0]!.status?.message).toBe('something went wrong');
      expect(spans[0]!.exceptions).toHaveLength(1);
      expect(spans[0]!.ended).toBe(true);
    });

    it('handles non-Error thrown values', async () => {
      const { tracer, spans } = createRecordingTracer();
      const { activity } = createObservabilityInterceptors({
        otelApi: createMockOtelApi(tracer),
      });

      const headers = new Map<string, string>([
        ['traceparent', '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01'],
      ]);

      try {
        await activity.execute!(
          { activityName: 'stringThrower', input: undefined, attempt: 1, headers },
          async () => {
            throw 'string error value';
          },
        );
      } catch {
        // Expected
      }

      expect(spans).toHaveLength(1);
      expect(spans[0]!.status?.code).toBe(2); // ERROR
      expect(spans[0]!.status?.message).toBe('string error value');
      expect(spans[0]!.ended).toBe(true);
    });

    it('generates a new trace when no traceparent header exists', async () => {
      const { tracer, spans } = createRecordingTracer();
      const { activity } = createObservabilityInterceptors({
        otelApi: createMockOtelApi(tracer),
      });

      await activity.execute!(
        { activityName: 'noTrace', input: undefined, attempt: 1, headers: new Map() },
        async () => 'ok',
      );

      expect(spans).toHaveLength(1);
      expect(spans[0]!.name).toBe('activity:execute:noTrace');
      expect(spans[0]!.ended).toBe(true);
    });
  });

  describe('recordPayloads option', () => {
    it('includes input as attribute when enabled', async () => {
      const { tracer, spans } = createRecordingTracer();
      const { activity } = createObservabilityInterceptors({
        recordPayloads: true,
        otelApi: createMockOtelApi(tracer),
      });

      await activity.execute!(
        {
          activityName: 'doSomething',
          input: 'hello-world',
          attempt: 1,
          headers: new Map(),
        },
        async () => 'ok',
      );

      expect(spans).toHaveLength(1);
      expect(spans[0]!.attributes['weft.payload.input']).toBe('"hello-world"');
    });

    it('does not include input when disabled', async () => {
      const { tracer, spans } = createRecordingTracer();
      const { activity } = createObservabilityInterceptors({
        recordPayloads: false,
        otelApi: createMockOtelApi(tracer),
      });

      await activity.execute!(
        {
          activityName: 'doSomething',
          input: 'hello-world',
          attempt: 1,
          headers: new Map(),
        },
        async () => 'ok',
      );

      expect(spans).toHaveLength(1);
      expect(spans[0]!.attributes['weft.payload.input']).toBeUndefined();
    });

    it('truncates payloads exceeding maxPayloadSize', async () => {
      const { tracer, spans } = createRecordingTracer();
      const { activity } = createObservabilityInterceptors({
        recordPayloads: true,
        maxPayloadSize: 10,
        otelApi: createMockOtelApi(tracer),
      });

      await activity.execute!(
        {
          activityName: 'doSomething',
          input: 'this is a very long input string that exceeds the max',
          attempt: 1,
          headers: new Map(),
        },
        async () => 'ok',
      );

      expect(spans).toHaveLength(1);
      const inputAttribute = spans[0]!.attributes['weft.payload.input'] as string;
      expect(inputAttribute.length).toBeLessThanOrEqual(13); // 10 + "..."
    });

    it('records workflow start input when recordPayloads is enabled', () => {
      const { tracer, spans } = createRecordingTracer();
      const { workflow } = createObservabilityInterceptors({
        recordPayloads: true,
        otelApi: createMockOtelApi(tracer),
      });

      workflow.workflowStart!(
        {
          workflowId: 'wf-payload',
          workflowType: 'TestWorkflow',
          input: { key: 'value' },
          headers: new Map<string, string>(),
        },
        () => {},
      );

      const startSpan = spans.find((s) => s.name.startsWith('workflow:'));
      expect(startSpan).toBeDefined();
      expect(startSpan!.attributes['weft.payload.input']).toBe('{"key":"value"}');
    });

    it('records activity input when recordPayloads is enabled (workflow interceptor)', () => {
      const { tracer, spans } = createRecordingTracer();
      const { workflow } = createObservabilityInterceptors({
        recordPayloads: true,
        otelApi: createMockOtelApi(tracer),
      });

      workflow.workflowStart!(
        {
          workflowId: 'wf-act-payload',
          workflowType: 'TestWorkflow',
          input: undefined,
          headers: new Map<string, string>(),
        },
        () => {},
      );

      const next = function* (_ctx: ActivityInterception) {
        return 'result';
      };

      const generator = workflow.activity!(
        {
          workflowId: 'wf-act-payload',
          activityName: 'doSomething',
          input: 'hello',
          attempt: 1,
          headers: new Map(),
        },
        next,
      );
      let step = generator.next();
      while (!step.done) {
        step = generator.next(step.value);
      }

      const activitySpan = spans.find((s) => s.name.startsWith('activity:'));
      expect(activitySpan).toBeDefined();
      expect(activitySpan!.attributes['weft.payload.input']).toBe('"hello"');
    });

    it('handles non-serializable payloads', async () => {
      const { tracer, spans } = createRecordingTracer();
      const { activity } = createObservabilityInterceptors({
        recordPayloads: true,
        otelApi: createMockOtelApi(tracer),
      });

      // Create a circular reference that JSON.stringify will fail on
      const circular: any = {};
      circular.self = circular;

      await activity.execute!(
        {
          activityName: 'circularInput',
          input: circular,
          attempt: 1,
          headers: new Map(),
        },
        async () => 'ok',
      );

      expect(spans).toHaveLength(1);
      expect(spans[0]!.attributes['weft.payload.input']).toBeDefined();
    });

    it('records agent prompt when recordPayloads is enabled', () => {
      const { tracer, spans } = createRecordingTracer();
      const { workflow } = createObservabilityInterceptors({
        recordPayloads: true,
        otelApi: createMockOtelApi(tracer),
      });

      workflow.workflowStart!(
        {
          workflowId: 'wf-agent-payload',
          workflowType: 'TestWorkflow',
          input: undefined,
          headers: new Map<string, string>(),
        },
        () => {},
      );

      const next = function* (_ctx: AgentInterception) {
        return 'agent-result';
      };

      const generator = workflow.agent!(
        {
          workflowId: 'wf-agent-payload',
          model: 'gpt-4',
          prompt: 'hello world',
          headers: new Map(),
        },
        next,
      );
      let step = generator.next();
      while (!step.done) {
        step = generator.next(step.value);
      }

      const agentSpan = spans.find((s) => s.name === 'agent');
      expect(agentSpan).toBeDefined();
      expect(agentSpan!.attributes['weft.agent.prompt']).toBe('"hello world"');
    });
  });

  describe('attributeExtractor', () => {
    it('merges custom attributes into workflowStart span', () => {
      const { tracer, spans } = createRecordingTracer();
      const { workflow } = createObservabilityInterceptors({
        otelApi: createMockOtelApi(tracer),
        attributeExtractor: () => ({ 'custom.region': 'us-east', 'custom.priority': 1 }),
      });

      workflow.workflowStart!(
        {
          workflowId: 'wf-attr',
          workflowType: 'TestWorkflow',
          input: undefined,
          headers: new Map<string, string>(),
        },
        () => {},
      );

      const span = spans.find((s) => s.name.startsWith('workflow:'));
      expect(span).toBeDefined();
      expect(span!.attributes['custom.region']).toBe('us-east');
      expect(span!.attributes['custom.priority']).toBe(1);
    });

    it('merges custom attributes into activity span', () => {
      const { tracer, spans } = createRecordingTracer();
      const { workflow } = createObservabilityInterceptors({
        otelApi: createMockOtelApi(tracer),
        attributeExtractor: () => ({ 'custom.region': 'us-east' }),
      });

      workflow.workflowStart!(
        {
          workflowId: 'wf-attr-act',
          workflowType: 'TestWorkflow',
          input: undefined,
          headers: new Map<string, string>(),
        },
        () => {},
      );

      const next = function* (_ctx: ActivityInterception) {
        return 'result';
      };

      const generator = workflow.activity!(
        {
          workflowId: 'wf-attr-act',
          activityName: 'doSomething',
          input: undefined,
          attempt: 1,
          headers: new Map(),
        },
        next,
      );
      let step = generator.next();
      while (!step.done) {
        step = generator.next(step.value);
      }

      const activitySpan = spans.find((s) => s.name.startsWith('activity:'));
      expect(activitySpan).toBeDefined();
      expect(activitySpan!.attributes['custom.region']).toBe('us-east');
    });

    it('merges custom attributes into sleep span', () => {
      const { tracer, spans } = createRecordingTracer();
      const { workflow } = createObservabilityInterceptors({
        otelApi: createMockOtelApi(tracer),
        attributeExtractor: () => ({ 'custom.region': 'eu-west' }),
      });

      workflow.workflowStart!(
        {
          workflowId: 'wf-attr-sleep',
          workflowType: 'TestWorkflow',
          input: undefined,
          headers: new Map<string, string>(),
        },
        () => {},
      );

      const next = function* (_ctx: SleepInterception) {};

      const generator = workflow.sleep!(
        { workflowId: 'wf-attr-sleep', duration: 5000, headers: new Map() },
        next,
      );
      let step = generator.next();
      while (!step.done) {
        step = generator.next(step.value);
      }

      const sleepSpan = spans.find((s) => s.name === 'sleep');
      expect(sleepSpan).toBeDefined();
      expect(sleepSpan!.attributes['custom.region']).toBe('eu-west');
    });

    it('merges custom attributes into agent span', () => {
      const { tracer, spans } = createRecordingTracer();
      const { workflow } = createObservabilityInterceptors({
        otelApi: createMockOtelApi(tracer),
        attributeExtractor: () => ({ 'custom.env': 'production' }),
      });

      workflow.workflowStart!(
        {
          workflowId: 'wf-attr-agent',
          workflowType: 'TestWorkflow',
          input: undefined,
          headers: new Map<string, string>(),
        },
        () => {},
      );

      const next = function* (_ctx: AgentInterception) {
        return 'agent-result';
      };

      const generator = workflow.agent!(
        { workflowId: 'wf-attr-agent', model: 'gpt-4', prompt: 'hello', headers: new Map() },
        next,
      );
      let step = generator.next();
      while (!step.done) {
        step = generator.next(step.value);
      }

      const agentSpan = spans.find((s) => s.name === 'agent');
      expect(agentSpan).toBeDefined();
      expect(agentSpan!.attributes['custom.env']).toBe('production');
    });

    it('receives actual interception context', () => {
      const extractorCalls: unknown[] = [];
      const { tracer } = createRecordingTracer();
      const { workflow } = createObservabilityInterceptors({
        otelApi: createMockOtelApi(tracer),
        attributeExtractor: (ctx) => {
          extractorCalls.push(ctx);
          return {};
        },
      });

      const interception = {
        workflowId: 'wf-ctx-check',
        workflowType: 'MyWorkflow',
        input: { data: 123 },
        headers: new Map<string, string>(),
      };

      workflow.workflowStart!(interception, () => {});

      expect(extractorCalls.length).toBeGreaterThanOrEqual(1);
      // The extractor receives the actual interception object
      expect(extractorCalls[0]).toBe(interception);
    });
  });

  describe('MetricsCollector integration', () => {
    it('records weft.workflow.started on workflowStart', () => {
      const metricsCollector = new MetricsCollector();
      const { workflow } = createObservabilityInterceptors({ metrics: metricsCollector });

      workflow.workflowStart!(
        {
          workflowId: 'wf-m1',
          workflowType: 'TestWorkflow',
          input: undefined,
          headers: new Map<string, string>(),
        },
        () => {},
      );

      const snapshot = metricsCollector.snapshot();
      expect(snapshot['weft.workflow.started']).toBeDefined();
      expect(
        snapshot['weft.workflow.started']!.type === 'counter' &&
          snapshot['weft.workflow.started']!.value,
      ).toBe(1);
    });

    it('records weft.activity.duration on activity completion', () => {
      const metricsCollector = new MetricsCollector();
      const { workflow } = createObservabilityInterceptors({ metrics: metricsCollector });

      workflow.workflowStart!(
        {
          workflowId: 'wf-m2',
          workflowType: 'TestWorkflow',
          input: undefined,
          headers: new Map<string, string>(),
        },
        () => {},
      );

      const next = function* (_ctx: ActivityInterception) {
        return 'result';
      };

      const generator = workflow.activity!(
        {
          workflowId: 'wf-m2',
          activityName: 'myActivity',
          input: undefined,
          attempt: 1,
          headers: new Map(),
        },
        next,
      );
      let step = generator.next();
      while (!step.done) {
        step = generator.next(step.value);
      }

      const snapshot = metricsCollector.snapshot();
      expect(snapshot['weft.activity.duration']).toBeDefined();
      expect(snapshot['weft.activity.duration']!.type).toBe('histogram');
      expect(snapshot['weft.activity.attempts']).toBeDefined();
      expect(
        snapshot['weft.activity.attempts']!.type === 'counter' &&
          snapshot['weft.activity.attempts']!.value,
      ).toBe(1);
    });
  });

  describe('without OTel API (default no-op)', () => {
    it('works without any options — uses no-op OTel API', () => {
      const { workflow } = createObservabilityInterceptors();

      const headers = new Map<string, string>();
      expect(() => {
        workflow.workflowStart!(
          {
            workflowId: 'wf-noop',
            workflowType: 'TestWorkflow',
            input: undefined,
            headers,
          },
          () => {},
        );
      }).not.toThrow();

      // With the no-op API, traceparent still gets injected (using no-op span context)
      expect(headers.has('traceparent')).toBe(true);
    });

    it('activity interceptor works without OTel', async () => {
      const { activity } = createObservabilityInterceptors();

      const result = await activity.execute!(
        { activityName: 'noOtel', input: undefined, attempt: 1, headers: new Map() },
        async () => 'ok',
      );

      expect(result).toBe('ok');
    });
  });

  describe('non-Error thrown values', () => {
    it('records non-Error thrown value in activity generator', () => {
      const { tracer, spans } = createRecordingTracer();
      const { workflow } = createObservabilityInterceptors({
        otelApi: createMockOtelApi(tracer),
      });

      workflow.workflowStart!(
        {
          workflowId: 'wf-err-2',
          workflowType: 'TestWorkflow',
          input: undefined,
          headers: new Map<string, string>(),
        },
        () => {},
      );

      const next = function* (_ctx: ActivityInterception) {
        throw 'non-error value';
      };

      const generator = workflow.activity!(
        {
          workflowId: 'wf-err-2',
          activityName: 'stringThrower',
          input: undefined,
          attempt: 1,
          headers: new Map(),
        },
        next,
      );

      try {
        let step = generator.next();
        while (!step.done) {
          step = generator.next(step.value);
        }
      } catch {
        // Expected
      }

      const errorSpan = spans.find((s) => s.name === 'activity:stringThrower');
      expect(errorSpan).toBeDefined();
      expect(errorSpan!.status?.code).toBe(2); // ERROR
      expect(errorSpan!.status?.message).toBe('non-error value');
    });

    it('records non-Error thrown value in waitForSignal', () => {
      const { tracer, spans } = createRecordingTracer();
      const { workflow } = createObservabilityInterceptors({
        otelApi: createMockOtelApi(tracer),
      });

      workflow.workflowStart!(
        {
          workflowId: 'wf-sig-err-2',
          workflowType: 'TestWorkflow',
          input: undefined,
          headers: new Map<string, string>(),
        },
        () => {},
      );

      const next = function* (_ctx: SignalInterception) {
        throw 42;
      };

      const generator = workflow.waitForSignal!(
        {
          workflowId: 'wf-sig-err-2',
          signalName: 'test-signal',
          payload: undefined,
          headers: new Map(),
        },
        next,
      );

      try {
        let step = generator.next();
        while (!step.done) {
          step = generator.next(step.value);
        }
      } catch {
        // Expected
      }

      const errorSpan = spans.find((s) => s.name === 'waitForSignal');
      expect(errorSpan).toBeDefined();
      expect(errorSpan!.status?.code).toBe(2); // ERROR
      expect(errorSpan!.status?.message).toBe('42');
    });
  });

  describe('workflow activity interceptor without prior workflowStart', () => {
    it('still creates a span when no workflowStart was called', () => {
      const { tracer, spans } = createRecordingTracer();
      const { workflow } = createObservabilityInterceptors({
        otelApi: createMockOtelApi(tracer),
      });

      const interception = {
        workflowId: 'wf-orphan',
        activityName: 'orphanActivity',
        input: undefined,
        attempt: 1,
        headers: new Map<string, string>(),
      };

      const next = function* (_ctx: ActivityInterception) {
        return 'result';
      };

      const generator = workflow.activity!(interception, next);
      let step = generator.next();
      while (!step.done) {
        step = generator.next(step.value);
      }

      expect(spans).toHaveLength(1);
      expect(interception.headers.has('traceparent')).toBe(true);
    });
  });

  describe('agent turn and tool child spans', () => {
    function driveGenerator<T>(gen: Generator<unknown, T, unknown>): T {
      let step = gen.next();
      while (!step.done) {
        step = gen.next(step.value);
      }
      return step.value;
    }

    function setupWorkflow(eventTarget: EventTarget) {
      const { tracer, spans } = createRecordingTracer();
      const otelApi = createMockOtelApi(tracer);

      const { workflow } = createObservabilityInterceptors({
        eventTarget,
        otelApi,
      });

      workflow.workflowStart!(
        {
          workflowId: 'wf-agent-spans',
          workflowType: 'TestWorkflow',
          input: undefined,
          headers: new Map<string, string>(),
        },
        () => {},
      );

      return { workflow, spans };
    }

    it('creates agent:turn child spans from turn events', () => {
      const eventTarget = new EventTarget();
      const { workflow, spans } = setupWorkflow(eventTarget);

      const gen = workflow.agent!(
        { workflowId: 'wf-agent-spans', model: 'claude', prompt: 'test', headers: new Map() },
        function* () {
          eventTarget.dispatchEvent(
            new AgentTurnStartedEvent('wf-agent-spans', 'agent-1', 0, 'claude', 100, 1),
          );
          eventTarget.dispatchEvent(
            new AgentTurnCompletedEvent(
              'wf-agent-spans',
              'agent-1',
              0,
              'claude',
              'claude',
              100,
              50,
              0.01,
              0.01,
              500,
              1,
              0,
              undefined,
            ),
          );
          return 'agent-result';
        },
      );

      const result = driveGenerator(gen);
      expect(result).toBe('agent-result');

      const turnSpan = spans.find((s) => s.name === 'agent:turn:0');
      expect(turnSpan).toBeDefined();
      expect(turnSpan!.attributes['weft.agent.turn_index']).toBe(0);
      expect(turnSpan!.attributes['weft.agent.model']).toBe('claude');
      expect(turnSpan!.attributes['weft.agent.input_tokens']).toBe(100);
      expect(turnSpan!.attributes['weft.agent.output_tokens']).toBe(50);
      expect(turnSpan!.attributes['weft.agent.cost']).toBe(0.01);
      expect(turnSpan!.ended).toBe(true);
    });

    it('creates agent:tool child spans from tool events', () => {
      const eventTarget = new EventTarget();
      const { workflow, spans } = setupWorkflow(eventTarget);

      const gen = workflow.agent!(
        { workflowId: 'wf-agent-spans', model: 'claude', prompt: 'test', headers: new Map() },
        function* () {
          eventTarget.dispatchEvent(
            new AgentTurnStartedEvent('wf-agent-spans', 'agent-1', 0, 'claude', 100, 1),
          );
          eventTarget.dispatchEvent(
            new AgentToolCalledEvent(
              'wf-agent-spans',
              'agent-1',
              0,
              'webSearch',
              '{}',
              'local',
              'op-1',
            ),
          );
          eventTarget.dispatchEvent(
            new AgentToolReturnedEvent(
              'wf-agent-spans',
              'agent-1',
              0,
              'webSearch',
              50,
              true,
              'op-1',
            ),
          );
          eventTarget.dispatchEvent(
            new AgentTurnCompletedEvent(
              'wf-agent-spans',
              'agent-1',
              0,
              'claude',
              'claude',
              100,
              50,
              0.01,
              0.01,
              500,
              1,
              0,
              undefined,
            ),
          );
          return 'done';
        },
      );

      driveGenerator(gen);

      const toolSpan = spans.find((s) => s.name === 'agent:tool:webSearch');
      expect(toolSpan).toBeDefined();
      expect(toolSpan!.attributes['weft.agent.tool_name']).toBe('webSearch');
      expect(toolSpan!.attributes['weft.agent.tool_duration']).toBe(50);
      expect(toolSpan!.attributes['weft.agent.tool_success']).toBe(true);
      expect(toolSpan!.ended).toBe(true);
    });

    it('creates spans for multiple turns with tools', () => {
      const eventTarget = new EventTarget();
      const { workflow, spans } = setupWorkflow(eventTarget);

      const gen = workflow.agent!(
        { workflowId: 'wf-agent-spans', model: 'claude', prompt: 'test', headers: new Map() },
        function* () {
          eventTarget.dispatchEvent(
            new AgentTurnStartedEvent('wf-agent-spans', 'agent-1', 0, 'claude', 100, 1),
          );
          eventTarget.dispatchEvent(
            new AgentToolCalledEvent(
              'wf-agent-spans',
              'agent-1',
              0,
              'search',
              '{}',
              'local',
              'op-1',
            ),
          );
          eventTarget.dispatchEvent(
            new AgentToolReturnedEvent('wf-agent-spans', 'agent-1', 0, 'search', 30, true, 'op-1'),
          );
          eventTarget.dispatchEvent(
            new AgentTurnCompletedEvent(
              'wf-agent-spans',
              'agent-1',
              0,
              'claude',
              'claude',
              100,
              50,
              0.01,
              0.01,
              500,
              1,
              0,
              undefined,
            ),
          );

          eventTarget.dispatchEvent(
            new AgentTurnStartedEvent('wf-agent-spans', 'agent-1', 1, 'claude', 200, 3),
          );
          eventTarget.dispatchEvent(
            new AgentToolCalledEvent(
              'wf-agent-spans',
              'agent-1',
              1,
              'analyze',
              '{}',
              'local',
              'op-2',
            ),
          );
          eventTarget.dispatchEvent(
            new AgentToolReturnedEvent('wf-agent-spans', 'agent-1', 1, 'analyze', 80, true, 'op-2'),
          );
          eventTarget.dispatchEvent(
            new AgentTurnCompletedEvent(
              'wf-agent-spans',
              'agent-1',
              1,
              'claude',
              'claude',
              200,
              100,
              0.02,
              0.03,
              600,
              1,
              0,
              undefined,
            ),
          );

          return 'done';
        },
      );

      driveGenerator(gen);

      expect(spans.filter((s) => s.name.startsWith('agent:turn:'))).toHaveLength(2);
      expect(spans.filter((s) => s.name.startsWith('agent:tool:'))).toHaveLength(2);
      expect(spans.find((s) => s.name === 'agent:turn:0')!.ended).toBe(true);
      expect(spans.find((s) => s.name === 'agent:turn:1')!.ended).toBe(true);
    });

    it('handles multiple tool calls within a single turn', () => {
      const eventTarget = new EventTarget();
      const { workflow, spans } = setupWorkflow(eventTarget);

      const gen = workflow.agent!(
        { workflowId: 'wf-agent-spans', model: 'claude', prompt: 'test', headers: new Map() },
        function* () {
          eventTarget.dispatchEvent(
            new AgentTurnStartedEvent('wf-agent-spans', 'agent-1', 0, 'claude', 100, 1),
          );
          eventTarget.dispatchEvent(
            new AgentToolCalledEvent(
              'wf-agent-spans',
              'agent-1',
              0,
              'search',
              '{}',
              'local',
              'op-1',
            ),
          );
          eventTarget.dispatchEvent(
            new AgentToolCalledEvent(
              'wf-agent-spans',
              'agent-1',
              0,
              'readDoc',
              '{}',
              'local',
              'op-2',
            ),
          );
          eventTarget.dispatchEvent(
            new AgentToolReturnedEvent('wf-agent-spans', 'agent-1', 0, 'search', 30, true, 'op-1'),
          );
          eventTarget.dispatchEvent(
            new AgentToolReturnedEvent(
              'wf-agent-spans',
              'agent-1',
              0,
              'readDoc',
              40,
              false,
              'op-2',
            ),
          );
          eventTarget.dispatchEvent(
            new AgentTurnCompletedEvent(
              'wf-agent-spans',
              'agent-1',
              0,
              'claude',
              'claude',
              100,
              50,
              0.01,
              0.01,
              500,
              2,
              0,
              undefined,
            ),
          );
          return 'done';
        },
      );

      driveGenerator(gen);

      const toolSpans = spans.filter((s) => s.name.startsWith('agent:tool:'));
      expect(toolSpans).toHaveLength(2);

      const readDocSpan = spans.find((s) => s.name === 'agent:tool:readDoc');
      expect(readDocSpan!.status?.code).toBe(2); // ERROR
    });

    it('does not create child spans when eventTarget is not provided', () => {
      const { tracer, spans } = createRecordingTracer();
      const { workflow } = createObservabilityInterceptors({
        otelApi: createMockOtelApi(tracer),
      });

      workflow.workflowStart!(
        { workflowId: 'wf-no-et', workflowType: 'Test', input: undefined, headers: new Map() },
        () => {},
      );

      const gen = workflow.agent!(
        { workflowId: 'wf-agent-spans', model: 'claude', prompt: 'test', headers: new Map() },
        function* () {
          return 'done';
        },
      );

      driveGenerator(gen);

      expect(spans.filter((s) => s.name.startsWith('agent:turn:'))).toHaveLength(0);
      expect(spans.filter((s) => s.name.startsWith('agent:tool:'))).toHaveLength(0);
      expect(spans.find((s) => s.name === 'agent')!.ended).toBe(true);
    });

    it('cleans up orphaned turn and tool spans on agent error', () => {
      const eventTarget = new EventTarget();
      const { workflow, spans } = setupWorkflow(eventTarget);
      const theError = new Error('agent exploded');

      const gen = workflow.agent!(
        { workflowId: 'wf-agent-spans', model: 'claude', prompt: 'test', headers: new Map() },
        function* () {
          eventTarget.dispatchEvent(
            new AgentTurnStartedEvent('wf-agent-spans', 'agent-1', 0, 'claude', 100, 1),
          );
          eventTarget.dispatchEvent(
            new AgentToolCalledEvent(
              'wf-agent-spans',
              'agent-1',
              0,
              'search',
              '{}',
              'local',
              'op-1',
            ),
          );
          throw theError;
        },
      );

      let caught = false;
      try {
        driveGenerator(gen);
      } catch (error) {
        caught = true;
        expect(error).toBe(theError);
      }
      expect(caught).toBe(true);

      // Agent, turn, and tool spans should all be ended with ERROR status
      expect(spans.find((s) => s.name === 'agent')!.ended).toBe(true);
      expect(spans.find((s) => s.name === 'agent')!.status?.code).toBe(2); // ERROR
      expect(spans.find((s) => s.name === 'agent:turn:0')!.ended).toBe(true);
      expect(spans.find((s) => s.name === 'agent:turn:0')!.status?.code).toBe(2); // ERROR
      expect(spans.find((s) => s.name === 'agent:tool:search')!.ended).toBe(true);
      expect(spans.find((s) => s.name === 'agent:tool:search')!.status?.code).toBe(2); // ERROR
    });

    it('removes event listeners after agent completes', () => {
      const eventTarget = new EventTarget();
      const { workflow, spans } = setupWorkflow(eventTarget);

      const gen = workflow.agent!(
        { workflowId: 'wf-agent-spans', model: 'claude', prompt: 'test', headers: new Map() },
        function* () {
          return 'done';
        },
      );

      driveGenerator(gen);

      const spanCountBefore = spans.length;
      eventTarget.dispatchEvent(
        new AgentTurnStartedEvent('wf-agent-spans', 'agent-1', 0, 'claude', 100, 1),
      );
      expect(spans.length).toBe(spanCountBefore);
    });
  });

  describe('child workflow interceptor', () => {
    it('creates a span with link to parent, not parent-child relationship', async () => {
      const { tracer, spans } = createRecordingTracer();
      const { workflow } = createObservabilityInterceptors({
        otelApi: createMockOtelApi(tracer),
      });

      // Start parent workflow to populate the root span
      workflow.workflowStart!(
        {
          workflowId: 'parent-wf',
          workflowType: 'ParentWorkflow',
          input: undefined,
          headers: new Map<string, string>(),
        },
        () => {},
      );

      // Parent traceparent header simulating what the engine would pass
      const parentHeaders = new Map<string, string>([
        ['traceparent', '00-abcd1234abcd1234abcd1234abcd1234-ef56ef56ef56ef56-01'],
      ]);

      const interception: ChildWorkflowInterception = {
        workflowId: 'parent-wf',
        childWorkflowId: 'child-wf-1',
        workflowType: 'ChildWorkflow',
        input: { task: 'process' },
        headers: new Map<string, string>(),
        parentHeaders,
      };

      const result = await workflow.childWorkflow!(interception, async () => 'child-result');

      expect(result).toBe('child-result');

      const childSpan = spans.find((s) => s.name === 'childWorkflow:ChildWorkflow');
      expect(childSpan).toBeDefined();
      expect(childSpan!.attributes['weft.child_workflow.type']).toBe('ChildWorkflow');
      expect(childSpan!.attributes['weft.child_workflow.id']).toBe('child-wf-1');
      expect(childSpan!.attributes['weft.child_workflow.parent_id']).toBe('parent-wf');

      // The span should have a link to the parent, not a parent context
      expect(childSpan!.links).toBeDefined();
      expect(childSpan!.links).toHaveLength(1);
      expect(childSpan!.links![0]!.context.traceId).toBe('abcd1234abcd1234abcd1234abcd1234');
      expect(childSpan!.links![0]!.context.spanId).toBe('ef56ef56ef56ef56');

      // The span should NOT have a parent context (root context means independent lifecycle)
      // In our mock, ROOT_CONTEXT is a Symbol — if parentContext is that symbol, the span is a root.
      expect(childSpan!.parentContext).toBe(Symbol.for('ROOT'));
      expect(childSpan!.ended).toBe(true);
      expect(childSpan!.status?.code).toBe(1); // OK
    });

    it('injects traceparent header into child workflow headers', async () => {
      const { tracer } = createRecordingTracer();
      const { workflow } = createObservabilityInterceptors({
        otelApi: createMockOtelApi(tracer),
      });

      workflow.workflowStart!(
        {
          workflowId: 'parent-wf',
          workflowType: 'ParentWorkflow',
          input: undefined,
          headers: new Map<string, string>(),
        },
        () => {},
      );

      const childHeaders = new Map<string, string>();
      const interception: ChildWorkflowInterception = {
        workflowId: 'parent-wf',
        childWorkflowId: 'child-wf-2',
        workflowType: 'ChildWorkflow',
        input: undefined,
        headers: childHeaders,
        parentHeaders: new Map([
          ['traceparent', '00-abcd1234abcd1234abcd1234abcd1234-ef56ef56ef56ef56-01'],
        ]),
      };

      await workflow.childWorkflow!(interception, async () => 'ok');

      expect(childHeaders.has('traceparent')).toBe(true);
      const traceparent = childHeaders.get('traceparent')!;
      // The traceparent should contain the recording span's trace ID
      expect(traceparent).toContain('abcd1234abcd1234abcd1234abcd1234');
    });

    it('records error span when child workflow fails', async () => {
      const { tracer, spans } = createRecordingTracer();
      const { workflow } = createObservabilityInterceptors({
        otelApi: createMockOtelApi(tracer),
      });

      workflow.workflowStart!(
        {
          workflowId: 'parent-wf',
          workflowType: 'ParentWorkflow',
          input: undefined,
          headers: new Map<string, string>(),
        },
        () => {},
      );

      const theError = new Error('child workflow failed');
      const interception: ChildWorkflowInterception = {
        workflowId: 'parent-wf',
        childWorkflowId: 'child-wf-err',
        workflowType: 'FailingChild',
        input: undefined,
        headers: new Map<string, string>(),
        parentHeaders: new Map([
          ['traceparent', '00-abcd1234abcd1234abcd1234abcd1234-ef56ef56ef56ef56-01'],
        ]),
      };

      let caught = false;
      try {
        await workflow.childWorkflow!(interception, async () => {
          throw theError;
        });
      } catch (error) {
        caught = true;
        expect(error).toBe(theError);
      }
      expect(caught).toBe(true);

      const childSpan = spans.find((s) => s.name === 'childWorkflow:FailingChild');
      expect(childSpan).toBeDefined();
      expect(childSpan!.status?.code).toBe(2); // ERROR
      expect(childSpan!.status?.message).toBe('child workflow failed');
      expect(childSpan!.exceptions).toHaveLength(1);
      expect(childSpan!.ended).toBe(true);
    });

    it('creates span with empty links when no parent traceparent exists', async () => {
      const { tracer, spans } = createRecordingTracer();
      const { workflow } = createObservabilityInterceptors({
        otelApi: createMockOtelApi(tracer),
      });

      workflow.workflowStart!(
        {
          workflowId: 'parent-wf',
          workflowType: 'ParentWorkflow',
          input: undefined,
          headers: new Map<string, string>(),
        },
        () => {},
      );

      const interception: ChildWorkflowInterception = {
        workflowId: 'parent-wf',
        childWorkflowId: 'child-wf-no-parent',
        workflowType: 'OrphanChild',
        input: undefined,
        headers: new Map<string, string>(),
        parentHeaders: new Map<string, string>(), // No traceparent
      };

      await workflow.childWorkflow!(interception, async () => 'ok');

      const childSpan = spans.find((s) => s.name === 'childWorkflow:OrphanChild');
      expect(childSpan).toBeDefined();
      // No link when parent has no traceparent
      expect(childSpan!.links ?? []).toHaveLength(0);
      expect(childSpan!.ended).toBe(true);
    });

    it('records input when recordPayloads is enabled', async () => {
      const { tracer, spans } = createRecordingTracer();
      const { workflow } = createObservabilityInterceptors({
        recordPayloads: true,
        otelApi: createMockOtelApi(tracer),
      });

      workflow.workflowStart!(
        {
          workflowId: 'parent-wf',
          workflowType: 'ParentWorkflow',
          input: undefined,
          headers: new Map<string, string>(),
        },
        () => {},
      );

      const interception: ChildWorkflowInterception = {
        workflowId: 'parent-wf',
        childWorkflowId: 'child-wf-payload',
        workflowType: 'PayloadChild',
        input: { data: 'important' },
        headers: new Map<string, string>(),
        parentHeaders: new Map<string, string>(),
      };

      await workflow.childWorkflow!(interception, async () => 'ok');

      const childSpan = spans.find((s) => s.name === 'childWorkflow:PayloadChild');
      expect(childSpan).toBeDefined();
      expect(childSpan!.attributes['weft.payload.input']).toBe('{"data":"important"}');
    });

    it('records child workflow started metric', async () => {
      const metricsCollector = new MetricsCollector();
      const { workflow } = createObservabilityInterceptors({ metrics: metricsCollector });

      workflow.workflowStart!(
        {
          workflowId: 'parent-wf',
          workflowType: 'ParentWorkflow',
          input: undefined,
          headers: new Map<string, string>(),
        },
        () => {},
      );

      const interception: ChildWorkflowInterception = {
        workflowId: 'parent-wf',
        childWorkflowId: 'child-wf-metric',
        workflowType: 'MetricChild',
        input: undefined,
        headers: new Map<string, string>(),
        parentHeaders: new Map<string, string>(),
      };

      await workflow.childWorkflow!(interception, async () => 'ok');

      const snapshot = metricsCollector.snapshot();
      expect(snapshot['weft.child_workflow.started']).toBeDefined();
      expect(
        snapshot['weft.child_workflow.started']!.type === 'counter' &&
          snapshot['weft.child_workflow.started']!.value,
      ).toBe(1);
    });
  });
});
