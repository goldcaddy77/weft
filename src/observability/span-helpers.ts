import type { OpenTelemetrySpan } from './no-op-telemetry';
import { injectTraceParent } from './propagation';
import type { InterceptionContext, ObservabilityState } from './types';

export const DEFAULT_MAX_PAYLOAD_SIZE = 1024;

export function serializePayload(input: unknown, maxSize: number): string {
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
export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Convert an unknown thrown value to an Error for `recordException`. */
export function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

/** Inject the traceparent header from a span's context into a headers map. */
export function injectSpanContext(span: OpenTelemetrySpan, headers: Map<string, string>): void {
  const ctx = span.spanContext();
  injectTraceParent(headers, {
    version: '00',
    traceId: ctx.traceId,
    spanId: ctx.spanId,
    traceFlags: ctx.traceFlags,
  });
}

export function applyCustomAttributes(
  state: ObservabilityState,
  span: OpenTelemetrySpan,
  interception: InterceptionContext,
): void {
  const attributeExtractor = state.attributeExtractor;
  if (!attributeExtractor) return;
  const custom = attributeExtractor(interception);
  for (const [key, value] of Object.entries(custom)) {
    span.setAttribute(key, value);
  }
}

export function parentContextForWorkflow(state: ObservabilityState, workflowId: string): unknown {
  const rootEntry = state.workflowSpans.get(workflowId);
  return rootEntry
    ? state.trace.setSpan(state.api.context.ROOT_CONTEXT, rootEntry.span)
    : state.api.context.ROOT_CONTEXT;
}
