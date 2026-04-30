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

export type SpanContext = {
  traceId: string;
  spanId: string;
  traceFlags: number;
};

/** A link to another span, used to express causal relationships without parent-child hierarchy. */
export type SpanLink = {
  context: SpanContext;
  attributes?: SpanAttributes;
};

type SpanStatus = {
  code: number;
  message?: string;
};

/**
 * Minimal span interface matching the OTel API surface we use.
 *
 * @example
 * ```ts
 * import { getOtelApi, type OtelSpan } from 'weft';
 *
 * const api = getOtelApi();
 * const tracer = api.trace.getTracer('example');
 * const span: OtelSpan = tracer.startSpan('my-operation');
 * span.setAttribute('user.id', 'u-123');
 * span.setStatus({ code: api.SpanStatusCode.OK });
 * span.end();
 * ```
 */
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
  links?: SpanLink[];
};

/**
 * Minimal tracer interface.
 *
 * @example
 * ```ts
 * import { getOtelApi, type OtelTracer } from 'weft';
 *
 * const api = getOtelApi();
 * const tracer: OtelTracer = api.trace.getTracer('my-service', '1.0.0');
 * const span = tracer.startSpan('task', { attributes: { 'task.id': '42' } });
 * span.end();
 * ```
 */
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

/**
 * Minimal meter interface.
 *
 * @example
 * ```ts
 * import { getOtelApi, type OtelMeter } from 'weft';
 *
 * const api = getOtelApi();
 * const meter: OtelMeter = api.metrics.getMeter('my-service');
 * const counter = meter.createCounter('requests.total');
 * counter.add(1, { route: '/api/start' });
 * ```
 */
export type OtelMeter = {
  createHistogram(name: string, options?: InstrumentOptions): OtelHistogram;
  createCounter(name: string, options?: InstrumentOptions): OtelCounter;
  createUpDownCounter(name: string, options?: InstrumentOptions): OtelUpDownCounter;
};

/**
 * The resolved OTel API surface Weft consumes.
 *
 * @example
 * ```ts
 * import { getOtelApi, type OtelApi } from 'weft';
 *
 * const api: OtelApi = getOtelApi();
 * const tracer = api.trace.getTracer('my-app');
 * const span = tracer.startSpan('boot');
 * span.setStatus({ code: api.SpanStatusCode.OK });
 * span.end();
 * ```
 */
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

/**
 * Static sentinel span context. Since no-op spans are never exported to a
 * collector, unique IDs are unnecessary. Using fixed values avoids burning
 * CPU on crypto operations in the hot path.
 */
const NO_OP_SPAN_CONTEXT: SpanContext = {
  traceId: '0'.repeat(32),
  spanId: '0'.repeat(16),
  traceFlags: 0, // Not sampled
};

/** Shared no-op span instance. All methods are no-ops, so one instance is safe to reuse. */
const NO_OP_SPAN: OtelSpan = {
  setAttribute() {},
  setStatus() {},
  recordException() {},
  end() {},
  spanContext() {
    return NO_OP_SPAN_CONTEXT;
  },
};

/** Shared no-op span methods for lightweight span adapters that only need a custom spanContext. */
export const NO_OP_SPAN_METHODS = {
  setAttribute: (...arguments_: Parameters<OtelSpan['setAttribute']>) =>
    NO_OP_SPAN.setAttribute(...arguments_),
  setStatus: (...arguments_: Parameters<OtelSpan['setStatus']>) =>
    NO_OP_SPAN.setStatus(...arguments_),
  recordException: (...arguments_: Parameters<OtelSpan['recordException']>) =>
    NO_OP_SPAN.recordException(...arguments_),
  end: (...arguments_: Parameters<OtelSpan['end']>) => NO_OP_SPAN.end(...arguments_),
} as const;

const noOpTracer: OtelTracer = {
  startSpan() {
    return NO_OP_SPAN;
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

/** Reset the cached API between tests so specific loader branches can be exercised deterministically. */
export function resetCachedOtelApiForTesting(): void {
  cached = undefined;
}

function resolveDefaultOtelLoader(): (moduleName: string) => unknown {
  const globalRequire = (globalThis as Record<PropertyKey, unknown>)['require'];
  if (typeof globalRequire === 'function') {
    return (moduleName: string) => globalRequire(moduleName);
  }

  return () => undefined;
}

/** Check whether a loaded module exposes the subset of the OpenTelemetry API Weft requires. */
export function isSupportedOtelApi(value: Partial<OtelApi> | undefined): value is OtelApi {
  return value?.trace?.getTracer != null && value.SpanStatusCode != null;
}

/**
 * Resolve the installed OpenTelemetry API using an injectable loader.
 * Returns `undefined` when the module is unavailable or exposes the wrong shape.
 */
export function resolveInstalledOtelApi(
  loader: (moduleName: string) => unknown = resolveDefaultOtelLoader(),
): OtelApi | undefined {
  try {
    const real = loader('@opentelemetry/api') as Partial<OtelApi>;
    if (isSupportedOtelApi(real)) {
      return real;
    }
  } catch {
    // Package not installed — fall through to no-op.
  }

  return undefined;
}

/**
 * Returns the `@opentelemetry/api` module if installed, otherwise returns
 * no-op implementations. The result is cached after the first call.
 *
 * This function is the single entry point for all OTel interactions in Weft.
 * When no SDK is configured the no-op implementations ensure zero overhead
 * because every method is an empty function the JIT can inline away.
 *
 * @example
 * ```ts
 * import { getOtelApi } from 'weft';
 *
 * // Works whether the OpenTelemetry API package is installed or not
 * const api = getOtelApi();
 * const tracer = api.trace.getTracer('my-app');
 * const span = tracer.startSpan('startup');
 * span.end();
 * ```
 */
export function getOtelApi(loader?: (moduleName: string) => unknown): OtelApi {
  if (cached) return cached;

  const installed = resolveInstalledOtelApi(loader);
  if (installed) {
    cached = installed;
    return cached;
  }

  cached = noOpApi;
  return cached;
}
