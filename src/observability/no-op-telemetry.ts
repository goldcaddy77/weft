/**
 * OpenTelemetry API loader with no-op fallback.
 *
 * Attempts to load `@opentelemetry/api` at runtime. When the package is not
 * installed, returns lightweight no-op implementations that match the subset
 * of the OTel API that Weft uses. This ensures zero overhead when no SDK is
 * configured—every method call is a no-op that the JIT can inline away.
 *
 * @module no-op-telemetry
 */

// ---------------------------------------------------------------------------
// Shape types (the subset of @opentelemetry/api we consume)
// ---------------------------------------------------------------------------

type SpanAttributes = Record<string, string | number | boolean>;

type SpanContext = {
  traceId: string;
  spanId: string;
  traceFlags: number;
};

type SpanStatus = {
  code: number;
  message?: string;
};

/** Minimal span interface matching the OTel API surface we use. */
export type OtelSpan = {
  setAttribute(key: string, value: string | number | boolean): void;
  setStatus(status: SpanStatus): void;
  recordException(exception: Error | string): void;
  end(endTime?: number): void;
  spanContext(): SpanContext;
};

type SpanOptions = {
  attributes?: SpanAttributes;
  startTime?: number;
};

/** Minimal tracer interface. */
export type OtelTracer = {
  startSpan(name: string, options?: SpanOptions, context?: unknown): OtelSpan;
};

type InstrumentOptions = {
  unit?: string;
  description?: string;
};

type OtelHistogram = {
  record(value: number, attributes?: SpanAttributes): void;
};

type OtelCounter = {
  add(value: number, attributes?: SpanAttributes): void;
};

type OtelUpDownCounter = {
  add(value: number, attributes?: SpanAttributes): void;
};

/** Minimal meter interface. */
export type OtelMeter = {
  createHistogram(name: string, options?: InstrumentOptions): OtelHistogram;
  createCounter(name: string, options?: InstrumentOptions): OtelCounter;
  createUpDownCounter(name: string, options?: InstrumentOptions): OtelUpDownCounter;
};

/** The resolved OTel API surface Weft consumes. */
export type OtelApi = {
  trace: {
    getTracer(name: string, version?: string): OtelTracer;
    setSpan(context: unknown, span: OtelSpan): unknown;
  };
  metrics: {
    getMeter(name: string, version?: string): OtelMeter;
  };
  context: {
    ROOT_CONTEXT: unknown;
    with<T>(ctx: unknown, fn: () => T): T;
  };
  SpanStatusCode: {
    OK: number;
    ERROR: number;
    UNSET: number;
  };
};

// ---------------------------------------------------------------------------
// No-op implementations
// ---------------------------------------------------------------------------

const NO_OP_SPAN_CONTEXT: SpanContext = Object.freeze({
  traceId: '00000000000000000000000000000000',
  spanId: '0000000000000000',
  traceFlags: 0,
});

const noOpSpan: OtelSpan = {
  setAttribute() {},
  setStatus() {},
  recordException() {},
  end() {},
  spanContext() {
    return NO_OP_SPAN_CONTEXT;
  },
};

const noOpTracer: OtelTracer = {
  startSpan() {
    return noOpSpan;
  },
};

const noOpInstrument: OtelHistogram & OtelCounter & OtelUpDownCounter = {
  record() {},
  add() {},
};

const noOpMeter: OtelMeter = {
  createHistogram() {
    return noOpInstrument;
  },
  createCounter() {
    return noOpInstrument;
  },
  createUpDownCounter() {
    return noOpInstrument;
  },
};

const ROOT_CONTEXT = Symbol('ROOT_CONTEXT');

const noOpApi: OtelApi = {
  trace: {
    getTracer() {
      return noOpTracer;
    },
    setSpan(context: unknown) {
      return context;
    },
  },
  metrics: {
    getMeter() {
      return noOpMeter;
    },
  },
  context: {
    ROOT_CONTEXT,
    with<T>(_ctx: unknown, fn: () => T): T {
      return fn();
    },
  },
  SpanStatusCode: {
    OK: 1,
    ERROR: 2,
    UNSET: 0,
  },
};

// ---------------------------------------------------------------------------
// Loader
// ---------------------------------------------------------------------------

let cached: OtelApi | undefined;

/**
 * Returns the `@opentelemetry/api` module if installed, otherwise returns
 * no-op implementations. The result is cached after the first call.
 *
 * This function is the single entry point for all OTel interactions in Weft.
 * When no SDK is configured the no-op implementations ensure zero overhead
 * because every method is an empty function the JIT can inline away.
 */
export function getOtelApi(): OtelApi {
  if (cached) return cached;

  try {
    const moduleName = '@opentelemetry/api';
    const real = require(moduleName) as OtelApi;

    // Sanity-check: the real module must expose the shape we need.
    if (real.trace?.getTracer && real.SpanStatusCode) {
      cached = real;
      return cached;
    }
  } catch {
    // Package not installed — fall through to no-op.
  }

  cached = noOpApi;
  return cached;
}
