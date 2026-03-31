/**
 * Observability interceptors for Weft workflows and activities.
 *
 * Creates {@link WorkflowInterceptor} and {@link ActivityInterceptor}
 * implementations that propagate W3C trace context, emit OpenTelemetry spans,
 * and record metrics. When `@opentelemetry/api` is not installed, all span
 * operations are no-ops with zero overhead.
 *
 * @module observability
 */

import type {
  AgentToolCalledEvent,
  AgentToolReturnedEvent,
  AgentTurnCompletedEvent,
  AgentTurnStartedEvent,
} from '../ai/events';
import type {
  ActivityExecutionInterception,
  ActivityInterception,
  ActivityInterceptor,
  AgentInterception,
  SignalInterception,
  SignalReceivedInterception,
  SleepInterception,
  WorkflowInterceptor,
  WorkflowStartInterception,
} from '../core/interceptor';
import { MetricsCollector as MetricsCollectorClass } from './metrics';
import type { OtelApi, OtelSpan } from './no-op-telemetry';
import { getOtelApi } from './no-op-telemetry';
import { extractTraceParent, injectTraceParent } from './propagation';

export { METRICS, MetricsCollector } from './metrics';
export type {
  CounterMetric,
  GaugeMetric,
  HistogramMetric,
  MetricDefinition,
  MetricsSnapshot,
  MetricType,
} from './metrics';
export {
  extractTraceParent,
  formatTraceParent,
  generateSpanId,
  generateTraceId,
  injectTraceParent,
  parseTraceParent,
} from './propagation';
export type { TraceContext } from './propagation';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Union of all interception context types the attributeExtractor receives. */
export type InterceptionContext =
  | WorkflowStartInterception
  | ActivityInterception
  | SleepInterception
  | SignalInterception
  | AgentInterception
  | SignalReceivedInterception;

export type ObservabilityOptions = {
  /** Name passed to `trace.getTracer()`. Default: `'weft'`. */
  tracerName?: string;
  /** Version passed to `trace.getTracer()`. */
  tracerVersion?: string;
  /** Whether to record activity/workflow inputs as span attributes. Default: false. */
  recordPayloads?: boolean;
  /** Maximum serialized payload size in bytes before truncation. Default: 1024. */
  maxPayloadSize?: number;
  /**
   * Extract custom span attributes from each interception context.
   * Receives the actual interception object—not a synthetic wrapper.
   */
  attributeExtractor?: (
    interception: InterceptionContext,
  ) => Record<string, string | number | boolean>;
  /** Metrics collector for recording counters, histograms, and gauges. */
  metrics?: MetricsCollectorClass;
  /**
   * Override the OTel API instance used by the interceptors.
   * Primarily for testing—production code should omit this so `getOtelApi()`
   * auto-detects whether `@opentelemetry/api` is installed.
   */
  otelApi?: OtelApi;
  /**
   * Event target that the agent loop dispatches lifecycle events on.
   * When provided, the agent interceptor creates child spans for each
   * turn (`agent:turn:N`) and tool call (`agent:tool:name`).
   */
  eventTarget?: EventTarget;
};

/**
 * @deprecated Use a real OpenTelemetry `SpanProcessor` instead of these callbacks.
 * The `onSpanStart`/`onSpanEnd` callbacks have been removed in favor of direct
 * OTel API usage. Register a `SpanProcessor` with the OTel SDK to observe spans.
 */
export type SpanInfo = {
  name: string;
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  attributes: Record<string, string | number | boolean>;
  startTime: number;
  endTime?: number;
  status?: 'ok' | 'error';
  error?: string;
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const DEFAULT_MAX_PAYLOAD_SIZE = 1024;

function serializePayload(input: unknown, maxSize: number): string {
  let serialized: string;
  try {
    serialized = JSON.stringify(input);
  } catch {
    serialized = String(input);
  }

  if (serialized.length > maxSize) {
    return serialized.slice(0, maxSize) + '...';
  }

  return serialized;
}

/** Extract error message from an unknown thrown value. */
function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Convert an unknown thrown value to an Error for `recordException`. */
function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

/** Inject the traceparent header from a span's context into a headers map. */
function injectSpanContext(span: OtelSpan, headers: Map<string, string>): void {
  const ctx = span.spanContext();
  injectTraceParent(headers, {
    version: '00',
    traceId: ctx.traceId,
    spanId: ctx.spanId,
    traceFlags: ctx.traceFlags,
  });
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create workflow and activity interceptors for observability.
 *
 * Uses `@opentelemetry/api` directly for span creation. When the package is
 * not installed, falls back to no-op implementations with zero overhead.
 */
export function createObservabilityInterceptors(options?: ObservabilityOptions): {
  workflow: WorkflowInterceptor;
  activity: ActivityInterceptor;
  metrics: MetricsCollectorClass;
} {
  const api = options?.otelApi ?? getOtelApi();
  const { trace, SpanStatusCode } = api;

  const tracer = trace.getTracer(options?.tracerName ?? 'weft', options?.tracerVersion);
  const recordPayloads = options?.recordPayloads ?? false;
  const maxPayloadSize = options?.maxPayloadSize ?? DEFAULT_MAX_PAYLOAD_SIZE;
  const attributeExtractor = options?.attributeExtractor;
  const eventTarget = options?.eventTarget;

  const metrics = options?.metrics ?? new MetricsCollectorClass();

  // Mutable state: the root span for the current workflow execution.
  // Reset on each `workflowStart`. Used to parent child spans.
  let currentRootSpan: OtelSpan | undefined;

  /** Apply custom attributes from the extractor to a span. */
  function applyCustomAttributes(span: OtelSpan, interception: InterceptionContext): void {
    if (!attributeExtractor) return;
    const custom = attributeExtractor(interception);
    for (const [key, value] of Object.entries(custom)) {
      span.setAttribute(key, value);
    }
  }

  // -----------------------------------------------------------------------
  // Workflow interceptor
  // -----------------------------------------------------------------------

  const workflow: WorkflowInterceptor = {
    workflowStart(
      interception: WorkflowStartInterception,
      next: (interception: WorkflowStartInterception) => void,
    ): void {
      const span = tracer.startSpan(`workflow:${interception.workflowType}`, {
        attributes: {
          'weft.workflow.id': interception.workflowId,
          'weft.workflow.type': interception.workflowType,
        },
      });

      currentRootSpan = span;

      injectSpanContext(span, interception.headers);

      if (recordPayloads && interception.input !== undefined) {
        span.setAttribute(
          'weft.payload.input',
          serializePayload(interception.input, maxPayloadSize),
        );
      }

      applyCustomAttributes(span, interception);

      metrics.increment('weft.workflow.started');

      next(interception);
    },

    *activity(
      interception: ActivityInterception,
      next: (interception: ActivityInterception) => Generator<unknown, unknown, unknown>,
    ): Generator<unknown, unknown, unknown> {
      const parentCtx = currentRootSpan
        ? trace.setSpan(api.context.ROOT_CONTEXT, currentRootSpan)
        : api.context.ROOT_CONTEXT;

      const span = tracer.startSpan(
        `activity:${interception.activityName}`,
        {
          attributes: {
            'weft.activity.name': interception.activityName,
            'weft.activity.attempt': interception.attempt,
          },
        },
        parentCtx,
      );

      injectSpanContext(span, interception.headers);

      if (recordPayloads && interception.input !== undefined) {
        span.setAttribute(
          'weft.payload.input',
          serializePayload(interception.input, maxPayloadSize),
        );
      }

      applyCustomAttributes(span, interception);

      const startTime = Date.now();

      try {
        const result = yield* next(interception);
        span.setStatus({ code: SpanStatusCode.OK });
        metrics.record('weft.activity.duration', Date.now() - startTime);
        metrics.increment('weft.activity.attempts');
        span.end();
        return result;
      } catch (error) {
        span.setStatus({ code: SpanStatusCode.ERROR, message: errorMessage(error) });
        span.recordException(toError(error));
        span.end();
        throw error;
      }
    },

    *sleep(
      interception: SleepInterception,
      next: (interception: SleepInterception) => Generator<unknown, void, unknown>,
    ): Generator<unknown, void, unknown> {
      const parentCtx = currentRootSpan
        ? trace.setSpan(api.context.ROOT_CONTEXT, currentRootSpan)
        : api.context.ROOT_CONTEXT;

      const span = tracer.startSpan(
        'sleep',
        {
          attributes: {
            'weft.sleep.duration': interception.duration,
          },
        },
        parentCtx,
      );

      applyCustomAttributes(span, interception);

      yield* next(interception);

      span.setStatus({ code: SpanStatusCode.OK });
      span.end();
    },

    *waitForSignal(
      interception: SignalInterception,
      next: (interception: SignalInterception) => Generator<unknown, unknown, unknown>,
    ): Generator<unknown, unknown, unknown> {
      const parentCtx = currentRootSpan
        ? trace.setSpan(api.context.ROOT_CONTEXT, currentRootSpan)
        : api.context.ROOT_CONTEXT;

      const span = tracer.startSpan(
        'waitForSignal',
        {
          attributes: {
            'weft.signal.name': interception.signalName,
          },
        },
        parentCtx,
      );

      applyCustomAttributes(span, interception);

      try {
        const result = yield* next(interception);
        span.setStatus({ code: SpanStatusCode.OK });
        span.end();
        return result;
      } catch (error) {
        span.setStatus({ code: SpanStatusCode.ERROR, message: errorMessage(error) });
        span.recordException(toError(error));
        span.end();
        throw error;
      }
    },

    *agent(
      interception: AgentInterception,
      next: (interception: AgentInterception) => Generator<unknown, unknown, unknown>,
    ): Generator<unknown, unknown, unknown> {
      const parentCtx = currentRootSpan
        ? trace.setSpan(api.context.ROOT_CONTEXT, currentRootSpan)
        : api.context.ROOT_CONTEXT;

      const span = tracer.startSpan(
        'agent',
        {
          attributes: {
            'weft.agent.model': interception.model,
          },
        },
        parentCtx,
      );

      injectSpanContext(span, interception.headers);

      if (recordPayloads && interception.prompt) {
        span.setAttribute(
          'weft.agent.prompt',
          serializePayload(interception.prompt, maxPayloadSize),
        );
      }

      applyCustomAttributes(span, interception);

      // Track active child spans for turns and tool calls so we can clean up
      // orphans if the agent generator throws before events complete.
      const agentCtx = trace.setSpan(api.context.ROOT_CONTEXT, span);
      const turnSpans = new Map<number, OtelSpan>();
      const toolSpans = new Map<string, OtelSpan>();

      const onTurnStarted = (event: Event) => {
        const e = event as AgentTurnStartedEvent;
        const turnSpan = tracer.startSpan(
          `agent:turn:${e.turnIndex}`,
          {
            attributes: {
              'weft.agent.turn_index': e.turnIndex,
              'weft.agent.model': e.model,
            },
          },
          agentCtx,
        );
        turnSpans.set(e.turnIndex, turnSpan);
      };

      const onTurnCompleted = (event: Event) => {
        const e = event as AgentTurnCompletedEvent;
        const turnSpan = turnSpans.get(e.turnIndex);
        if (turnSpan) {
          turnSpan.setAttribute('weft.agent.input_tokens', e.inputTokens);
          turnSpan.setAttribute('weft.agent.output_tokens', e.outputTokens);
          turnSpan.setAttribute('weft.agent.cost', e.cost);
          turnSpan.setStatus({ code: SpanStatusCode.OK });
          turnSpan.end();
          turnSpans.delete(e.turnIndex);
        }
      };

      const onToolCalled = (event: Event) => {
        const e = event as AgentToolCalledEvent;
        const parentTurnSpan = turnSpans.get(e.turnIndex);
        const toolParentCtx = parentTurnSpan
          ? trace.setSpan(api.context.ROOT_CONTEXT, parentTurnSpan)
          : agentCtx;
        const toolSpan = tracer.startSpan(
          `agent:tool:${e.toolName}`,
          {
            attributes: {
              'weft.agent.tool_name': e.toolName,
            },
          },
          toolParentCtx,
        );
        toolSpans.set(e.operationId, toolSpan);
      };

      const onToolReturned = (event: Event) => {
        const e = event as AgentToolReturnedEvent;
        const toolSpan = toolSpans.get(e.operationId);
        if (toolSpan) {
          toolSpan.setAttribute('weft.agent.tool_duration', e.duration);
          toolSpan.setAttribute('weft.agent.tool_success', e.success);
          toolSpan.setStatus({
            code: e.success ? SpanStatusCode.OK : SpanStatusCode.ERROR,
          });
          toolSpan.end();
          toolSpans.delete(e.operationId);
        }
      };

      if (eventTarget) {
        eventTarget.addEventListener('agent:turn:started', onTurnStarted);
        eventTarget.addEventListener('agent:turn:completed', onTurnCompleted);
        eventTarget.addEventListener('agent:tool:called', onToolCalled);
        eventTarget.addEventListener('agent:tool:returned', onToolReturned);
      }

      try {
        const result = yield* next(interception);
        span.setStatus({ code: SpanStatusCode.OK });
        span.end();
        return result;
      } catch (error) {
        span.setStatus({ code: SpanStatusCode.ERROR, message: errorMessage(error) });
        span.recordException(toError(error));
        span.end();
        throw error;
      } finally {
        if (eventTarget) {
          eventTarget.removeEventListener('agent:turn:started', onTurnStarted);
          eventTarget.removeEventListener('agent:turn:completed', onTurnCompleted);
          eventTarget.removeEventListener('agent:tool:called', onToolCalled);
          eventTarget.removeEventListener('agent:tool:returned', onToolReturned);
        }

        // End any orphaned child spans that were never completed
        for (const orphanedTool of toolSpans.values()) {
          orphanedTool.setStatus({ code: SpanStatusCode.ERROR });
          orphanedTool.end();
        }
        for (const orphanedTurn of turnSpans.values()) {
          orphanedTurn.setStatus({ code: SpanStatusCode.ERROR });
          orphanedTurn.end();
        }
      }
    },

    signalReceived(
      interception: SignalReceivedInterception,
      next: (interception: SignalReceivedInterception) => void,
    ): void {
      const span = tracer.startSpan(`signal:received:${interception.signalName}`, {
        attributes: {
          'weft.signal.name': interception.signalName,
          'weft.signal.workflow_id': interception.workflowId,
        },
      });

      applyCustomAttributes(span, interception);

      try {
        next(interception);
        span.setStatus({ code: SpanStatusCode.OK });
        span.end();
      } catch (error) {
        span.setStatus({ code: SpanStatusCode.ERROR, message: errorMessage(error) });
        span.recordException(toError(error));
        span.end();
        throw error;
      }
    },
  };

  // -----------------------------------------------------------------------
  // Activity interceptor
  // -----------------------------------------------------------------------

  const activity: ActivityInterceptor = {
    async execute(
      interception: ActivityExecutionInterception,
      next: (interception: ActivityExecutionInterception) => Promise<unknown>,
    ): Promise<unknown> {
      const parentContext = extractTraceParent(interception.headers);

      const span = tracer.startSpan(`activity:execute:${interception.activityName}`, {
        attributes: {
          'weft.activity.name': interception.activityName,
          'weft.activity.attempt': interception.attempt,
          ...(parentContext ? { 'weft.parent.trace_id': parentContext.traceId } : {}),
        },
      });

      if (recordPayloads && interception.input !== undefined) {
        span.setAttribute(
          'weft.payload.input',
          serializePayload(interception.input, maxPayloadSize),
        );
      }

      try {
        const result = await next(interception);
        span.setStatus({ code: SpanStatusCode.OK });
        span.end();
        return result;
      } catch (error) {
        span.setStatus({ code: SpanStatusCode.ERROR, message: errorMessage(error) });
        span.recordException(toError(error));
        span.end();
        throw error;
      }
    },
  };

  return { workflow, activity, metrics };
}
