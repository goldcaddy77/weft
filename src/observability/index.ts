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
} from '../core/events';
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
import { getOtelApi, NO_OP_SPAN_METHODS } from './no-op-telemetry';
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
   * Event target that the engine dispatches lifecycle events on.
   *
   * When provided, the factory subscribes to the engine's workflow lifecycle
   * events (`workflow:completed`, `workflow:failed`, `workflow:cancelled`,
   * `workflow:timed-out`) and automatically ends the root workflow span with
   * the appropriate status. This prevents the internal `workflowSpans` map
   * from growing unbounded and ensures exported traces reflect terminal state.
   *
   * The same target is also used by the agent interceptor to create child
   * spans for each turn (`agent:turn:N`) and tool call (`agent:tool:name`).
   *
   * In practice, pass your `Engine` instance here—it dispatches both agent
   * and workflow lifecycle events on itself.
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
  /**
   * End the workflow root span. Usually wired automatically via `eventTarget`,
   * but exposed for callers that need to end spans manually.
   */
  endWorkflowSpan: (workflowId: string, status: 'ok' | 'error', errorMessage?: string) => void;
  /**
   * Evict workflow spans that have been open longer than `maxAgeMs` (default: 1 hour).
   * Call periodically to prevent unbounded growth from orphaned or long-running workflows.
   */
  evictStaleSpans: (maxAgeMs?: number) => number;
  /**
   * Unsubscribe any workflow lifecycle listeners registered on the `eventTarget`
   * and end any still-open workflow spans. Call this when tearing down the
   * engine so the interceptor doesn't leak listeners or spans.
   */
  dispose: () => void;
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
  // a single interceptor instance without span mis-parenting. Each entry
  // stores a creation timestamp so stale spans from orphaned workflows can
  // be evicted before the map grows unbounded.
  const WORKFLOW_SPAN_TTL_MS = 60 * 60 * 1000; // 1 hour
  const WORKFLOW_SPAN_MAX_SIZE = 10_000;

  type WorkflowSpanEntry = { span: OtelSpan; createdAt: number };
  const workflowSpans = new Map<string, WorkflowSpanEntry>();

  /**
   * Evict workflow span entries that exceed the TTL or, if the map still
   * exceeds the size cap after TTL eviction, drop the oldest entries until
   * the cap is satisfied.
   */
  function evictStaleWorkflowSpans(): void {
    const now = Date.now();

    // Phase 1: TTL-based eviction
    for (const [id, entry] of workflowSpans) {
      if (now - entry.createdAt > WORKFLOW_SPAN_TTL_MS) {
        entry.span.end();
        workflowSpans.delete(id);
      }
    }

    // Phase 2: cap-based eviction (oldest-first — Map iterates in insertion order)
    if (workflowSpans.size > WORKFLOW_SPAN_MAX_SIZE) {
      const excess = workflowSpans.size - WORKFLOW_SPAN_MAX_SIZE;
      let removed = 0;
      for (const [id, entry] of workflowSpans) {
        if (removed >= excess) break;
        entry.span.end();
        workflowSpans.delete(id);
        removed++;
      }
    }
  }

  /** End and remove the span for a given workflow ID. */
  function endAndRemoveWorkflowSpan(workflowId: string): void {
    const entry = workflowSpans.get(workflowId);
    if (entry) {
      entry.span.end();
      workflowSpans.delete(workflowId);
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
      // Evict stale spans before adding a new one to bound memory usage.
      evictStaleWorkflowSpans();

      // End any existing span for the same workflow ID (e.g., re-execution)
      const existingEntry = workflowSpans.get(interception.workflowId);
      if (existingEntry) {
        existingEntry.span.setStatus({ code: SpanStatusCode.OK });
        endAndRemoveWorkflowSpan(interception.workflowId);
      }

      const span = tracer.startSpan(`workflow:${interception.workflowType}`, {
        attributes: {
          'weft.workflow.id': interception.workflowId,
          'weft.workflow.type': interception.workflowType,
        },
      });

      workflowSpans.set(interception.workflowId, { span, createdAt: Date.now() });

      injectSpanContext(span, interception.headers);

      if (recordPayloads && interception.input !== undefined) {
        span.setAttribute(
          'weft.payload.input',
          serializePayload(interception.input, maxPayloadSize),
        );
      }

      applyCustomAttributes(span, interception);

      metrics.increment('weft.workflow.started');
      metrics.increment('weft.dpmo.operations');

      next(interception);
    },

    *activity(
      interception: ActivityInterception,
      next: (interception: ActivityInterception) => Generator<unknown, unknown, unknown>,
    ): Generator<unknown, unknown, unknown> {
      const rootEntry = workflowSpans.get(interception.workflowId);
      const parentCtx = rootEntry
        ? trace.setSpan(api.context.ROOT_CONTEXT, rootEntry.span)
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
      const rootEntry = workflowSpans.get(interception.workflowId);
      const parentCtx = rootEntry
        ? trace.setSpan(api.context.ROOT_CONTEXT, rootEntry.span)
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
      const rootEntry = workflowSpans.get(interception.workflowId);
      const parentCtx = rootEntry
        ? trace.setSpan(api.context.ROOT_CONTEXT, rootEntry.span)
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
      const rootEntry = workflowSpans.get(interception.workflowId);
      const parentCtx = rootEntry
        ? trace.setSpan(api.context.ROOT_CONTEXT, rootEntry.span)
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
      class AgentEventSpanListener implements EventListenerObject {
        readonly #workflowId: string;
        readonly #turnSpans = new Map<number, OtelSpan>();
        readonly #toolSpans = new Map<string, OtelSpan>();

        constructor(workflowId: string) {
          this.#workflowId = workflowId;
        }

        handleEvent(event: Event): void {
          if (event instanceof AgentTurnStartedEvent) {
            if (event.workflowId !== this.#workflowId) return;
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
            this.#turnSpans.set(event.turnIndex, turnSpan);
            return;
          }

          if (event instanceof AgentTurnCompletedEvent) {
            if (event.workflowId !== this.#workflowId) return;
            const turnSpan = this.#turnSpans.get(event.turnIndex);
            if (!turnSpan) return;

            turnSpan.setAttribute('weft.agent.input_tokens', event.inputTokens);
            turnSpan.setAttribute('weft.agent.output_tokens', event.outputTokens);
            turnSpan.setAttribute('weft.agent.cost', event.cost);
            turnSpan.setStatus({ code: SpanStatusCode.OK });
            turnSpan.end();
            this.#turnSpans.delete(event.turnIndex);
            return;
          }

          if (event instanceof AgentToolCalledEvent) {
            if (event.workflowId !== this.#workflowId) return;
            const parentTurnSpan = this.#turnSpans.get(event.turnIndex);
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
            this.#toolSpans.set(event.operationId, toolSpan);
            return;
          }

          if (!(event instanceof AgentToolReturnedEvent)) return;
          if (event.workflowId !== this.#workflowId) return;

          const toolSpan = this.#toolSpans.get(event.operationId);
          if (!toolSpan) return;

          toolSpan.setAttribute('weft.agent.tool_duration', event.duration);
          toolSpan.setAttribute('weft.agent.tool_success', event.success);
          toolSpan.setStatus({
            code: event.success ? SpanStatusCode.OK : SpanStatusCode.ERROR,
          });
          toolSpan.end();
          this.#toolSpans.delete(event.operationId);
        }

        endOrphanedSpans(): void {
          for (const orphanedTool of this.#toolSpans.values()) {
            orphanedTool.setStatus({ code: SpanStatusCode.ERROR });
            orphanedTool.end();
          }
          for (const orphanedTurn of this.#turnSpans.values()) {
            orphanedTurn.setStatus({ code: SpanStatusCode.ERROR });
            orphanedTurn.end();
          }
        }
      }

      const agentEventSpanListener = new AgentEventSpanListener(interception.workflowId);

      if (eventTarget) {
        eventTarget.addEventListener('agent:turn:started', agentEventSpanListener);
        eventTarget.addEventListener('agent:turn:completed', agentEventSpanListener);
        eventTarget.addEventListener('agent:tool:called', agentEventSpanListener);
        eventTarget.addEventListener('agent:tool:returned', agentEventSpanListener);
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
          eventTarget.removeEventListener('agent:turn:started', agentEventSpanListener);
          eventTarget.removeEventListener('agent:turn:completed', agentEventSpanListener);
          eventTarget.removeEventListener('agent:tool:called', agentEventSpanListener);
          eventTarget.removeEventListener('agent:tool:returned', agentEventSpanListener);
        }

        // End any orphaned child spans that were never completed
        agentEventSpanListener.endOrphanedSpans();
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
          ...NO_OP_SPAN_METHODS,
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
    const entry = workflowSpans.get(workflowId);
    if (!entry) return;
    if (status === 'error') {
      entry.span.setStatus({
        code: SpanStatusCode.ERROR,
        ...(message ? { message } : {}),
      });
    } else {
      entry.span.setStatus({ code: SpanStatusCode.OK });
    }
    entry.span.end();
    workflowSpans.delete(workflowId);
  }

  // -----------------------------------------------------------------------
  // Workflow lifecycle subscription
  // -----------------------------------------------------------------------
  //
  // When an event target is provided (typically the engine), subscribe to
  // workflow terminal events so root spans are automatically ended with the
  // correct status. Without this, `workflowSpans` would grow unbounded and
  // exported traces would show workflow spans as "in progress" forever.

  const onWorkflowCompleted = (event: Event): void => {
    if (!(event instanceof WorkflowCompletedEvent)) return;
    endWorkflowSpan(event.workflowId, 'ok');
  };

  const onWorkflowFailed = (event: Event): void => {
    if (!(event instanceof WorkflowFailedEvent)) return;
    endWorkflowSpan(event.workflowId, 'error', event.error.message);
    metrics.increment('weft.dpmo.defects');
  };

  const onWorkflowCancelled = (event: Event): void => {
    if (!(event instanceof WorkflowCancelledEvent)) return;
    endWorkflowSpan(event.workflowId, 'error', 'Workflow cancelled');
  };

  const onWorkflowTimedOut = (event: Event): void => {
    if (!(event instanceof WorkflowTimedOutEvent)) return;
    endWorkflowSpan(
      event.workflowId,
      'error',
      `Workflow timed out (${event.timeoutType}) after ${event.elapsed}ms`,
    );
    metrics.increment('weft.dpmo.defects');
  };

  if (eventTarget) {
    eventTarget.addEventListener(WorkflowCompletedEvent.type, onWorkflowCompleted);
    eventTarget.addEventListener(WorkflowFailedEvent.type, onWorkflowFailed);
    eventTarget.addEventListener(WorkflowCancelledEvent.type, onWorkflowCancelled);
    eventTarget.addEventListener(WorkflowTimedOutEvent.type, onWorkflowTimedOut);
  }

  const DEFAULT_STALE_SPAN_MAX_AGE_MS = 60 * 60 * 1000; // 1 hour

  /**
   * Evict workflow spans older than `maxAgeMs`. Returns the number of
   * evicted entries. Orphaned or long-running workflows that never reach
   * a terminal state will accumulate spans indefinitely without this —
   * the terminal-event subscription only covers workflows that actually
   * complete.
   */
  function evictStaleSpans(maxAgeMs: number = DEFAULT_STALE_SPAN_MAX_AGE_MS): number {
    const cutoff = Date.now() - maxAgeMs;
    let evicted = 0;
    for (const [workflowId, entry] of workflowSpans) {
      if (entry.createdAt <= cutoff) {
        entry.span.setStatus({ code: SpanStatusCode.ERROR, message: 'span evicted (stale)' });
        entry.span.end();
        workflowSpans.delete(workflowId);
        evicted++;
      }
    }
    return evicted;
  }

  function dispose(): void {
    if (eventTarget) {
      eventTarget.removeEventListener(WorkflowCompletedEvent.type, onWorkflowCompleted);
      eventTarget.removeEventListener(WorkflowFailedEvent.type, onWorkflowFailed);
      eventTarget.removeEventListener(WorkflowCancelledEvent.type, onWorkflowCancelled);
      eventTarget.removeEventListener(WorkflowTimedOutEvent.type, onWorkflowTimedOut);
    }

    // End any still-open workflow spans so the map cannot leak past dispose.
    for (const entry of workflowSpans.values()) {
      entry.span.setStatus({ code: SpanStatusCode.ERROR, message: 'Observability disposed' });
      entry.span.end();
    }
    workflowSpans.clear();
  }

  return { workflow, activity, metrics, endWorkflowSpan, evictStaleSpans, dispose };
}
