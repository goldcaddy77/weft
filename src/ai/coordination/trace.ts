/**
 * Create a new headers map for a child agent, preserving trace context from
 * the parent workflow's headers. This ensures OpenTelemetry spans from child
 * agents link back to the parent agent's span.
 *
 * @example Forward trace context when handing off to a child agent
 * ```ts
 * import { createChildHeaders, handoff } from 'weft';
 * import type { AgentDefinition, LLMProvider } from 'weft';
 *
 * declare const parent: { headers?: Map<string, string> };
 * declare const childAgent: AgentDefinition;
 * declare const provider: LLMProvider;
 *
 * const childHeaders = createChildHeaders(parent.headers);
 * await handoff({ agent: childAgent, input: 'Process this', provider, headers: childHeaders });
 * ```
 */
export function createChildHeaders(parentHeaders?: Map<string, string>): Map<string, string> {
  const childHeaders = new Map<string, string>();
  if (!parentHeaders) return childHeaders;

  // Forward the W3C traceparent header so the child agent's spans
  // participate in the same trace.
  const traceparent = parentHeaders.get('traceparent');
  if (traceparent) {
    childHeaders.set('traceparent', traceparent);
  }

  // Forward tracestate if present (W3C Trace Context Level 2).
  const tracestate = parentHeaders.get('tracestate');
  if (tracestate) {
    childHeaders.set('tracestate', tracestate);
  }

  return childHeaders;
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------
