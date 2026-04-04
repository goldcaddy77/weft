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

import {
  AgentToolCalledEvent,
  AgentToolReturnedEvent,
  AgentTurnCompletedEvent,
  AgentTurnStartedEvent,
} from '../ai/events';
import {
  WorkflowCancelledEvent,
  WorkflowCompletedEvent,
  WorkflowFailedEvent,
  WorkflowTimedOutEvent,
} from '../core/events.ts';
import type {
  ActivityExecutionInterception,
  ActivityInterception,
  ActivityInterceptor,
  AgentInterception,
  ChildWorkflowInterception,
  SignalInterception,
  SignalReceivedInterception,
  SleepInterception,
  WorkflowInterceptor,
  WorkflowStartInterception,
} from '../core/interceptor';
import { MetricsCollector as MetricsCollectorClass } from './metrics';
import type { OtelApi, OtelSpan, SpanLink } from './no-op-telemetry';
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
  | ChildWorkflowInterception
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
  /** End the workflow root span. Call from the engine when a workflow reaches terminal state. */
  endWorkflowSpan: (workflowId: string, status: 'ok' | 'error', errorMessage?: string) => void;
} {
  const api = options?.otelApi ?? getOtelApi();
  const { trace, SpanStatusCode } = api;

  const tracer = trace.getTracer(options?.tracerName ?? 'weft', options?.tracerVersion);
  const recordPayloads = options?.recordPayloads ?? false;
  const maxPayloadSize = options?.maxPayloadSize ?? DEFAULT_MAX_PAYLOAD_SIZE;
  const attributeExtractor = options?.attributeExtractor;
  const eventTarget = options?.eventTarget;

  const metrics = options?.metrics ?? new MetricsCollectorClass();

  // Root spans keyed by workflow ID. Supports concurrent workflows sharing
  // a single interceptor instance without span mis-parenting.
  const workflowSpans = new Map<string, OtelSpan>();

  /** End and remove the span for a given workflow ID. */
  function endAndRemoveWorkflowSpan(workflowId: string): void {
    const span = workflowSpans.get(workflowId);
    if (span) {
      span.end();
      workflowSpans.delete(workflowId);
    }
  }

  // Automatically clean up workflow spans when workflows reach terminal states.
  if (eventTarget) {
    const terminalHandler = (event: Event) => {
      if (
        !(event instanceof WorkflowCompletedEvent) &&
        !(event instanceof WorkflowFailedEvent) &&
        !(event instanceof WorkflowCancelledEvent) &&
        !(event instanceof WorkflowTimedOutEvent)
      ) {
        return;
      }

      const isError =
        event instanceof WorkflowFailedEvent || event instanceof WorkflowTimedOutEvent;
      const errorMsg = event instanceof WorkflowFailedEvent ? event.error.message : undefined;

      endWorkflowSpan(event.workflowId, isError ? 'error' : 'ok', errorMsg);
    };

    for (const type of [
      WorkflowCompletedEvent.type,
      WorkflowFailedEvent.type,
      WorkflowCancelledEvent.type,
      WorkflowTimedOutEvent.type,
    ]) {
      eventTarget.addEventListener(type, terminalHandler);
    }
  }

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
      // End any existing span for the same workflow ID (e.g., re-execution)
      const existingSpan = workflowSpans.get(interception.workflowId);
      if (existingSpan) {
        existingSpan.setStatus({ code: SpanStatusCode.OK });
        endAndRemoveWorkflowSpan(interception.workflowId);
      }

      const span = tracer.startSpan(`workflow:${interception.workflowType}`, {
        attributes: {
          'weft.workflow.id': interception.workflowId,
          'weft.workflow.type': interception.workflowType,
        },
      });

      workflowSpans.set(interception.workflowId, span);

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
      const rootSpan = workflowSpans.get(interception.workflowId);
      const parentCtx = rootSpan
        ? trace.setSpan(api.context.ROOT_CONTEXT, rootSpan)
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
      const rootSpan = workflowSpans.get(interception.workflowId);
      const parentCtx = rootSpan
        ? trace.setSpan(api.context.ROOT_CONTEXT, rootSpan)
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

      try {
        yield* next(interception);
        span.setStatus({ code: SpanStatusCode.OK });
      } catch (error) {
        span.setStatus({ code: SpanStatusCode.ERROR, message: errorMessage(error) });
        span.recordException(toError(error));
        throw error;
      } finally {
        span.end();
      }
    },

    *waitForSignal(
      interception: SignalInterception,
      next: (interception: SignalInterception) => Generator<unknown, unknown, unknown>,
    ): Generator<unknown, unknown, unknown> {
      const rootSpan = workflowSpans.get(interception.workflowId);
      const parentCtx = rootSpan
        ? trace.setSpan(api.context.ROOT_CONTEXT, rootSpan)
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
      const rootSpan = workflowSpans.get(interception.workflowId);
      const parentCtx = rootSpan
        ? trace.setSpan(api.context.ROOT_CONTEXT, rootSpan)
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

      const agentWorkflowId = interception.workflowId;
      const onTurnStarted = (event: Event) => {
        if (!(event instanceof AgentTurnStartedEvent)) return;
        if (event.workflowId !== agentWorkflowId) return;
        const turnSpan = tracer.startSpan(
          `agent:turn:${event.turnIndex}`,
          {
            attributes: {
              'weft.agent.turn_index': event.turnIndex,
              'weft.agent.model': event.model,
            },
          },
          agentCtx,
        );
        turnSpans.set(event.turnIndex, turnSpan);
      };

      const onTurnCompleted = (event: Event) => {
        if (!(event instanceof AgentTurnCompletedEvent)) return;
        if (event.workflowId !== agentWorkflowId) return;
        const turnSpan = turnSpans.get(event.turnIndex);
        if (turnSpan) {
          turnSpan.setAttribute('weft.agent.input_tokens', event.inputTokens);
          turnSpan.setAttribute('weft.agent.output_tokens', event.outputTokens);
          turnSpan.setAttribute('weft.agent.cost', event.cost);
          turnSpan.setStatus({ code: SpanStatusCode.OK });
          turnSpan.end();
          turnSpans.delete(event.turnIndex);
        }
      };

      const onToolCalled = (event: Event) => {
        if (!(event instanceof AgentToolCalledEvent)) return;
        if (event.workflowId !== agentWorkflowId) return;
        const parentTurnSpan = turnSpans.get(event.turnIndex);
        const toolParentCtx = parentTurnSpan
          ? trace.setSpan(api.context.ROOT_CONTEXT, parentTurnSpan)
          : agentCtx;
        const toolSpan = tracer.startSpan(
          `agent:tool:${event.toolName}`,
          {
            attributes: {
              'weft.agent.tool_name': event.toolName,
            },
          },
          toolParentCtx,
        );
        toolSpans.set(event.operationId, toolSpan);
      };

      const onToolReturned = (event: Event) => {
        if (!(event instanceof AgentToolReturnedEvent)) return;
        if (event.workflowId !== agentWorkflowId) return;
        const toolSpan = toolSpans.get(event.operationId);
        if (toolSpan) {
          toolSpan.setAttribute('weft.agent.tool_duration', event.duration);
          toolSpan.setAttribute('weft.agent.tool_success', event.success);
          toolSpan.setStatus({
            code: event.success ? SpanStatusCode.OK : SpanStatusCode.ERROR,
          });
          toolSpan.end();
          toolSpans.delete(event.operationId);
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

    async childWorkflow(
      interception: ChildWorkflowInterception,
      next: (interception: ChildWorkflowInterception) => Promise<unknown>,
    ): Promise<unknown> {
      // Build span links from the parent workflow's traceparent header.
      // Child workflows have independent lifecycles, so we use links instead
      // of parent-child span relationships.
      const links: SpanLink[] = [];
      const parentTrace = extractTraceParent(interception.parentHeaders);
      if (parentTrace) {
        links.push({
          context: {
            traceId: parentTrace.traceId,
            spanId: parentTrace.spanId,
            traceFlags: parentTrace.traceFlags,
          },
        });
      }

      const span = tracer.startSpan(
        `childWorkflow:${interception.workflowType}`,
        {
          attributes: {
            'weft.child_workflow.type': interception.workflowType,
            'weft.child_workflow.id': interception.childWorkflowId,
            'weft.child_workflow.parent_id': interception.workflowId,
          },
          links,
        },
        api.context.ROOT_CONTEXT,
      );

      injectSpanContext(span, interception.headers);

      if (recordPayloads && interception.input !== undefined) {
        span.setAttribute(
          'weft.payload.input',
          serializePayload(interception.input, maxPayloadSize),
        );
      }

      metrics.increment('weft.child_workflow.started');

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

      // Build a parent context from the extracted traceparent so the activity
      // span becomes a child of the workflow span that dispatched it.
      let parentCtx = api.context.ROOT_CONTEXT;
      if (parentContext) {
        const remoteParentSpan: OtelSpan = {
          setAttribute() {},
          setStatus() {},
          recordException() {},
          end() {},
          spanContext() {
            return {
              traceId: parentContext.traceId,
              spanId: parentContext.spanId,
              traceFlags: parentContext.traceFlags,
            };
          },
        };
        parentCtx = trace.setSpan(api.context.ROOT_CONTEXT, remoteParentSpan);
      }

      const span = tracer.startSpan(
        `activity:execute:${interception.activityName}`,
        {
          attributes: {
            'weft.activity.name': interception.activityName,
            'weft.activity.attempt': interception.attempt,
            ...(parentContext ? { 'weft.parent.trace_id': parentContext.traceId } : {}),
          },
        },
        parentCtx,
      );

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

  function endWorkflowSpan(workflowId: string, status: 'ok' | 'error', message?: string): void {
    const span = workflowSpans.get(workflowId);
    if (!span) return;
    if (status === 'error') {
      span.setStatus({
        code: SpanStatusCode.ERROR,
        ...(message ? { message } : {}),
      });
    } else {
      span.setStatus({ code: SpanStatusCode.OK });
    }
    span.end();
    workflowSpans.delete(workflowId);
  }

  return { workflow, activity, metrics, endWorkflowSpan };
}
