import { describe, expect, it } from 'bun:test';

import type {
  ActivityExecutionInterception,
  ActivityInterception,
  AgentInterception,
  SignalInterception,
  SleepInterception,
} from '../core/interceptor';
import type { SpanInfo } from './index';
import { createObservabilityInterceptors } from './index';
import { MetricsCollector } from './metrics';

describe('createObservabilityInterceptors', () => {
  it('returns workflow and activity interceptors', () => {
    const interceptors = createObservabilityInterceptors();
    expect(interceptors.workflow).toBeDefined();
    expect(interceptors.activity).toBeDefined();
  });

  describe('workflow interceptor', () => {
    it('injects trace context on activity', () => {
      const { workflow } = createObservabilityInterceptors();
      const headers = new Map<string, string>();

      const interception = {
        activityName: 'doSomething',
        input: 'hello',
        attempt: 1,
        headers,
      };

      const mockResult = 'activity-result';
      const next = function* (ctx: ActivityInterception) {
        // Verify headers were injected before calling next
        expect(ctx.headers.has('traceparent')).toBe(true);
        return mockResult;
      };

      // The workflow needs a start context to establish a trace
      workflow.workflowStart!(
        {
          workflowId: 'wf-1',
          workflowType: 'TestWorkflow',
          input: undefined,
          headers: new Map<string, string>(),
        },
        () => {},
      );

      const generator = workflow.activity!(interception, next);
      let step = generator.next();
      while (!step.done) {
        step = generator.next(step.value);
      }

      expect(step.value).toBe(mockResult);
      expect(headers.has('traceparent')).toBe(true);
    });

    it('records span for sleep duration', () => {
      const spans: SpanInfo[] = [];
      const { workflow } = createObservabilityInterceptors({
        onSpanStart: (span) => spans.push({ ...span }),
        onSpanEnd: (span) => {
          const index = spans.findIndex((s) => s.spanId === span.spanId);
          if (index >= 0) {
            spans[index] = { ...span };
          }
        },
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

      const interception = {
        duration: 5000,
        headers: new Map<string, string>(),
      };

      const next = function* (_ctx: typeof interception) {};

      const generator = workflow.sleep!(interception, next);
      let step = generator.next();
      while (!step.done) {
        step = generator.next(step.value);
      }

      const sleepSpan = spans.find((s) => s.name === 'sleep');
      expect(sleepSpan).toBeDefined();
      expect(sleepSpan!.attributes['sleep.duration']).toBe(5000);
    });

    it('records span for signal wait', () => {
      const spans: SpanInfo[] = [];
      const { workflow } = createObservabilityInterceptors({
        onSpanStart: (span) => spans.push({ ...span }),
        onSpanEnd: (span) => {
          const index = spans.findIndex((s) => s.spanId === span.spanId);
          if (index >= 0) {
            spans[index] = { ...span };
          }
        },
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

      const interception = {
        signalName: 'approval',
        payload: { approved: true },
        headers: new Map<string, string>(),
      };

      const next = function* (_ctx: SignalInterception) {
        return 'signal-result';
      };

      const generator = workflow.waitForSignal!(interception, next);
      let step = generator.next();
      while (!step.done) {
        step = generator.next(step.value);
      }

      const signalSpan = spans.find((s) => s.name === 'waitForSignal');
      expect(signalSpan).toBeDefined();
      expect(signalSpan!.attributes['signal.name']).toBe('approval');
    });
  });

  describe('activity interceptor', () => {
    it('extracts trace context from headers', async () => {
      const { activity } = createObservabilityInterceptors();
      const headers = new Map<string, string>([
        ['traceparent', '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01'],
      ]);

      const interception = {
        activityName: 'doSomething',
        input: 'hello',
        attempt: 1,
        headers,
      };

      const next = async (_ctx: ActivityExecutionInterception) => 'result';

      const result = await activity.execute!(interception, next);
      expect(result).toBe('result');
    });
  });

  describe('callbacks', () => {
    it('onSpanStart and onSpanEnd callbacks fire', async () => {
      const startedSpans: SpanInfo[] = [];
      const endedSpans: SpanInfo[] = [];

      const { activity } = createObservabilityInterceptors({
        onSpanStart: (span) => startedSpans.push(span),
        onSpanEnd: (span) => endedSpans.push(span),
      });

      const headers = new Map<string, string>([
        ['traceparent', '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01'],
      ]);

      await activity.execute!(
        {
          activityName: 'doSomething',
          input: 'hello',
          attempt: 1,
          headers,
        },
        async () => 'ok',
      );

      expect(startedSpans).toHaveLength(1);
      expect(startedSpans[0]!.name).toBe('activity:doSomething');
      expect(endedSpans).toHaveLength(1);
      expect(endedSpans[0]!.status).toBe('ok');
      expect(endedSpans[0]!.endTime).toBeDefined();
    });
  });

  describe('recordPayloads option', () => {
    it('includes input as attribute when enabled', async () => {
      const endedSpans: SpanInfo[] = [];

      const { activity } = createObservabilityInterceptors({
        recordPayloads: true,
        onSpanEnd: (span) => endedSpans.push(span),
      });

      const headers = new Map<string, string>([
        ['traceparent', '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01'],
      ]);

      await activity.execute!(
        {
          activityName: 'doSomething',
          input: 'hello-world',
          attempt: 1,
          headers,
        },
        async () => 'ok',
      );

      expect(endedSpans).toHaveLength(1);
      expect(endedSpans[0]!.attributes['input']).toBe('"hello-world"');
    });

    it('does not include input when disabled', async () => {
      const endedSpans: SpanInfo[] = [];

      const { activity } = createObservabilityInterceptors({
        recordPayloads: false,
        onSpanEnd: (span) => endedSpans.push(span),
      });

      const headers = new Map<string, string>([
        ['traceparent', '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01'],
      ]);

      await activity.execute!(
        {
          activityName: 'doSomething',
          input: 'hello-world',
          attempt: 1,
          headers,
        },
        async () => 'ok',
      );

      expect(endedSpans).toHaveLength(1);
      expect(endedSpans[0]!.attributes['input']).toBeUndefined();
    });

    it('truncates payloads exceeding maxPayloadSize', async () => {
      const endedSpans: SpanInfo[] = [];

      const { activity } = createObservabilityInterceptors({
        recordPayloads: true,
        maxPayloadSize: 10,
        onSpanEnd: (span) => endedSpans.push(span),
      });

      const headers = new Map<string, string>([
        ['traceparent', '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01'],
      ]);

      await activity.execute!(
        {
          activityName: 'doSomething',
          input: 'this is a very long input string that exceeds the max',
          attempt: 1,
          headers,
        },
        async () => 'ok',
      );

      expect(endedSpans).toHaveLength(1);
      const inputAttribute = endedSpans[0]!.attributes['input'] as string;
      expect(inputAttribute.length).toBeLessThanOrEqual(13); // 10 + "..."
    });
  });

  describe('error handling', () => {
    it('error spans include error details', async () => {
      const endedSpans: SpanInfo[] = [];

      const { activity } = createObservabilityInterceptors({
        onSpanEnd: (span) => endedSpans.push(span),
      });

      const headers = new Map<string, string>([
        ['traceparent', '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01'],
      ]);

      try {
        await activity.execute!(
          {
            activityName: 'failingActivity',
            input: undefined,
            attempt: 1,
            headers,
          },
          async () => {
            throw new Error('something went wrong');
          },
        );
      } catch {
        // Expected
      }

      expect(endedSpans).toHaveLength(1);
      expect(endedSpans[0]!.status).toBe('error');
      expect(endedSpans[0]!.error).toBe('something went wrong');
    });

    it('activity interceptor handles non-Error thrown values', async () => {
      const endedSpans: SpanInfo[] = [];

      const { activity } = createObservabilityInterceptors({
        onSpanEnd: (span) => endedSpans.push(span),
      });

      const headers = new Map<string, string>([
        ['traceparent', '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01'],
      ]);

      try {
        await activity.execute!(
          {
            activityName: 'stringThrower',
            input: undefined,
            attempt: 1,
            headers,
          },
          async () => {
            throw 'string error value';
          },
        );
      } catch {
        // Expected
      }

      expect(endedSpans).toHaveLength(1);
      expect(endedSpans[0]!.status).toBe('error');
      expect(endedSpans[0]!.error).toBe('string error value');
    });
  });

  describe('workflow activity interceptor error handling', () => {
    it('records error span when activity generator throws', () => {
      const endedSpans: SpanInfo[] = [];
      const { workflow } = createObservabilityInterceptors({
        onSpanStart: () => {},
        onSpanEnd: (span) => endedSpans.push(span),
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

      const interception = {
        activityName: 'failingActivity',
        input: undefined,
        attempt: 1,
        headers: new Map<string, string>(),
      };

      const theError = new Error('activity failed');
      const next = function* (_ctx: ActivityInterception) {
        throw theError;
      };

      const generator = workflow.activity!(interception, next);
      try {
        let step = generator.next();
        while (!step.done) {
          step = generator.next(step.value);
        }
      } catch (error) {
        expect(error).toBe(theError);
      }

      const errorSpan = endedSpans.find((s) => s.status === 'error');
      expect(errorSpan).toBeDefined();
      expect(errorSpan!.error).toBe('activity failed');
    });

    it('records error span with non-Error thrown value', () => {
      const endedSpans: SpanInfo[] = [];
      const { workflow } = createObservabilityInterceptors({
        onSpanStart: () => {},
        onSpanEnd: (span) => endedSpans.push(span),
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

      const interception = {
        activityName: 'stringThrower',
        input: undefined,
        attempt: 1,
        headers: new Map<string, string>(),
      };

      const next = function* (_ctx: ActivityInterception) {
        throw 'non-error value';
      };

      const generator = workflow.activity!(interception, next);
      try {
        let step = generator.next();
        while (!step.done) {
          step = generator.next(step.value);
        }
      } catch {
        // Expected
      }

      const errorSpan = endedSpans.find((s) => s.status === 'error');
      expect(errorSpan).toBeDefined();
      expect(errorSpan!.error).toBe('non-error value');
    });
  });

  describe('waitForSignal error handling', () => {
    it('records error span when waitForSignal generator throws', () => {
      const endedSpans: SpanInfo[] = [];
      const { workflow } = createObservabilityInterceptors({
        onSpanStart: () => {},
        onSpanEnd: (span) => endedSpans.push(span),
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

      const interception = {
        signalName: 'test-signal',
        payload: undefined,
        headers: new Map<string, string>(),
      };

      const theError = new Error('signal failed');
      const next = function* (_ctx: SignalInterception) {
        throw theError;
      };

      const generator = workflow.waitForSignal!(interception, next);
      try {
        let step = generator.next();
        while (!step.done) {
          step = generator.next(step.value);
        }
      } catch (error) {
        expect(error).toBe(theError);
      }

      const errorSpan = endedSpans.find((s) => s.status === 'error');
      expect(errorSpan).toBeDefined();
      expect(errorSpan!.error).toBe('signal failed');
    });

    it('records error span with non-Error thrown value in waitForSignal', () => {
      const endedSpans: SpanInfo[] = [];
      const { workflow } = createObservabilityInterceptors({
        onSpanStart: () => {},
        onSpanEnd: (span) => endedSpans.push(span),
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

      const interception = {
        signalName: 'test-signal',
        payload: undefined,
        headers: new Map<string, string>(),
      };

      const next = function* (_ctx: SignalInterception) {
        throw 42;
      };

      const generator = workflow.waitForSignal!(interception, next);
      try {
        let step = generator.next();
        while (!step.done) {
          step = generator.next(step.value);
        }
      } catch {
        // Expected
      }

      const errorSpan = endedSpans.find((s) => s.status === 'error');
      expect(errorSpan).toBeDefined();
      expect(errorSpan!.error).toBe('42');
    });
  });

  describe('payload serialization', () => {
    it('handles non-serializable payloads in serializePayload', async () => {
      const endedSpans: SpanInfo[] = [];
      const { activity } = createObservabilityInterceptors({
        recordPayloads: true,
        onSpanEnd: (span) => endedSpans.push(span),
      });

      // Create a circular reference that JSON.stringify will fail on
      const circular: any = {};
      circular.self = circular;

      const headers = new Map<string, string>();

      await activity.execute!(
        {
          activityName: 'circularInput',
          input: circular,
          attempt: 1,
          headers,
        },
        async () => 'ok',
      );

      expect(endedSpans).toHaveLength(1);
      // When JSON.stringify fails, it falls back to String(input)
      expect(endedSpans[0]!.attributes['input']).toBeDefined();
    });

    it('records workflow start input when recordPayloads is enabled', () => {
      const startedSpans: SpanInfo[] = [];
      const { workflow } = createObservabilityInterceptors({
        recordPayloads: true,
        onSpanStart: (span) => startedSpans.push(span),
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

      const startSpan = startedSpans.find((s) => s.name.startsWith('workflow:'));
      expect(startSpan).toBeDefined();
      expect(startSpan!.attributes['input']).toBe('{"key":"value"}');
    });

    it('records activity input when recordPayloads is enabled (workflow interceptor)', () => {
      const startedSpans: SpanInfo[] = [];
      const { workflow } = createObservabilityInterceptors({
        recordPayloads: true,
        onSpanStart: (span) => startedSpans.push(span),
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

      const interception = {
        activityName: 'doSomething',
        input: 'hello',
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

      const activitySpan = startedSpans.find((s) => s.name.startsWith('activity:'));
      expect(activitySpan).toBeDefined();
      expect(activitySpan!.attributes['input']).toBe('"hello"');
    });
  });

  describe('activity interceptor without trace parent', () => {
    it('generates a new traceId when no traceparent header exists', async () => {
      const startedSpans: SpanInfo[] = [];
      const { activity } = createObservabilityInterceptors({
        onSpanStart: (span) => startedSpans.push(span),
      });

      const headers = new Map<string, string>(); // No traceparent

      await activity.execute!(
        {
          activityName: 'noTrace',
          input: undefined,
          attempt: 1,
          headers,
        },
        async () => 'ok',
      );

      expect(startedSpans).toHaveLength(1);
      expect(startedSpans[0]!.traceId).toBeDefined();
      expect(startedSpans[0]!.traceId.length).toBeGreaterThan(0);
      // No parent span id when there's no traceparent
      expect(startedSpans[0]!.parentSpanId).toBeUndefined();
    });
  });

  describe('workflow activity interceptor without prior workflowStart', () => {
    it('generates a new traceId when currentTraceId is empty', () => {
      const startedSpans: SpanInfo[] = [];
      const { workflow } = createObservabilityInterceptors({
        onSpanStart: (span) => startedSpans.push(span),
      });

      // Call activity without calling workflowStart first
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

      expect(startedSpans).toHaveLength(1);
      // traceparent should still be injected with a generated traceId
      expect(interception.headers.has('traceparent')).toBe(true);
    });
  });

  describe('attributeExtractor', () => {
    it('merges custom attributes into workflowStart span', () => {
      const startedSpans: SpanInfo[] = [];
      const { workflow } = createObservabilityInterceptors({
        onSpanStart: (span) => startedSpans.push(span),
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

      const span = startedSpans.find((s) => s.name.startsWith('workflow:'));
      expect(span).toBeDefined();
      expect(span!.attributes['custom.region']).toBe('us-east');
      expect(span!.attributes['custom.priority']).toBe(1);
    });

    it('merges custom attributes into activity span', () => {
      const startedSpans: SpanInfo[] = [];
      const { workflow } = createObservabilityInterceptors({
        onSpanStart: (span) => startedSpans.push(span),
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

      const activitySpan = startedSpans.find((s) => s.name.startsWith('activity:'));
      expect(activitySpan).toBeDefined();
      expect(activitySpan!.attributes['custom.region']).toBe('us-east');
    });

    it('merges custom attributes into sleep span', () => {
      const startedSpans: SpanInfo[] = [];
      const { workflow } = createObservabilityInterceptors({
        onSpanStart: (span) => startedSpans.push(span),
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

      const sleepSpan = startedSpans.find((s) => s.name === 'sleep');
      expect(sleepSpan).toBeDefined();
      expect(sleepSpan!.attributes['custom.region']).toBe('eu-west');
    });

    it('merges custom attributes into agent span', () => {
      const startedSpans: SpanInfo[] = [];
      const { workflow } = createObservabilityInterceptors({
        onSpanStart: (span) => startedSpans.push(span),
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

      const agentSpan = startedSpans.find((s) => s.name === 'agent');
      expect(agentSpan).toBeDefined();
      expect(agentSpan!.attributes['custom.env']).toBe('production');
    });

    it('passes interception context to the extractor', () => {
      const extractorCalls: Record<string, unknown>[] = [];
      const { workflow } = createObservabilityInterceptors({
        attributeExtractor: (ctx) => {
          extractorCalls.push({ ...ctx });
          return {};
        },
      });

      workflow.workflowStart!(
        {
          workflowId: 'wf-ctx-check',
          workflowType: 'MyWorkflow',
          input: { data: 123 },
          headers: new Map<string, string>(),
        },
        () => {},
      );

      expect(extractorCalls.length).toBeGreaterThanOrEqual(1);
      const call = extractorCalls[0]!;
      expect(call['workflowId']).toBe('wf-ctx-check');
      expect(call['workflowType']).toBe('MyWorkflow');
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

    it('returns a metrics collector even when not explicitly provided', () => {
      const { metrics } = createObservabilityInterceptors();
      expect(metrics).toBeDefined();
      expect(typeof metrics.increment).toBe('function');
      expect(typeof metrics.snapshot).toBe('function');
    });
  });

  describe('agent per-turn and per-tool-call span hierarchy', () => {
    it('creates child spans for agent turns', () => {
      const startedSpans: SpanInfo[] = [];
      const endedSpans: SpanInfo[] = [];
      const { workflow } = createObservabilityInterceptors({
        onSpanStart: (span) => startedSpans.push({ ...span }),
        onSpanEnd: (span) => endedSpans.push({ ...span }),
      });

      workflow.workflowStart!(
        {
          workflowId: 'wf-turn-spans',
          workflowType: 'TestWorkflow',
          input: undefined,
          headers: new Map<string, string>(),
        },
        () => {},
      );

      // The next function simulates the agent execution by invoking the
      // injected callbacks that the interceptor set on the interception.
      const next = function* (ctx: AgentInterception) {
        // Simulate turn 0
        ctx.onTurnStarted?.({ turnIndex: 0, model: 'test-model' });
        ctx.onTurnCompleted?.({
          turnIndex: 0,
          model: 'test-model',
          inputTokens: 100,
          outputTokens: 50,
          cost: 0.01,
          duration: 500,
          toolCallCount: 0,
        });

        // Simulate turn 1
        ctx.onTurnStarted?.({ turnIndex: 1, model: 'test-model' });
        ctx.onTurnCompleted?.({
          turnIndex: 1,
          model: 'test-model',
          inputTokens: 200,
          outputTokens: 100,
          cost: 0.02,
          duration: 600,
          toolCallCount: 0,
        });

        return 'agent-result';
      };

      const generator = workflow.agent!(
        { model: 'test-model', prompt: 'hello', headers: new Map() },
        next,
      );
      let step = generator.next();
      while (!step.done) {
        step = generator.next(step.value);
      }

      // Verify the span hierarchy: agent > turn:0, turn:1
      const agentSpan = startedSpans.find((s) => s.name === 'agent');
      expect(agentSpan).toBeDefined();

      const turnSpans = startedSpans.filter((s) => s.name.startsWith('agent:turn:'));
      expect(turnSpans).toHaveLength(2);
      expect(turnSpans[0]!.name).toBe('agent:turn:0');
      expect(turnSpans[1]!.name).toBe('agent:turn:1');

      // Turn spans should be children of the agent span
      expect(turnSpans[0]!.parentSpanId).toBe(agentSpan!.spanId);
      expect(turnSpans[1]!.parentSpanId).toBe(agentSpan!.spanId);

      // Turn spans should have correct attributes
      expect(turnSpans[0]!.attributes['weft.agent.model']).toBe('test-model');
      expect(turnSpans[0]!.attributes['weft.agent.turn_index']).toBe(0);
      expect(turnSpans[1]!.attributes['weft.agent.turn_index']).toBe(1);

      // Turn spans should be ended with cost attribute
      const endedTurnSpans = endedSpans.filter((s) => s.name.startsWith('agent:turn:'));
      expect(endedTurnSpans).toHaveLength(2);
      expect(endedTurnSpans[0]!.attributes['weft.agent.cost']).toBe(0.01);
      expect(endedTurnSpans[1]!.attributes['weft.agent.cost']).toBe(0.02);
    });

    it('creates child spans for tool calls within turns', () => {
      const startedSpans: SpanInfo[] = [];
      const endedSpans: SpanInfo[] = [];
      const { workflow } = createObservabilityInterceptors({
        onSpanStart: (span) => startedSpans.push({ ...span }),
        onSpanEnd: (span) => endedSpans.push({ ...span }),
      });

      workflow.workflowStart!(
        {
          workflowId: 'wf-tool-spans',
          workflowType: 'TestWorkflow',
          input: undefined,
          headers: new Map<string, string>(),
        },
        () => {},
      );

      const next = function* (ctx: AgentInterception) {
        // Simulate turn 0 with 2 tool calls
        ctx.onTurnStarted?.({ turnIndex: 0, model: 'test-model' });
        ctx.onToolCalled?.({ turnIndex: 0, toolName: 'readFile' });
        ctx.onToolReturned?.({ turnIndex: 0, toolName: 'readFile', duration: 100, success: true });
        ctx.onToolCalled?.({ turnIndex: 0, toolName: 'writeFile' });
        ctx.onToolReturned?.({
          turnIndex: 0,
          toolName: 'writeFile',
          duration: 50,
          success: false,
        });
        ctx.onTurnCompleted?.({
          turnIndex: 0,
          model: 'test-model',
          inputTokens: 100,
          outputTokens: 50,
          cost: 0.01,
          duration: 500,
          toolCallCount: 2,
        });

        return 'agent-result';
      };

      const generator = workflow.agent!(
        { model: 'test-model', prompt: 'hello', headers: new Map() },
        next,
      );
      let step = generator.next();
      while (!step.done) {
        step = generator.next(step.value);
      }

      // Verify tool call spans were created
      const toolCallStartSpans = startedSpans.filter((s) => s.name.startsWith('agent:tool:call:'));
      expect(toolCallStartSpans).toHaveLength(2);
      expect(toolCallStartSpans[0]!.name).toBe('agent:tool:call:readFile');
      expect(toolCallStartSpans[1]!.name).toBe('agent:tool:call:writeFile');

      // Verify tool return spans were ended
      const toolEndSpans = endedSpans.filter((s) => s.name.startsWith('agent:tool:call:'));
      expect(toolEndSpans).toHaveLength(2);
      expect(toolEndSpans[0]!.status).toBe('ok');
      expect(toolEndSpans[1]!.status).toBe('error');
      expect(toolEndSpans[0]!.attributes['tool.name']).toBe('readFile');
      expect(toolEndSpans[1]!.attributes['tool.name']).toBe('writeFile');
      expect(toolEndSpans[0]!.attributes['tool.success']).toBe(true);
      expect(toolEndSpans[1]!.attributes['tool.success']).toBe(false);
    });

    it('produces correct span tree: agent > turn > tool', () => {
      const startedSpans: SpanInfo[] = [];
      const endedSpans: SpanInfo[] = [];
      const { workflow } = createObservabilityInterceptors({
        onSpanStart: (span) => startedSpans.push({ ...span }),
        onSpanEnd: (span) => endedSpans.push({ ...span }),
      });

      workflow.workflowStart!(
        {
          workflowId: 'wf-tree',
          workflowType: 'TestWorkflow',
          input: undefined,
          headers: new Map<string, string>(),
        },
        () => {},
      );

      const next = function* (ctx: AgentInterception) {
        // Turn 0: 2 tool calls
        ctx.onTurnStarted?.({ turnIndex: 0, model: 'claude-3' });
        ctx.onToolCalled?.({ turnIndex: 0, toolName: 'tool_a' });
        ctx.onToolReturned?.({ turnIndex: 0, toolName: 'tool_a', duration: 10, success: true });
        ctx.onToolCalled?.({ turnIndex: 0, toolName: 'tool_b' });
        ctx.onToolReturned?.({ turnIndex: 0, toolName: 'tool_b', duration: 20, success: true });
        ctx.onTurnCompleted?.({
          turnIndex: 0,
          model: 'claude-3',
          inputTokens: 100,
          outputTokens: 50,
          cost: 0.01,
          duration: 500,
          toolCallCount: 2,
        });

        // Turn 1: 1 tool call
        ctx.onTurnStarted?.({ turnIndex: 1, model: 'claude-3' });
        ctx.onToolCalled?.({ turnIndex: 1, toolName: 'tool_c' });
        ctx.onToolReturned?.({ turnIndex: 1, toolName: 'tool_c', duration: 15, success: true });
        ctx.onTurnCompleted?.({
          turnIndex: 1,
          model: 'claude-3',
          inputTokens: 200,
          outputTokens: 100,
          cost: 0.02,
          duration: 600,
          toolCallCount: 1,
        });

        // Turn 2: final answer (no tools)
        ctx.onTurnStarted?.({ turnIndex: 2, model: 'claude-3' });
        ctx.onTurnCompleted?.({
          turnIndex: 2,
          model: 'claude-3',
          inputTokens: 300,
          outputTokens: 150,
          cost: 0.03,
          duration: 400,
          toolCallCount: 0,
        });

        return 'done';
      };

      const generator = workflow.agent!(
        { model: 'claude-3', prompt: 'do stuff', headers: new Map() },
        next,
      );
      let step = generator.next();
      while (!step.done) {
        step = generator.next(step.value);
      }

      // Verify the full span tree
      const agentSpan = startedSpans.find((s) => s.name === 'agent');
      const turnSpans = startedSpans.filter((s) => s.name.startsWith('agent:turn:'));
      const toolCallStartSpans = startedSpans.filter((s) => s.name.startsWith('agent:tool:call:'));

      expect(agentSpan).toBeDefined();
      expect(turnSpans).toHaveLength(3);
      expect(toolCallStartSpans).toHaveLength(3);

      // All turn spans are children of the agent span
      for (const turnSpan of turnSpans) {
        expect(turnSpan.parentSpanId).toBe(agentSpan!.spanId);
      }

      // Tool call start spans: readFile and writeFile in turn 0 should be
      // parented to turn 0's span
      const turn0Span = turnSpans.find((s) => s.name === 'agent:turn:0');
      const toolASpan = toolCallStartSpans.find((s) => s.name === 'agent:tool:call:tool_a');
      const toolBSpan = toolCallStartSpans.find((s) => s.name === 'agent:tool:call:tool_b');
      expect(toolASpan!.parentSpanId).toBe(turn0Span!.spanId);
      expect(toolBSpan!.parentSpanId).toBe(turn0Span!.spanId);

      // Tool call in turn 1 should be parented to turn 1's span
      const turn1Span = turnSpans.find((s) => s.name === 'agent:turn:1');
      const toolCSpan = toolCallStartSpans.find((s) => s.name === 'agent:tool:call:tool_c');
      expect(toolCSpan!.parentSpanId).toBe(turn1Span!.spanId);

      // Agent span should have same traceId as all children
      for (const childSpan of [...turnSpans, ...toolCallStartSpans]) {
        expect(childSpan.traceId).toBe(agentSpan!.traceId);
      }

      // Agent span should be ended
      const endedAgentSpan = endedSpans.find((s) => s.name === 'agent');
      expect(endedAgentSpan).toBeDefined();
      expect(endedAgentSpan!.status).toBe('ok');
    });

    it('preserves original callbacks when interceptor injects new ones', () => {
      const startedSpans: SpanInfo[] = [];
      const { workflow } = createObservabilityInterceptors({
        onSpanStart: (span) => startedSpans.push({ ...span }),
        onSpanEnd: () => {},
      });

      workflow.workflowStart!(
        {
          workflowId: 'wf-preserve-callbacks',
          workflowType: 'TestWorkflow',
          input: undefined,
          headers: new Map<string, string>(),
        },
        () => {},
      );

      const originalTurnStartCalls: number[] = [];
      const originalInterception: AgentInterception = {
        model: 'test-model',
        prompt: 'hello',
        headers: new Map(),
        onTurnStarted: (info) => originalTurnStartCalls.push(info.turnIndex),
      };

      const next = function* (ctx: AgentInterception) {
        ctx.onTurnStarted?.({ turnIndex: 0, model: 'test-model' });
        ctx.onTurnCompleted?.({
          turnIndex: 0,
          model: 'test-model',
          inputTokens: 10,
          outputTokens: 5,
          cost: 0,
          duration: 100,
          toolCallCount: 0,
        });
        return 'result';
      };

      const generator = workflow.agent!(originalInterception, next);
      let step = generator.next();
      while (!step.done) {
        step = generator.next(step.value);
      }

      // Both the original callback and the interceptor's spans should fire
      expect(originalTurnStartCalls).toEqual([0]);
      const turnSpans = startedSpans.filter((s) => s.name.startsWith('agent:turn:'));
      expect(turnSpans).toHaveLength(1);
    });
  });
});
