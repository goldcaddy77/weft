import { describe, expect, it } from 'bun:test';

import type { ActivityInterception } from '../core/interceptor';
import { createObservabilityInterceptors, extractTraceParent } from './index';
import type { OtelApi, OtelSpan, OtelTracer } from './no-op-telemetry';

/**
 * Drive a generator to completion, pumping each yielded value back in.
 * Returns the generator's final return value.
 */
function driveGenerator<T>(gen: Generator<unknown, T, unknown>): T {
  let step = gen.next();
  while (!step.done) {
    step = gen.next(step.value);
  }
  return step.value;
}

// ---------------------------------------------------------------------------
// Recording tracer: captures span contexts for verifying trace propagation
// ---------------------------------------------------------------------------

type RecordedSpan = {
  name: string;
  attributes: Record<string, string | number | boolean>;
  parentContext?: unknown;
  ended: boolean;
  spanContext: { traceId: string; spanId: string; traceFlags: number };
};

let spanCounter = 0;

function createRecordingTracer(): { tracer: OtelTracer; spans: RecordedSpan[] } {
  const spans: RecordedSpan[] = [];

  const tracer: OtelTracer = {
    startSpan(name: string, options?, _context?): OtelSpan {
      const id = String(++spanCounter).padStart(16, '0');
      const traceId = 'a'.repeat(32);
      const recorded: RecordedSpan = {
        name,
        attributes: { ...options?.attributes },
        parentContext: _context,
        ended: false,
        spanContext: { traceId, spanId: id, traceFlags: 1 },
      };
      spans.push(recorded);

      return {
        setAttribute(key: string, value: string | number | boolean) {
          recorded.attributes[key] = value;
        },
        setStatus() {},
        recordException() {},
        end() {
          recorded.ended = true;
        },
        spanContext() {
          return recorded.spanContext;
        },
      };
    },
  };

  return { tracer, spans };
}

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

describe('remote worker trace propagation', () => {
  it('workflow activity hook injects traceparent that the activity interceptor extracts on the remote side', async () => {
    const { tracer: wfTracer } = createRecordingTracer();
    const { tracer: workerTracer, spans: workerSpans } = createRecordingTracer();

    const workflowSide = createObservabilityInterceptors({
      otelApi: createMockOtelApi(wfTracer),
    });
    const workerSide = createObservabilityInterceptors({
      otelApi: createMockOtelApi(workerTracer),
    });

    // 1. Establish the workflow's trace context via workflowStart.
    workflowSide.workflow.workflowStart!(
      {
        workflowId: 'wf-remote-1',
        workflowType: 'OrderProcessing',
        input: { orderId: 42 },
        headers: new Map<string, string>(),
      },
      () => {},
    );

    // 2. Dispatch an activity — the workflow interceptor injects traceparent.
    const activityHeaders = new Map<string, string>();
    const activityInterception: ActivityInterception = {
      activityName: 'chargeCard',
      input: { amount: 99 },
      attempt: 1,
      headers: activityHeaders,
    };

    driveGenerator(
      workflowSide.workflow.activity!(activityInterception, function* () {
        return 'dispatched';
      }),
    );

    // 3. Verify the workflow interceptor injected a valid traceparent.
    expect(activityHeaders.has('traceparent')).toBe(true);
    const injectedContext = extractTraceParent(activityHeaders);
    expect(injectedContext).not.toBeNull();
    expect(injectedContext!.traceId).toHaveLength(32);
    expect(injectedContext!.spanId).toHaveLength(16);

    // 4. Simulate the server serialization boundary: Map → Record → JSON → Record → Map.
    const serializedHeaders: Record<string, string> = Object.fromEntries(activityHeaders);
    const remoteHeaders = new Map<string, string>(Object.entries(serializedHeaders));

    // 5. Run the activity interceptor on the remote worker side.
    let activityExecuted = false;
    await workerSide.activity.execute!(
      {
        activityName: 'chargeCard',
        input: { amount: 99 },
        attempt: 1,
        operationId: 'op-remote-1',
        headers: remoteHeaders,
      },
      async () => {
        activityExecuted = true;
        return 'charged';
      },
    );

    expect(activityExecuted).toBe(true);

    // 6. Verify the remote worker created a span for the activity.
    const remoteSpan = workerSpans.find((s) => s.name.includes('chargeCard'));
    expect(remoteSpan).toBeDefined();
    expect(remoteSpan!.ended).toBe(true);
  });

  it('round-trips through JSON serialization without losing trace context', async () => {
    const { tracer } = createRecordingTracer();
    const workflowSide = createObservabilityInterceptors({
      otelApi: createMockOtelApi(tracer),
    });

    workflowSide.workflow.workflowStart!(
      {
        workflowId: 'wf-json-rt',
        workflowType: 'TestWorkflow',
        input: undefined,
        headers: new Map<string, string>(),
      },
      () => {},
    );

    const headers = new Map<string, string>();
    driveGenerator(
      workflowSide.workflow.activity!(
        { activityName: 'process', input: 'data', attempt: 1, headers },
        function* () {
          return 'ok';
        },
      ),
    );

    // Full JSON round-trip, as the WebSocket transport does.
    const wirePayload = JSON.stringify({
      type: 'task',
      operationId: 'op-json-rt',
      activityName: 'process',
      input: 'data',
      attempt: 1,
      headers: Object.fromEntries(headers),
    });

    const parsed = JSON.parse(wirePayload);
    const reconstructedHeaders = new Map<string, string>(Object.entries(parsed.headers));

    // The traceparent must survive the round-trip intact.
    const traceContext = extractTraceParent(reconstructedHeaders);
    expect(traceContext).not.toBeNull();
    expect(traceContext!.traceId).toHaveLength(32);
    expect(traceContext!.spanId).toHaveLength(16);
    expect(traceContext!.traceFlags).toBe(1);
  });

  it('activity interceptor creates a span when no traceparent is present', async () => {
    const { tracer, spans } = createRecordingTracer();
    const { activity } = createObservabilityInterceptors({
      otelApi: createMockOtelApi(tracer),
    });

    // Simulate a remote worker receiving a task with no headers.
    await activity.execute!(
      {
        activityName: 'standaloneTask',
        input: 'hello',
        attempt: 1,
        headers: new Map<string, string>(),
      },
      async () => 'done',
    );

    // A span should still be created even without parent trace context.
    const span = spans.find((s) => s.name.includes('standaloneTask'));
    expect(span).toBeDefined();
    expect(span!.ended).toBe(true);
  });

  it('multiple activities in the same workflow get distinct traceparent headers', () => {
    const { tracer } = createRecordingTracer();
    const workflowSide = createObservabilityInterceptors({
      otelApi: createMockOtelApi(tracer),
    });

    workflowSide.workflow.workflowStart!(
      {
        workflowId: 'wf-multi',
        workflowType: 'MultiStep',
        input: undefined,
        headers: new Map<string, string>(),
      },
      () => {},
    );

    // Dispatch two activities from the same workflow.
    const headers1 = new Map<string, string>();
    driveGenerator(
      workflowSide.workflow.activity!(
        { activityName: 'step1', input: 'a', attempt: 1, headers: headers1 },
        function* () {
          return 'r1';
        },
      ),
    );

    const headers2 = new Map<string, string>();
    driveGenerator(
      workflowSide.workflow.activity!(
        { activityName: 'step2', input: 'b', attempt: 1, headers: headers2 },
        function* () {
          return 'r2';
        },
      ),
    );

    // Both should carry valid traceparent headers.
    const ctx1 = extractTraceParent(headers1);
    const ctx2 = extractTraceParent(headers2);
    expect(ctx1).not.toBeNull();
    expect(ctx2).not.toBeNull();

    // Same traceId (same workflow), different spanIds (different activities).
    expect(ctx1!.traceId).toBe(ctx2!.traceId);
    expect(ctx1!.spanId).not.toBe(ctx2!.spanId);
  });
});
