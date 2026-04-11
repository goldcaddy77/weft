/**
 * W3C Trace Context propagation helpers.
 *
 * Implements parsing, formatting, and injection/extraction of the
 * `traceparent` header as defined in the W3C Trace Context specification.
 *
 * @see https://www.w3.org/TR/trace-context/
 * @module propagation
 */

// ---------------------------------------------------------------------------
// Portable random hex generation (Web Crypto API, available in all runtimes)
// ---------------------------------------------------------------------------

function randomHex(byteCount: number): string {
  const bytes = new Uint8Array(byteCount);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface TraceContext {
  version: string;
  traceId: string;
  spanId: string;
  traceFlags: number;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const TRACEPARENT_HEADER = 'traceparent';
const TRACEPARENT_REGEX = /^([0-9a-f]{2})-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/;
const ALL_ZEROS_TRACE_ID = '00000000000000000000000000000000';
const ALL_ZEROS_SPAN_ID = '0000000000000000';

// ---------------------------------------------------------------------------
// Parsing and formatting
// ---------------------------------------------------------------------------

/** Parse a W3C traceparent header string. */
export function parseTraceParent(value: string): TraceContext | null {
  const match = TRACEPARENT_REGEX.exec(value);

  if (!match) return null;

  const [, version, traceId, spanId, flags] = match;

  if (traceId === ALL_ZEROS_TRACE_ID) return null;
  if (spanId === ALL_ZEROS_SPAN_ID) return null;

  return {
    version: version!,
    traceId: traceId!,
    spanId: spanId!,
    traceFlags: parseInt(flags!, 16),
  };
}

/** Format a TraceContext to a W3C traceparent string. */
export function formatTraceParent(context: TraceContext): string {
  const flags = context.traceFlags.toString(16).padStart(2, '0');
  return `${context.version}-${context.traceId}-${context.spanId}-${flags}`;
}

// ---------------------------------------------------------------------------
// Header injection and extraction
// ---------------------------------------------------------------------------

/** Extract a traceparent header value from a headers map. */
export function extractTraceParent(headers: Map<string, string>): TraceContext | null {
  const value = headers.get(TRACEPARENT_HEADER);
  if (!value) return null;
  return parseTraceParent(value);
}

/** Inject a traceparent header into a headers map. */
export function injectTraceParent(headers: Map<string, string>, context: TraceContext): void {
  headers.set(TRACEPARENT_HEADER, formatTraceParent(context));
}

// ---------------------------------------------------------------------------
// ID generation
// ---------------------------------------------------------------------------

/** Generate a random trace ID (32 hex chars / 16 bytes). */
export function generateTraceId(): string {
  return randomHex(16);
}

/** Generate a random span ID (16 hex chars / 8 bytes). */
export function generateSpanId(): string {
  return randomHex(8);
}
