# Observability

Your workflows are running in production. Something is slow, but you can't tell whether it's the payment activity, the shipping call, or the sleep between them. You need traces, spans, and metrics---without instrumenting every workflow by hand. Weft's observability module is a pre-built [interceptor](./interceptors.md) pair that gives you all of this out of the box.

## Quick setup

Import the factory, pass the engine as the `eventTarget`, and register the interceptors.

```typescript
import { createObservabilityInterceptors } from 'weft';

const { workflow, activity, dispose } = createObservabilityInterceptors({
  eventTarget: engine,
});

engine.addInterceptor(workflow);
engine.addActivityInterceptor(activity);
```

That's it. Every workflow start, activity call, sleep, and signal wait now produces spans with trace context propagation. Wiring the engine as the `eventTarget` lets the factory subscribe to workflow lifecycle events (`workflow:completed`, `workflow:failed`, `workflow:cancelled`, `workflow:timed-out`) and automatically end the root workflow span with the right status. Without it, root spans would stay "in progress" forever and the internal span map would grow unbounded.

When tearing down the engine, call `dispose()` to unsubscribe those listeners and end any spans that are still open. If you're using [remote workers](./remote-workers.md), pass the activity interceptor to them too.

## Configuration

The `createObservabilityInterceptors()` factory accepts options for controlling what gets recorded:

```typescript
interface ObservabilityOptions {
  tracerName?: string; // Name passed to trace.getTracer(). Default: 'weft'.
  tracerVersion?: string; // Version passed to trace.getTracer().
  recordPayloads?: boolean; // Record activity/workflow inputs as span attributes. Default: false.
  maxPayloadSize?: number; // Maximum serialized payload size in bytes. Default: 1024.
  attributeExtractor?: (
    interception: InterceptionContext,
  ) => Record<string, string | number | boolean>;
  metrics?: MetricsCollectorClass; // Metrics collector for counters, histograms, gauges.
  otelApi?: OtelApi; // Override OTel API instance (primarily for testing).
  eventTarget?: EventTarget; // Engine instance; enables auto-close of root spans on lifecycle events.
}
```

Use `recordPayloads` and `maxPayloadSize` to control payload attributes, `attributeExtractor` to add domain-specific span attributes, and `eventTarget` to let the interceptor factory close root spans from engine lifecycle events.

```typescript
const { workflow, activity } = createObservabilityInterceptors({
  eventTarget: engine,
  recordPayloads: true,
  maxPayloadSize: 2048,
  attributeExtractor: () => ({ 'service.name': 'checkout' }),
});
```

## Span hierarchy

Each workflow execution creates a root span. Context operations create child spans:

```
workflow:order (root span)
  activity:charge (child span)
  sleep (child span)
  activity:ship (child span)
```

Attributes include `workflow.id`, `workflow.type`, `activity.name`, `activity.attempt`, and optionally the serialized `input` payload.

## W3C Trace Context propagation

The observability interceptors use the [interceptor headers mechanism](./interceptors.md) to propagate W3C Trace Context across thread and network boundaries. The workflow interceptor injects a `traceparent` header before each activity call. The activity interceptor extracts it and creates a child span.

```
Workflow Worker                         Activity Worker
------------------                      ------------------
creates span A                          extracts traceparent from headers
injects traceparent into headers        creates span B (child of A)
yields ctx.run(...)                     executes activity function
   ---- postMessage/WebSocket ---->
   (includes headers map)
   <--- result ----
span A ends                             span B ends
```

The propagation helpers are exported individually if you need them:

```typescript
import { generateTraceId, generateSpanId, formatTraceParent, parseTraceParent } from 'weft';
```

`generateTraceId()` produces a 32-hex-character (16-byte) random trace ID. `generateSpanId()` produces a 16-hex-character (8-byte) random span ID. Both use `crypto.randomBytes()` under the hood.

The `traceparent` header uses the standard `{version}-{traceId}-{spanId}-{flags}` format. `formatTraceParent()` serializes that shape, and `parseTraceParent()` goes the other direction, returning `null` for invalid inputs or all-zero IDs.

## Metrics

The `METRICS` object defines the metric catalogue:

```typescript
import { METRICS } from 'weft';

// METRICS.workflowDuration
//   name: 'weft.workflow.duration', type: 'histogram', unit: 'ms'
// METRICS.activityDuration
//   name: 'weft.activity.duration', type: 'histogram', unit: 'ms'
// METRICS.activityAttempts
//   name: 'weft.activity.attempts', type: 'counter', unit: 'attempts'
// METRICS.workflowActive
//   name: 'weft.workflow.active', type: 'gauge', unit: 'workflows'
// METRICS.workflowStarted
//   name: 'weft.workflow.started', type: 'counter', unit: 'workflows'
// METRICS.workflowCompleted
//   name: 'weft.workflow.completed', type: 'counter', unit: 'workflows'
// METRICS.workflowFailed
//   name: 'weft.workflow.failed', type: 'counter', unit: 'workflows'
```

Each metric has a `name`, `description`, `unit`, and `type` (counter, gauge, or histogram). The [server](./server.md) exposes these at `GET /v1/metrics` in Prometheus-compatible text format.

## Composing with other interceptors

Observability interceptors are just regular interceptors. Compose them with your own by controlling registration order. The first registered interceptor is the outermost wrapper.

```typescript
engine.addInterceptor(authInterceptor); // 1. Check auth
engine.addInterceptor(validationInterceptor); // 2. Validate inputs
engine.addInterceptor(observabilityWorkflow); // 3. Trace the validated, authorized call
engine.addInterceptor(encryptionInterceptor); // 4. Encrypt before sending to worker
```

In this arrangement, the observability span captures the call _after_ auth and validation have passed but _before_ encryption. The span timings reflect the actual activity execution, not the overhead of validation and encryption. Adjust the order to match what you want to measure.

The activity interceptor follows the same pattern:

```typescript
engine.addActivityInterceptor(observabilityActivity);
engine.addActivityInterceptor(decryptionInterceptor);
```

If you're building a custom interceptor that also needs trace context, let the observability interceptor handle extraction. It reads the propagated `traceparent` header internally and parses it with `parseTraceParent()`.

Traces stitch together automatically as long as the headers propagate through the interceptor chain.
