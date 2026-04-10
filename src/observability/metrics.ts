/**
 * Metric definitions for Weft observability.
 *
 * These constants describe the metrics emitted by Weft interceptors. They
 * follow OpenTelemetry semantic conventions where applicable, and can be
 * consumed by any metrics backend that accepts name/description/unit tuples.
 *
 * @module metrics
 */

import type { OtelMeter } from './no-op-telemetry';
import { getOtelApi } from './no-op-telemetry';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type MetricType = 'counter' | 'gauge' | 'histogram';

export interface MetricDefinition {
  name: string;
  description: string;
  unit: string;
  type: MetricType;
}

// ---------------------------------------------------------------------------
// Metric catalogue
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Circular buffer for bounded histogram storage
// ---------------------------------------------------------------------------

const DEFAULT_CIRCULAR_BUFFER_CAPACITY = 4096;

/**
 * A fixed-capacity ring buffer backed by a `Float64Array`.
 *
 * Once the buffer is full, new values overwrite the oldest entry so memory
 * usage stays bounded regardless of observation volume. Percentile queries
 * sort only the live portion of the backing array, avoiding a full-capacity
 * copy when the buffer is not yet saturated.
 */
export class CircularBuffer {
  readonly #capacity: number;
  #storage: Float64Array;
  #cursor: number;
  #count: number;

  constructor(capacity: number = DEFAULT_CIRCULAR_BUFFER_CAPACITY) {
    this.#capacity = capacity;
    this.#storage = new Float64Array(capacity);
    this.#cursor = 0;
    this.#count = 0;
  }

  /** Number of live values currently held in the buffer. */
  get length(): number {
    return this.#count;
  }

  /** Insert a value, overwriting the oldest entry when the buffer is full. */
  push(value: number): void {
    this.#storage[this.#cursor] = value;
    this.#cursor = (this.#cursor + 1) % this.#capacity;
    if (this.#count < this.#capacity) {
      this.#count++;
    }
  }

  /**
   * Compute the p-th percentile (0–1) of all live values.
   *
   * Sorts a temporary copy of the live portion only — never the full capacity
   * array. Returns 0 when the buffer is empty.
   */
  percentile(p: number): number {
    if (this.#count === 0) return 0;
    const live = Array.from(this.#storage.subarray(0, this.#count)).toSorted(
      (left, right) => left - right,
    );
    const index = Math.floor(live.length * p);
    return live[index] ?? live[live.length - 1] ?? 0;
  }

  /** Sum of all live values. */
  sum(): number {
    let total = 0;
    for (let index = 0; index < this.#count; index++) {
      total += this.#storage[index] ?? 0;
    }
    return total;
  }

  /** Minimum live value, or 0 if the buffer is empty. */
  min(): number {
    if (this.#count === 0) return 0;
    let minimum = this.#storage[0] ?? 0;
    for (let index = 1; index < this.#count; index++) {
      const value = this.#storage[index] ?? 0;
      if (value < minimum) minimum = value;
    }
    return minimum;
  }

  /** Maximum live value, or 0 if the buffer is empty. */
  max(): number {
    if (this.#count === 0) return 0;
    let maximum = this.#storage[0] ?? 0;
    for (let index = 1; index < this.#count; index++) {
      const value = this.#storage[index] ?? 0;
      if (value > maximum) maximum = value;
    }
    return maximum;
  }
}

// ---------------------------------------------------------------------------
// Metrics collector
// ---------------------------------------------------------------------------

export type CounterMetric = { type: 'counter'; value: number };

export type HistogramMetric = {
  type: 'histogram';
  count: number;
  sum: number;
  p50: number;
  p99: number;
  min: number;
  max: number;
};

export type GaugeMetric = { type: 'gauge'; value: number };

export type MetricsSnapshot = Record<string, CounterMetric | HistogramMetric | GaugeMetric>;

/**
 * Collects counters, histograms, and gauges for Weft observability.
 *
 * Thread-safe within a single Bun isolate. Call {@link snapshot} to read
 * all collected values and {@link reset} to clear them.
 */
export class MetricsCollector {
  #counters: Map<string, number>;
  #histograms: Map<string, CircularBuffer>;
  #gauges: Map<string, number>;

  constructor() {
    this.#counters = new Map();
    this.#histograms = new Map();
    this.#gauges = new Map();
  }

  /** Increment a counter by `value` (default 1). */
  increment(name: string, value: number = 1): void {
    this.#counters.set(name, (this.#counters.get(name) ?? 0) + value);
  }

  /** Record a histogram observation. Memory usage is bounded by the circular buffer capacity. */
  record(name: string, value: number): void {
    let buffer = this.#histograms.get(name);
    if (!buffer) {
      buffer = new CircularBuffer();
      this.#histograms.set(name, buffer);
    }
    buffer.push(value);
  }

  /** Set an absolute gauge value. */
  gauge(name: string, value: number): void {
    this.#gauges.set(name, value);
  }

  /** Return a point-in-time snapshot of all collected metrics. */
  snapshot(): MetricsSnapshot {
    const result: MetricsSnapshot = {};

    for (const [name, count] of this.#counters) {
      result[name] = { type: 'counter', value: count };
    }

    for (const [name, buffer] of this.#histograms) {
      result[name] = {
        type: 'histogram',
        count: buffer.length,
        sum: buffer.sum(),
        p50: buffer.percentile(0.5),
        p99: buffer.percentile(0.99),
        min: buffer.min(),
        max: buffer.max(),
      };
    }

    for (const [name, value] of this.#gauges) {
      result[name] = { type: 'gauge', value };
    }

    return result;
  }

  /** Clear all collected metrics. */
  reset(): void {
    this.#counters.clear();
    this.#histograms.clear();
    this.#gauges.clear();
  }
}

// ---------------------------------------------------------------------------
// OTel metrics bridge
// ---------------------------------------------------------------------------

/** OTel instrument set for Weft metrics. */
export type OtelMetrics = {
  workflowDuration: {
    record(value: number, attributes?: Record<string, string | number | boolean>): void;
  };
  activityDuration: {
    record(value: number, attributes?: Record<string, string | number | boolean>): void;
  };
  activityAttempts: {
    add(value: number, attributes?: Record<string, string | number | boolean>): void;
  };
  activeWorkflows: {
    add(value: number, attributes?: Record<string, string | number | boolean>): void;
  };
};

/**
 * Create OTel instruments for the standard Weft metrics.
 *
 * Accepts an `OtelMeter` instance, a string meter name, or nothing. When
 * called without arguments it uses `getOtelApi().metrics.getMeter('weft')`,
 * which returns a no-op meter when `@opentelemetry/api` is not installed.
 */
export function createOtelMetrics(meterOrName?: OtelMeter | string): OtelMetrics {
  let meter: OtelMeter;
  if (typeof meterOrName === 'string') {
    meter = getOtelApi().metrics.getMeter(meterOrName);
  } else if (meterOrName) {
    meter = meterOrName;
  } else {
    meter = getOtelApi().metrics.getMeter('weft');
  }

  return {
    workflowDuration: meter.createHistogram('weft.workflow.duration', { unit: 'ms' }),
    activityDuration: meter.createHistogram('weft.activity.duration', { unit: 'ms' }),
    activityAttempts: meter.createCounter('weft.activity.attempts'),
    activeWorkflows: meter.createUpDownCounter('weft.workflow.active'),
  };
}

// ---------------------------------------------------------------------------
// Prometheus exporter
// ---------------------------------------------------------------------------

/**
 * Pluggable interface for producing Prometheus text-format output at
 * `/v1/metrics`. Weft ships with a default implementation that serializes a
 * {@link MetricsCollector} snapshot, but consumers who already use OTel can
 * adapt `@opentelemetry/exporter-prometheus` (or any other source) to this
 * interface and pass it via `HandlerOptions.prometheusExporter`.
 *
 * Keeping this as an interface rather than hard-wiring the OTel SDK avoids
 * pulling `@opentelemetry/sdk-metrics` into the runtime footprint while still
 * giving projects that *do* want full OTel a clean plug point.
 *
 * > [!WARNING] `/v1/metrics` is unauthenticated by default
 * > The Weft server treats `/v1/metrics` as a public path (see
 * > `DEFAULT_PUBLIC_PATHS` in `src/server/authentication.ts`) so that
 * > Prometheus scrapers can read it without credentials. The default
 * > {@link createMetricsCollectorExporter} only emits aggregate counters and
 * > histograms with no labels, which is safe to expose. **A custom
 * > `PrometheusExporter` that emits labels — especially labels containing
 * > tenant identifiers, user identifiers, request paths with IDs, or any
 * > other PII — will leak that data to anyone who can reach the endpoint.**
 * >
 * > If your exporter emits sensitive labels, override the default by setting
 * > `auth.publicPaths` on the server options to a list that does *not*
 * > include `/v1/metrics`, then scrape it with an authenticated client.
 */
export interface PrometheusExporter {
  /**
   * Produce Prometheus text-format output for the current state of the metrics
   * source. Must be safe to call repeatedly — each invocation should reflect
   * the latest values.
   */
  serialize(): string | Promise<string>;
}

/**
 * Serialize a {@link MetricsSnapshot} as Prometheus text format using the
 * definitions registered in {@link METRICS}. Metrics that aren't in the
 * snapshot still emit their `# HELP` / `# TYPE` lines with zero values so
 * Prometheus scrapers see a stable schema.
 */
export function serializeMetricsSnapshotForPrometheus(snapshot: MetricsSnapshot): string {
  const lines: string[] = [];

  for (const metric of Object.values(METRICS)) {
    const safeName = metric.name.replace(/\./g, '_');
    const collected = snapshot[metric.name];

    lines.push(`# HELP ${safeName} ${metric.description}`);

    if (metric.type === 'histogram') {
      lines.push(`# TYPE ${safeName} histogram`);
      const count = collected?.type === 'histogram' ? collected.count : 0;
      const sum = collected?.type === 'histogram' ? collected.sum : 0;
      lines.push(`${safeName}_count ${count}`);
      lines.push(`${safeName}_sum ${sum}`);
    } else if (metric.type === 'counter') {
      lines.push(`# TYPE ${safeName} counter`);
      const value = collected?.type === 'counter' ? collected.value : 0;
      lines.push(`${safeName}_total ${value}`);
    } else {
      lines.push(`# TYPE ${safeName} gauge`);
      const value = collected?.type === 'gauge' ? collected.value : 0;
      lines.push(`${safeName} ${value}`);
    }
  }

  // Derived DPMO gauge: (defects / operations) * 1_000_000
  const dpmoDefectsEntry = snapshot[METRICS.dpmoDefects.name];
  const dpmoOperationsEntry = snapshot[METRICS.dpmoOperations.name];
  const dpmoDefects = dpmoDefectsEntry?.type === 'counter' ? dpmoDefectsEntry.value : 0;
  const dpmoOperations = dpmoOperationsEntry?.type === 'counter' ? dpmoOperationsEntry.value : 0;
  const dpmoValue = dpmoOperations === 0 ? 0 : (dpmoDefects * 1_000_000) / dpmoOperations;
  const dpmoGaugeName = 'weft_dpmo';
  lines.push(
    `# HELP ${dpmoGaugeName} Defects per million operations (failed workflows / started workflows * 1e6)`,
  );
  lines.push(`# TYPE ${dpmoGaugeName} gauge`);
  lines.push(`${dpmoGaugeName} ${dpmoValue}`);

  return lines.join('\n') + '\n';
}

/**
 * Default {@link PrometheusExporter} that sources its values from a
 * {@link MetricsCollector}. Equivalent to the previous inline serializer in
 * the server's `/v1/metrics` handler — extracted here so it can be reused and
 * so a custom implementation can be substituted without touching the server.
 */
export function createMetricsCollectorExporter(
  collector: MetricsCollector | undefined,
): PrometheusExporter {
  return {
    serialize(): string {
      const snapshot = collector?.snapshot() ?? {};
      return serializeMetricsSnapshotForPrometheus(snapshot);
    },
  };
}

// ---------------------------------------------------------------------------
// Metric catalogue
// ---------------------------------------------------------------------------

/** Metric names and descriptions for Weft observability. */
export const METRICS = {
  workflowDuration: {
    name: 'weft.workflow.duration',
    description: 'Duration of workflow execution in milliseconds',
    unit: 'ms',
    type: 'histogram' as const,
  },
  activityDuration: {
    name: 'weft.activity.duration',
    description: 'Duration of activity execution in milliseconds',
    unit: 'ms',
    type: 'histogram' as const,
  },
  activityAttempts: {
    name: 'weft.activity.attempts',
    description: 'Total activity execution attempts',
    unit: 'attempts',
    type: 'counter' as const,
  },
  workflowActive: {
    name: 'weft.workflow.active',
    description: 'Number of currently active workflows',
    unit: 'workflows',
    type: 'gauge' as const,
  },
  workflowStarted: {
    name: 'weft.workflow.started',
    description: 'Total workflows started',
    unit: 'workflows',
    type: 'counter' as const,
  },
  workflowCompleted: {
    name: 'weft.workflow.completed',
    description: 'Total workflows completed',
    unit: 'workflows',
    type: 'counter' as const,
  },
  workflowFailed: {
    name: 'weft.workflow.failed',
    description: 'Total workflows failed',
    unit: 'workflows',
    type: 'counter' as const,
  },
  promptCacheHits: {
    name: 'weft.prompt_cache.hits',
    description: 'Total prompt prefix cache hits',
    unit: 'hits',
    type: 'counter' as const,
  },
  promptCacheMisses: {
    name: 'weft.prompt_cache.misses',
    description: 'Total prompt prefix cache misses',
    unit: 'misses',
    type: 'counter' as const,
  },
  dpmoDefects: {
    name: 'weft.dpmo.defects',
    description: 'Total failed workflows (DPMO numerator)',
    unit: 'workflows',
    type: 'counter' as const,
  },
  dpmoOperations: {
    name: 'weft.dpmo.operations',
    description: 'Total started workflows (DPMO denominator)',
    unit: 'workflows',
    type: 'counter' as const,
  },
} as const;
