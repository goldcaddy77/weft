import { describe, expect, it } from 'bun:test';

import type {
  ActivityExecutionInterception,
  ActivityInterception,
  SignalInterception,
} from '../core/interceptor';
import type { SpanInfo } from './index';
import { createObservabilityInterceptors } from './index';

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
});
