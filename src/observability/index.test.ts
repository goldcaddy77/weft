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
  });
});
