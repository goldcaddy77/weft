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
  #counters = new Map<string, number>();
  #histograms = new Map<string, number[]>();
  #gauges = new Map<string, number>();

  /** Increment a counter by `value` (default 1). */
  increment(name: string, value: number = 1): void {
    this.#counters.set(name, (this.#counters.get(name) ?? 0) + value);
  }

  /** Record a histogram observation. */
  record(name: string, value: number): void {
    const values = this.#histograms.get(name) ?? [];
    values.push(value);
    this.#histograms.set(name, values);
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

    for (const [name, values] of this.#histograms) {
      const sorted = [...values].toSorted((a, b) => a - b);
      result[name] = {
        type: 'histogram',
        count: values.length,
        sum: values.reduce((a, b) => a + b, 0),
        p50: sorted[Math.floor(sorted.length * 0.5)] ?? 0,
        p99: sorted[Math.floor(sorted.length * 0.99)] ?? 0,
        min: sorted[0] ?? 0,
        max: sorted[sorted.length - 1] ?? 0,
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
} as const;
