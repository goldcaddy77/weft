import { describe, expect, it } from 'bun:test';

import type { ActivityInterception } from '../core/interceptor';
import type { SpanInfo } from './index';
import { createObservabilityInterceptors, extractTraceParent } from './index';

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

describe('remote worker trace propagation', () => {
  it('workflow activity hook injects traceparent that the activity interceptor extracts on the remote side', async () => {
    const workflowSpans: SpanInfo[] = [];
    const activitySpans: SpanInfo[] = [];

    // Create separate interceptor instances — one for the workflow side,
    // one for the remote worker side — mirroring real deployment topology.
    const workflowSide = createObservabilityInterceptors({
      onSpanStart: (span) => workflowSpans.push({ ...span }),
      onSpanEnd: (span) => {
        const index = workflowSpans.findIndex((s) => s.spanId === span.spanId);
        if (index >= 0) workflowSpans[index] = { ...span };
      },
    });

    const workerSide = createObservabilityInterceptors({
      onSpanStart: (span) => activitySpans.push({ ...span }),
      onSpanEnd: (span) => {
        const index = activitySpans.findIndex((s) => s.spanId === span.spanId);
        if (index >= 0) activitySpans[index] = { ...span };
      },
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
      workflowSide.workflow.activity!(activityInterception, function* (_ctx) {
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
    //    The server spreads headers as a plain object into the WebSocket task message
    //    (src/server/index.ts:1221), and the worker reconstructs a Map from that object
    //    (src/worker/execute-with-interceptors.ts:46).
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
      async (_interception) => {
        activityExecuted = true;
        return 'charged';
      },
    );

    expect(activityExecuted).toBe(true);

    // 6. Verify the remote activity span is linked to the workflow trace.
    const remoteSpan = activitySpans.find((s) => s.name === 'activity:chargeCard');
    expect(remoteSpan).toBeDefined();
    expect(remoteSpan!.traceId).toBe(injectedContext!.traceId);
    expect(remoteSpan!.parentSpanId).toBe(injectedContext!.spanId);

    // The remote span should have its own unique spanId (not reusing the parent).
    expect(remoteSpan!.spanId).not.toBe(injectedContext!.spanId);
    expect(remoteSpan!.spanId).toHaveLength(16);
  });

  it('round-trips through JSON serialization without losing trace context', async () => {
    const activitySpans: SpanInfo[] = [];

    const workflowSide = createObservabilityInterceptors();
    const workerSide = createObservabilityInterceptors({
      onSpanStart: (span) => activitySpans.push({ ...span }),
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

    await workerSide.activity.execute!(
      {
        activityName: 'process',
        input: 'data',
        attempt: 1,
        operationId: 'op-json-rt',
        headers: reconstructedHeaders,
      },
      async () => 'result',
    );

    const span = activitySpans.find((s) => s.name === 'activity:process');
    expect(span).toBeDefined();
    expect(span!.traceId).toBe(traceContext!.traceId);
    expect(span!.parentSpanId).toBe(traceContext!.spanId);
  });

  it('activity interceptor creates a standalone span when no traceparent is present', async () => {
    const activitySpans: SpanInfo[] = [];

    const { activity } = createObservabilityInterceptors({
      onSpanStart: (span) => activitySpans.push({ ...span }),
    });

    // Simulate a remote worker receiving a task with no headers (e.g., from
    // a workflow that had no observability interceptor configured).
    await activity.execute!(
      {
        activityName: 'standaloneTask',
        input: 'hello',
        attempt: 1,
        headers: new Map<string, string>(),
      },
      async () => 'done',
    );

    expect(activitySpans).toHaveLength(1);
    const span = activitySpans[0]!;
    expect(span.name).toBe('activity:standaloneTask');

    // A fresh traceId should be generated, not empty.
    expect(span.traceId).toHaveLength(32);
    expect(span.spanId).toHaveLength(16);

    // No parent span since there was no traceparent to extract.
    expect(span.parentSpanId).toBeUndefined();
  });

  it('multiple activities in the same workflow share the same traceId but have unique spanIds', async () => {
    const activitySpans: SpanInfo[] = [];

    const workflowSide = createObservabilityInterceptors();
    const workerSide = createObservabilityInterceptors({
      onSpanStart: (span) => activitySpans.push({ ...span }),
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

    // Both should carry the same traceId but different spanIds.
    const ctx1 = extractTraceParent(headers1);
    const ctx2 = extractTraceParent(headers2);
    expect(ctx1).not.toBeNull();
    expect(ctx2).not.toBeNull();
    expect(ctx1!.traceId).toBe(ctx2!.traceId);
    expect(ctx1!.spanId).not.toBe(ctx2!.spanId);

    // Execute both on the remote worker side.
    for (const [name, headers, opId] of [
      ['step1', headers1, 'op-m1'],
      ['step2', headers2, 'op-m2'],
    ] as const) {
      const remoteHeaders = new Map<string, string>(
        Object.entries(Object.fromEntries(headers)),
      );
      await workerSide.activity.execute!(
        {
          activityName: name,
          input: 'x',
          attempt: 1,
          operationId: opId,
          headers: remoteHeaders,
        },
        async () => 'done',
      );
    }

    // Both remote spans share the workflow trace.
    expect(activitySpans).toHaveLength(2);
    expect(activitySpans[0]!.traceId).toBe(activitySpans[1]!.traceId);
    expect(activitySpans[0]!.traceId).toBe(ctx1!.traceId);

    // Each remote span's parentSpanId matches the corresponding activity child span
    // injected by the workflow interceptor.
    expect(activitySpans[0]!.parentSpanId).toBe(ctx1!.spanId);
    expect(activitySpans[1]!.parentSpanId).toBe(ctx2!.spanId);

    // Each remote span has its own unique spanId.
    expect(activitySpans[0]!.spanId).not.toBe(activitySpans[1]!.spanId);
  });
});
