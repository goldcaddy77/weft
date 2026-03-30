/**
 * OpenTelemetry adapter for Weft observability.
 *
 * Wraps the callback-based observability interceptors with real OpenTelemetry
 * spans. Requires `@opentelemetry/api` to be installed as an optional peer
 * dependency.
 *
 * @module observability/opentelemetry
 */

import type { ObservabilityOptions, SpanInfo } from './index.ts';
import { createObservabilityInterceptors } from './index.ts';

// ---------------------------------------------------------------------------
// Dynamic import — avoids a hard dependency on @opentelemetry/api
// ---------------------------------------------------------------------------

// We avoid importing types from @opentelemetry/api since the package may not
// be installed. Instead we use `unknown` for the OTel API surface and cast as
// needed at runtime.

let otelApi: Record<string, unknown> | undefined;

try {
  // Use a variable to prevent TypeScript from resolving the module specifier
  // at compile time. The package is an optional peer dependency.
  const moduleName = '@opentelemetry/api';
  otelApi = (await import(/* @vite-ignore */ moduleName)) as Record<string, unknown>;
} catch {
  // @opentelemetry/api not installed — createOpenTelemetryInterceptors will
  // throw a helpful error at call time instead of at module import time.
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface OpenTelemetryOptions
  extends Omit<ObservabilityOptions, 'onSpanStart' | 'onSpanEnd'> {
  /** Name passed to `trace.getTracer()`. Default: `'weft'`. */
  tracerName?: string;
  /** Version passed to `trace.getTracer()`. */
  tracerVersion?: string;
}

// ---------------------------------------------------------------------------
// Minimal OTel shape used at runtime (avoids compile-time type dependency)
// ---------------------------------------------------------------------------

interface OtelSpan {
  setStatus(status: { code: number; message?: string }): void;
  setAttribute(key: string, value: string | number | boolean): void;
  end(endTime?: number): void;
}

interface OtelTracer {
  startSpan(
    name: string,
    options?: { attributes?: Record<string, string | number | boolean>; startTime?: number },
  ): OtelSpan;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create observability interceptors that emit real OpenTelemetry spans.
 *
 * @throws {Error} If `@opentelemetry/api` is not installed.
 */
export function createOpenTelemetryInterceptors(options?: OpenTelemetryOptions) {
  if (!otelApi) {
    throw new Error(
      'createOpenTelemetryInterceptors requires @opentelemetry/api to be installed. ' +
        'Run: bun add @opentelemetry/api',
    );
  }

  const trace = otelApi['trace'] as { getTracer(name: string, version?: string): OtelTracer };
  const SpanStatusCode = otelApi['SpanStatusCode'] as { OK: number; ERROR: number };

  const tracer = trace.getTracer(options?.tracerName ?? 'weft', options?.tracerVersion);
  const spans = new Map<string, OtelSpan>();

  return createObservabilityInterceptors({
    ...options,
    onSpanStart(span: SpanInfo) {
      const otelSpan = tracer.startSpan(span.name, {
        attributes: span.attributes,
        startTime: span.startTime,
      });
      spans.set(span.spanId, otelSpan);
    },
    onSpanEnd(span: SpanInfo) {
      const otelSpan = spans.get(span.spanId);
      if (!otelSpan) return;

      if (span.status === 'error' && span.error) {
        otelSpan.setStatus({ code: SpanStatusCode.ERROR, message: span.error });
      } else {
        otelSpan.setStatus({ code: SpanStatusCode.OK });
      }

      if (span.attributes) {
        for (const [key, value] of Object.entries(span.attributes)) {
          if (value !== undefined) {
            otelSpan.setAttribute(key, value);
          }
        }
      }

      otelSpan.end(span.endTime);
      spans.delete(span.spanId);
    },
  });
}
