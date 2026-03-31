import { describe, expect, it } from 'bun:test';

import type { MetricDefinition } from './metrics';
import { METRICS, MetricsCollector, createOtelMetrics } from './metrics';
import type { OtelMeter } from './no-op-telemetry';

describe('metrics', () => {
  const entries = Object.entries(METRICS) as [string, MetricDefinition][];

  it('all metrics have required fields', () => {
    for (const [key, metric] of entries) {
      expect(metric.name).toBeString();
      expect(metric.description).toBeString();
      expect(metric.unit).toBeString();
      expect(metric.type).toBeString();
      // Verify the fields are non-empty
      expect(metric.name.length).toBeGreaterThan(0);
      expect(metric.description.length).toBeGreaterThan(0);
      expect(metric.unit.length).toBeGreaterThan(0);
      expect(metric.type.length).toBeGreaterThan(0);
      // key should be a non-empty string
      expect(key.length).toBeGreaterThan(0);
    }
  });

  it('metric names start with "weft."', () => {
    for (const [, metric] of entries) {
      expect(metric.name.startsWith('weft.')).toBe(true);
    }
  });

  it('each metric has a valid type', () => {
    const validTypes = new Set(['counter', 'gauge', 'histogram']);
    for (const [, metric] of entries) {
      expect(validTypes.has(metric.type)).toBe(true);
    }
  });
});

describe('MetricsCollector', () => {
  describe('counters', () => {
    it('increments a counter by 1 by default', () => {
      const collector = new MetricsCollector();
      collector.increment('weft.workflow.started');
      collector.increment('weft.workflow.started');

      const snapshot = collector.snapshot();
      const metric = snapshot['weft.workflow.started'];
      expect(metric).toBeDefined();
      expect(metric!.type).toBe('counter');
      expect(metric!.type === 'counter' && metric!.value).toBe(2);
    });

    it('increments a counter by a specified value', () => {
      const collector = new MetricsCollector();
      collector.increment('weft.activity.attempts', 5);

      const snapshot = collector.snapshot();
      const metric = snapshot['weft.activity.attempts'];
      expect(metric).toBeDefined();
      expect(metric!.type === 'counter' && metric!.value).toBe(5);
    });

    it('tracks multiple counters independently', () => {
      const collector = new MetricsCollector();
      collector.increment('weft.workflow.started');
      collector.increment('weft.workflow.completed');
      collector.increment('weft.workflow.started');

      const snapshot = collector.snapshot();
      expect(
        snapshot['weft.workflow.started']!.type === 'counter' &&
          snapshot['weft.workflow.started']!.value,
      ).toBe(2);
      expect(
        snapshot['weft.workflow.completed']!.type === 'counter' &&
          snapshot['weft.workflow.completed']!.value,
      ).toBe(1);
    });
  });

  describe('histograms', () => {
    it('records histogram values and computes percentiles', () => {
      const collector = new MetricsCollector();
      const values = [10, 20, 30, 40, 50, 60, 70, 80, 90, 100];
      for (const value of values) {
        collector.record('weft.workflow.duration', value);
      }

      const snapshot = collector.snapshot();
      const metric = snapshot['weft.workflow.duration'];
      expect(metric).toBeDefined();
      expect(metric!.type).toBe('histogram');

      if (metric!.type === 'histogram') {
        expect(metric!.count).toBe(10);
        expect(metric!.sum).toBe(550);
        expect(metric!.min).toBe(10);
        expect(metric!.max).toBe(100);
        expect(metric!.p50).toBe(60); // sorted[5]
        expect(metric!.p99).toBe(100); // sorted[9]
      }
    });

    it('handles a single histogram observation', () => {
      const collector = new MetricsCollector();
      collector.record('weft.activity.duration', 42);

      const snapshot = collector.snapshot();
      const metric = snapshot['weft.activity.duration'];
      expect(metric).toBeDefined();

      if (metric!.type === 'histogram') {
        expect(metric!.count).toBe(1);
        expect(metric!.sum).toBe(42);
        expect(metric!.min).toBe(42);
        expect(metric!.max).toBe(42);
        expect(metric!.p50).toBe(42);
        expect(metric!.p99).toBe(42);
      }
    });
  });

  describe('gauges', () => {
    it('tracks a gauge value', () => {
      const collector = new MetricsCollector();
      collector.gauge('weft.workflow.active', 5);

      const snapshot = collector.snapshot();
      const metric = snapshot['weft.workflow.active'];
      expect(metric).toBeDefined();
      expect(metric!.type).toBe('gauge');
      expect(metric!.type === 'gauge' && metric!.value).toBe(5);
    });

    it('overwrites gauge with the latest value', () => {
      const collector = new MetricsCollector();
      collector.gauge('weft.workflow.active', 5);
      collector.gauge('weft.workflow.active', 3);

      const snapshot = collector.snapshot();
      const metric = snapshot['weft.workflow.active'];
      expect(metric!.type === 'gauge' && metric!.value).toBe(3);
    });
  });

  describe('snapshot', () => {
    it('returns all collected metrics across types', () => {
      const collector = new MetricsCollector();
      collector.increment('counter-a');
      collector.record('histogram-a', 10);
      collector.gauge('gauge-a', 7);

      const snapshot = collector.snapshot();
      expect(Object.keys(snapshot)).toHaveLength(3);
      expect(snapshot['counter-a']!.type).toBe('counter');
      expect(snapshot['histogram-a']!.type).toBe('histogram');
      expect(snapshot['gauge-a']!.type).toBe('gauge');
    });

    it('returns an empty object when nothing has been collected', () => {
      const collector = new MetricsCollector();
      const snapshot = collector.snapshot();
      expect(Object.keys(snapshot)).toHaveLength(0);
    });
  });

  describe('reset', () => {
    it('clears all counters, histograms, and gauges', () => {
      const collector = new MetricsCollector();
      collector.increment('weft.workflow.started');
      collector.record('weft.workflow.duration', 100);
      collector.gauge('weft.workflow.active', 2);

      collector.reset();

      const snapshot = collector.snapshot();
      expect(Object.keys(snapshot)).toHaveLength(0);
    });
  });
});

// ---------------------------------------------------------------------------
// createOtelMetrics
// ---------------------------------------------------------------------------

/** Build a recording meter that captures all instrument creation and calls. */
function createRecordingMeter(): {
  meter: OtelMeter;
  created: Array<{ type: string; name: string; options?: { unit?: string } }>;
  recordings: Array<{
    instrument: string;
    value: number;
    attributes?: Record<string, string | number | boolean>;
  }>;
} {
  const created: Array<{ type: string; name: string; options?: { unit?: string } }> = [];
  const recordings: Array<{
    instrument: string;
    value: number;
    attributes?: Record<string, string | number | boolean>;
  }> = [];

  const meter: OtelMeter = {
    createHistogram(name: string, options?: { unit?: string }) {
      created.push({ type: 'histogram', name, options });
      return {
        record(value: number, attributes?: Record<string, string | number | boolean>) {
          recordings.push({ instrument: name, value, attributes });
        },
      };
    },
    createCounter(name: string, options?: { unit?: string }) {
      created.push({ type: 'counter', name, options });
      return {
        add(value: number, attributes?: Record<string, string | number | boolean>) {
          recordings.push({ instrument: name, value, attributes });
        },
      };
    },
    createUpDownCounter(name: string, options?: { unit?: string }) {
      created.push({ type: 'upDownCounter', name, options });
      return {
        add(value: number, attributes?: Record<string, string | number | boolean>) {
          recordings.push({ instrument: name, value, attributes });
        },
      };
    },
  };

  return { meter, created, recordings };
}

describe('createOtelMetrics', () => {
  it('creates the expected OTel instruments when given a meter', () => {
    const { meter, created } = createRecordingMeter();
    const otelMetrics = createOtelMetrics(meter);

    expect(otelMetrics).toBeDefined();
    expect(otelMetrics.workflowDuration).toBeDefined();
    expect(otelMetrics.activityDuration).toBeDefined();
    expect(otelMetrics.activityAttempts).toBeDefined();
    expect(otelMetrics.activeWorkflows).toBeDefined();

    const names = created.map((c) => c.name);
    expect(names).toContain('weft.workflow.duration');
    expect(names).toContain('weft.activity.duration');
    expect(names).toContain('weft.activity.attempts');
    expect(names).toContain('weft.workflow.active');
  });

  it('creates histograms with correct units', () => {
    const { meter, created } = createRecordingMeter();
    createOtelMetrics(meter);

    const workflowDuration = created.find((c) => c.name === 'weft.workflow.duration');
    expect(workflowDuration).toBeDefined();
    expect(workflowDuration!.options?.unit).toBe('ms');

    const activityDuration = created.find((c) => c.name === 'weft.activity.duration');
    expect(activityDuration).toBeDefined();
    expect(activityDuration!.options?.unit).toBe('ms');
  });

  it('instruments are callable', () => {
    const { meter, recordings } = createRecordingMeter();
    const otelMetrics = createOtelMetrics(meter);

    otelMetrics.workflowDuration.record(150);
    otelMetrics.activityDuration.record(42);
    otelMetrics.activityAttempts.add(1);
    otelMetrics.activeWorkflows.add(1);
    otelMetrics.activeWorkflows.add(-1);

    expect(recordings).toHaveLength(5);
    expect(recordings[0]!.instrument).toBe('weft.workflow.duration');
    expect(recordings[0]!.value).toBe(150);
  });

  it('uses the no-op meter when called without arguments', () => {
    // Should not throw even without @opentelemetry/api installed
    const otelMetrics = createOtelMetrics();
    expect(otelMetrics).toBeDefined();
    expect(() => otelMetrics.workflowDuration.record(100)).not.toThrow();
    expect(() => otelMetrics.activityAttempts.add(1)).not.toThrow();
  });

  it('accepts a string meter name', () => {
    // Should use getOtelApi().metrics.getMeter(name) under the hood
    const otelMetrics = createOtelMetrics('my-service');
    expect(otelMetrics).toBeDefined();
    expect(() => otelMetrics.workflowDuration.record(100)).not.toThrow();
  });
});
