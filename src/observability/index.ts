/**
 * Observability interceptors for Weft workflows and activities.
 *
 * Creates {@link WorkflowInterceptor} and {@link ActivityInterceptor}
 * implementations that propagate W3C trace context, emit span-like lifecycle
 * events, and optionally record payloads for debugging.
 *
 * @module observability
 */

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
import {
  extractTraceParent,
  generateSpanId,
  generateTraceId,
  injectTraceParent,
} from './propagation';

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

export interface ObservabilityOptions {
  /** Whether to record activity/workflow inputs as span attributes. Default: false. */
  recordPayloads?: boolean;
  /** Maximum serialized payload size in bytes before truncation. Default: 1024. */
  maxPayloadSize?: number;
  /** Called when a span starts. */
  onSpanStart?: (span: SpanInfo) => void;
  /** Called when a span ends. */
  onSpanEnd?: (span: SpanInfo) => void;
  /**
   * Extract custom span attributes from each interception context.
   * The returned record is merged into the span's attributes before `onSpanStart` fires.
   */
  attributeExtractor?: (interception: {
    workflowId: string;
    workflowType: string;
    [key: string]: unknown;
  }) => Record<string, string | number | boolean>;
  /** Metrics collector for recording counters, histograms, and gauges. */
  metrics?: MetricsCollectorClass;
}

export interface SpanInfo {
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

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/** Create workflow and activity interceptors for observability. */
export function createObservabilityInterceptors(options?: ObservabilityOptions): {
  workflow: WorkflowInterceptor;
  activity: ActivityInterceptor;
  metrics: MetricsCollectorClass;
} {
  const recordPayloads = options?.recordPayloads ?? false;
  const maxPayloadSize = options?.maxPayloadSize ?? DEFAULT_MAX_PAYLOAD_SIZE;
  const onSpanStart = options?.onSpanStart;
  const onSpanEnd = options?.onSpanEnd;
  const attributeExtractor = options?.attributeExtractor;

  const metrics = options?.metrics ?? new MetricsCollectorClass();

  // Mutable state shared across the workflow interceptor hooks for the
  // current workflow execution. Reset on each `workflowStart`.
  let currentTraceId = '';
  let rootSpanId = '';
  let currentWorkflowId = '';
  let currentWorkflowType = '';

  /** Extract custom attributes from the extractor callback and merge into a target object. */
  function applyCustomAttributes(
    target: Record<string, string | number | boolean>,
    extra?: Record<string, unknown>,
  ): void {
    if (!attributeExtractor) return;
    const custom = attributeExtractor({
      workflowId: currentWorkflowId,
      workflowType: currentWorkflowType,
      ...extra,
    });
    Object.assign(target, custom);
  }

  // -----------------------------------------------------------------------
  // Workflow interceptor
  // -----------------------------------------------------------------------

  const workflow: WorkflowInterceptor = {
    workflowStart(
      interception: WorkflowStartInterception,
      next: (interception: WorkflowStartInterception) => void,
    ): void {
      currentTraceId = generateTraceId();
      rootSpanId = generateSpanId();
      currentWorkflowId = interception.workflowId;
      currentWorkflowType = interception.workflowType;

      injectTraceParent(interception.headers, {
        version: '00',
        traceId: currentTraceId,
        spanId: rootSpanId,
        traceFlags: 1,
      });

      const span: SpanInfo = {
        name: `workflow:${interception.workflowType}`,
        traceId: currentTraceId,
        spanId: rootSpanId,
        attributes: {
          'workflow.id': interception.workflowId,
          'workflow.type': interception.workflowType,
        },
        startTime: Date.now(),
      };

      if (recordPayloads && interception.input !== undefined) {
        span.attributes['input'] = serializePayload(interception.input, maxPayloadSize);
      }

      applyCustomAttributes(span.attributes, { input: interception.input });

      metrics.increment('weft.workflow.started');
      onSpanStart?.(span);

      next(interception);
    },

    *activity(
      interception: ActivityInterception,
      next: (interception: ActivityInterception) => Generator<unknown, unknown, unknown>,
    ): Generator<unknown, unknown, unknown> {
      const childSpanId = generateSpanId();

      injectTraceParent(interception.headers, {
        version: '00',
        traceId: currentTraceId || generateTraceId(),
        spanId: childSpanId,
        traceFlags: 1,
      });

      const span: SpanInfo = {
        name: `activity:${interception.activityName}`,
        traceId: currentTraceId,
        spanId: childSpanId,
        parentSpanId: rootSpanId,
        attributes: {
          'activity.name': interception.activityName,
          'activity.attempt': interception.attempt,
        },
        startTime: Date.now(),
      };

      if (recordPayloads && interception.input !== undefined) {
        span.attributes['input'] = serializePayload(interception.input, maxPayloadSize);
      }

      applyCustomAttributes(span.attributes, {
        activityName: interception.activityName,
        attempt: interception.attempt,
      });

      onSpanStart?.(span);

      try {
        const result = yield* next(interception);
        span.endTime = Date.now();
        span.status = 'ok';
        const duration = span.endTime - span.startTime;
        metrics.record('weft.activity.duration', duration);
        metrics.increment('weft.activity.attempts');
        onSpanEnd?.(span);
        return result;
      } catch (error) {
        span.endTime = Date.now();
        span.status = 'error';
        span.error = error instanceof Error ? error.message : String(error);
        onSpanEnd?.(span);
        throw error;
      }
    },

    *sleep(
      interception: SleepInterception,
      next: (interception: SleepInterception) => Generator<unknown, void, unknown>,
    ): Generator<unknown, void, unknown> {
      const childSpanId = generateSpanId();

      const span: SpanInfo = {
        name: 'sleep',
        traceId: currentTraceId,
        spanId: childSpanId,
        parentSpanId: rootSpanId,
        attributes: {
          'sleep.duration': interception.duration,
        },
        startTime: Date.now(),
      };

      applyCustomAttributes(span.attributes, { duration: interception.duration });

      onSpanStart?.(span);

      yield* next(interception);

      span.endTime = Date.now();
      span.status = 'ok';
      onSpanEnd?.(span);
    },

    *waitForSignal(
      interception: SignalInterception,
      next: (interception: SignalInterception) => Generator<unknown, unknown, unknown>,
    ): Generator<unknown, unknown, unknown> {
      const childSpanId = generateSpanId();

      const span: SpanInfo = {
        name: 'waitForSignal',
        traceId: currentTraceId,
        spanId: childSpanId,
        parentSpanId: rootSpanId,
        attributes: {
          'signal.name': interception.signalName,
        },
        startTime: Date.now(),
      };

      applyCustomAttributes(span.attributes, { signalName: interception.signalName });

      onSpanStart?.(span);

      try {
        const result = yield* next(interception);
        span.endTime = Date.now();
        span.status = 'ok';
        onSpanEnd?.(span);
        return result;
      } catch (error) {
        span.endTime = Date.now();
        span.status = 'error';
        span.error = error instanceof Error ? error.message : String(error);
        onSpanEnd?.(span);
        throw error;
      }
    },

    *agent(
      interception: AgentInterception,
      next: (interception: AgentInterception) => Generator<unknown, unknown, unknown>,
    ): Generator<unknown, unknown, unknown> {
      const childSpanId = generateSpanId();
      const traceId = currentTraceId || generateTraceId();

      injectTraceParent(interception.headers, {
        version: '00',
        traceId,
        spanId: childSpanId,
        traceFlags: 1,
      });

      const span: SpanInfo = {
        name: 'agent',
        traceId,
        spanId: childSpanId,
        parentSpanId: rootSpanId,
        attributes: {
          'agent.model': interception.model,
        },
        startTime: Date.now(),
      };

      if (recordPayloads && interception.prompt) {
        span.attributes['agent.prompt'] = serializePayload(interception.prompt, maxPayloadSize);
      }

      applyCustomAttributes(span.attributes, { model: interception.model });

      onSpanStart?.(span);

      try {
        const result = yield* next(interception);
        span.endTime = Date.now();
        span.status = 'ok';
        onSpanEnd?.(span);
        return result;
      } catch (error) {
        span.endTime = Date.now();
        span.status = 'error';
        span.error = error instanceof Error ? error.message : String(error);
        onSpanEnd?.(span);
        throw error;
      }
    },

    signalReceived(
      interception: SignalReceivedInterception,
      next: (interception: SignalReceivedInterception) => void,
    ): void {
      // signalReceived is invoked from engine.signal(), outside any workflow
      // execution context. Generate a standalone trace rather than using the
      // shared currentTraceId/rootSpanId which belong to the last-started workflow.
      const spanId = generateSpanId();
      const traceId = generateTraceId();

      const span: SpanInfo = {
        name: `signal:received:${interception.signalName}`,
        traceId,
        spanId,
        attributes: {
          'signal.name': interception.signalName,
          'signal.workflow_id': interception.workflowId,
        },
        startTime: Date.now(),
      };

      applyCustomAttributes(span.attributes, { signalName: interception.signalName });

      onSpanStart?.(span);

      try {
        next(interception);
        span.endTime = Date.now();
        span.status = 'ok';
        onSpanEnd?.(span);
      } catch (error) {
        span.endTime = Date.now();
        span.status = 'error';
        span.error = error instanceof Error ? error.message : String(error);
        onSpanEnd?.(span);
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
      const traceId = parentContext?.traceId ?? generateTraceId();
      const parentSpanId = parentContext?.spanId;
      const childSpanId = generateSpanId();

      const span: SpanInfo = {
        name: `activity:${interception.activityName}`,
        traceId,
        spanId: childSpanId,
        ...(parentSpanId !== undefined ? { parentSpanId } : {}),
        attributes: {
          'activity.name': interception.activityName,
          'activity.attempt': interception.attempt,
        },
        startTime: Date.now(),
      };

      if (recordPayloads && interception.input !== undefined) {
        span.attributes['input'] = serializePayload(interception.input, maxPayloadSize);
      }

      applyCustomAttributes(span.attributes, {
        activityName: interception.activityName,
        attempt: interception.attempt,
      });

      onSpanStart?.(span);

      try {
        const result = await next(interception);
        span.endTime = Date.now();
        span.status = 'ok';
        onSpanEnd?.(span);
        return result;
      } catch (error) {
        span.endTime = Date.now();
        span.status = 'error';
        span.error = error instanceof Error ? error.message : String(error);
        onSpanEnd?.(span);
        throw error;
      }
    },
  };

  return { workflow, activity, metrics };
}
