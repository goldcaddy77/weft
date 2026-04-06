# Observability API Reference

The observability module provides interceptors for W3C Trace Context propagation, span-like lifecycle events, and a metric catalogue following OpenTelemetry semantic conventions. Wire it up to the engine with `addInterceptor()` and `addActivityInterceptor()`.

For a guided walkthrough, see the [Observability guide](../guides/observability.md).

---

## `createObservabilityInterceptors(options?)`

Factory that creates a matched pair of workflow and activity interceptors. The workflow interceptor propagates trace context and emits spans for workflow start, activity calls, sleeps, and signal waits. The activity interceptor extracts trace context from headers and wraps activity execution in a span.

```ts
function createObservabilityInterceptors(options?: ObservabilityOptions): {
  workflow: WorkflowInterceptor;
  activity: ActivityInterceptor;
  metrics: MetricsCollector;
  /**
   * End the workflow root span. Usually wired automatically via `eventTarget`,
   * but exposed for callers that need to end spans manually.
   */
  endWorkflowSpan: (workflowId: string, status: 'ok' | 'error', errorMessage?: string) => void;
  /**
   * Unsubscribe workflow lifecycle listeners and end any still-open workflow
   * spans. Call when tearing down the engine so the interceptor doesn't leak.
   */
  dispose: () => void;
};
```

> [!IMPORTANT]
> Pass your `Engine` instance as `options.eventTarget`. The factory then subscribes to the engine's workflow lifecycle events (`workflow:completed`, `workflow:failed`, `workflow:cancelled`, `workflow:timed-out`) and automatically ends the root span with the appropriate status. Without this wiring, root spans stay "in progress" forever and the internal span map grows unbounded.

### `ObservabilityOptions`

| Field            | Type                       | Default     | Description                                                                                                                                                    |
| ---------------- | -------------------------- | ----------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `recordPayloads` | `boolean`                  | `false`     | Record activity/workflow inputs as span attributes                                                                                                             |
| `maxPayloadSize` | `number`                   | `1024`      | Maximum serialized payload size in bytes before truncation                                                                                                     |
| `eventTarget`    | `EventTarget`              | `undefined` | Engine (or other `EventTarget`) that dispatches workflow lifecycle and agent events. Required for automatic root-span cleanup and for per-turn/per-tool spans. |
| `onSpanStart`    | `(span: SpanInfo) => void` | `undefined` | Callback when a span starts                                                                                                                                    |
| `onSpanEnd`      | `(span: SpanInfo) => void` | `undefined` | Callback when a span ends                                                                                                                                      |

### `SpanInfo`

```ts
interface SpanInfo {
  name: string;
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  attributes: Record<string, string | number | boolean>;
  startTime: number;
  endTime?: number;
  status?: 'ok' | 'error';
  error?: string;
}
```

Span names follow the pattern `workflow:<type>`, `activity:<name>`, `sleep`, or `waitForSignal`.

**Example:**

```ts
import { createObservabilityInterceptors, Engine } from 'weft';

const engine = new Engine();

const { workflow, activity, dispose } = createObservabilityInterceptors({
  recordPayloads: true,
  eventTarget: engine, // enables automatic root-span cleanup on terminal events
});

engine.addInterceptor(workflow);
engine.addActivityInterceptor(activity);

// When tearing down:
// dispose();
// engine[Symbol.dispose]();
```

---

## Metrics

### `METRICS`

A catalogue of metric definitions emitted by Weft. Each entry contains the metric `name`, `description`, `unit`, and `type`. These follow OpenTelemetry conventions and can be consumed by any metrics backend.

```ts
const METRICS: {
  workflowDuration: MetricDefinition;
  activityDuration: MetricDefinition;
  activityAttempts: MetricDefinition;
  workflowActive: MetricDefinition;
  workflowStarted: MetricDefinition;
  workflowCompleted: MetricDefinition;
  workflowFailed: MetricDefinition;
};
```

| Key                 | Name                      | Type        | Unit        | Description                     |
| ------------------- | ------------------------- | ----------- | ----------- | ------------------------------- |
| `workflowDuration`  | `weft.workflow.duration`  | `histogram` | `ms`        | Duration of workflow execution  |
| `activityDuration`  | `weft.activity.duration`  | `histogram` | `ms`        | Duration of activity execution  |
| `activityAttempts`  | `weft.activity.attempts`  | `histogram` | `attempts`  | Number of attempts per activity |
| `workflowActive`    | `weft.workflow.active`    | `gauge`     | `workflows` | Currently active workflows      |
| `workflowStarted`   | `weft.workflow.started`   | `counter`   | `workflows` | Total workflows started         |
| `workflowCompleted` | `weft.workflow.completed` | `counter`   | `workflows` | Total workflows completed       |
| `workflowFailed`    | `weft.workflow.failed`    | `counter`   | `workflows` | Total workflows failed          |

### `MetricDefinition`

```ts
interface MetricDefinition {
  name: string;
  description: string;
  unit: string;
  type: MetricType;
}

type MetricType = 'counter' | 'gauge' | 'histogram';
```

---

## Trace Propagation

Implements parsing, formatting, and injection/extraction of the W3C `traceparent` header.

### `generateTraceId()`

Generate a random trace ID -- 32 hex characters (16 bytes).

```ts
function generateTraceId(): string;
```

### `generateSpanId()`

Generate a random span ID -- 16 hex characters (8 bytes).

```ts
function generateSpanId(): string;
```

### `formatTraceParent(context)`

Format a `TraceContext` to a W3C traceparent string.

```ts
function formatTraceParent(context: TraceContext): string;
// Returns: "00-<traceId>-<spanId>-<flags>"
```

### `parseTraceParent(value)`

Parse a W3C traceparent header string. Returns `null` if the format is invalid or IDs are all zeros.

```ts
function parseTraceParent(value: string): TraceContext | null;
```

### `TraceContext`

```ts
interface TraceContext {
  version: string; // "00"
  traceId: string; // 32 hex chars
  spanId: string; // 16 hex chars
  traceFlags: number; // bitmask (1 = sampled)
}
```

**Example:**

```ts
import { generateTraceId, generateSpanId, formatTraceParent, parseTraceParent } from 'weft';

const traceId = generateTraceId();
const spanId = generateSpanId();

const header = formatTraceParent({
  version: '00',
  traceId,
  spanId,
  traceFlags: 1,
});
// "00-a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6-1a2b3c4d5e6f7a8b-01"

const parsed = parseTraceParent(header);
// { version: '00', traceId: '...', spanId: '...', traceFlags: 1 }
```
