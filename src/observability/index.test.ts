import { describe, expect, it } from 'bun:test';

import type {
  ActivityInterception,
  AgentInterception,
  SignalInterception,
  SleepInterception,
} from '../core/interceptor';
import { createObservabilityInterceptors } from './index';
import { MetricsCollector } from './metrics';
import type { OtelApi, OtelSpan, OtelTracer } from './no-op-telemetry';

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
      ROOT_CONTEXT: Symbol('ROOT'),
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
        { activityName: 'doSomething', input: undefined, attempt: 1, headers: new Map() },
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
        { activityName: 'failingActivity', input: undefined, attempt: 1, headers: new Map() },
        next,
      );

      try {
        let step = generator.next();
        while (!step.done) {
          step = generator.next(step.value);
        }
      } catch (error) {
        expect(error).toBe(theError);
      }

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

      const generator = workflow.sleep!({ duration: 5000, headers: new Map() }, next);
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
        { signalName: 'approval', payload: { approved: true }, headers: new Map() },
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
        { signalName: 'test-signal', payload: undefined, headers: new Map() },
        next,
      );

      try {
        let step = generator.next();
        while (!step.done) {
          step = generator.next(step.value);
        }
      } catch (error) {
        expect(error).toBe(theError);
      }

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
        { model: 'gpt-4', prompt: 'hello', headers: new Map() },
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
        { model: 'gpt-4', prompt: 'hello', headers: new Map() },
        next,
      );

      try {
        let step = generator.next();
        while (!step.done) {
          step = generator.next(step.value);
        }
      } catch (error) {
        expect(error).toBe(theError);
      }

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
        { activityName: 'doSomething', input: 'hello', attempt: 1, headers: new Map() },
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
        { model: 'gpt-4', prompt: 'hello world', headers: new Map() },
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
        { activityName: 'doSomething', input: undefined, attempt: 1, headers: new Map() },
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

      const generator = workflow.sleep!({ duration: 5000, headers: new Map() }, next);
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
        { model: 'gpt-4', prompt: 'hello', headers: new Map() },
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
        { activityName: 'myActivity', input: undefined, attempt: 1, headers: new Map() },
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
        { activityName: 'stringThrower', input: undefined, attempt: 1, headers: new Map() },
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
        { signalName: 'test-signal', payload: undefined, headers: new Map() },
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
});
