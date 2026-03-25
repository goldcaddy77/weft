import { describe, expect, it } from 'bun:test';

import type { MetricDefinition } from './metrics';
import { METRICS } from './metrics';

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
