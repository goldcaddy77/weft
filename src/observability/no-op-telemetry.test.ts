import { describe, expect, it } from 'bun:test';

import { getOtelApi } from './no-op-telemetry';

describe('getOtelApi', () => {
  it('returns an object with trace, metrics, context, and SpanStatusCode', () => {
    const api = getOtelApi();
    expect(api.trace).toBeDefined();
    expect(api.metrics).toBeDefined();
    expect(api.context).toBeDefined();
    expect(api.SpanStatusCode).toBeDefined();
  });

  it('returns SpanStatusCode with OK, ERROR, and UNSET values', () => {
    const { SpanStatusCode } = getOtelApi();
    expect(SpanStatusCode.OK).toBe(1);
    expect(SpanStatusCode.ERROR).toBe(2);
    expect(SpanStatusCode.UNSET).toBe(0);
  });

  describe('no-op tracer', () => {
    it('creates a tracer via trace.getTracer()', () => {
      const { trace } = getOtelApi();
      const tracer = trace.getTracer('test');
      expect(tracer).toBeDefined();
      expect(typeof tracer.startSpan).toBe('function');
    });

    it('creates spans that do not throw', () => {
      const { trace } = getOtelApi();
      const tracer = trace.getTracer('test', '1.0.0');
      const span = tracer.startSpan('test-span');

      expect(() => span.setAttribute('key', 'value')).not.toThrow();
      expect(() => span.setStatus({ code: 1 })).not.toThrow();
      expect(() => span.recordException(new Error('test'))).not.toThrow();
      expect(() => span.end()).not.toThrow();
    });

    it('returns a span context with valid structure', () => {
      const { trace } = getOtelApi();
      const tracer = trace.getTracer('test');
      const span = tracer.startSpan('test-span');
      const ctx = span.spanContext();

      expect(ctx).toBeDefined();
      expect(typeof ctx.traceId).toBe('string');
      expect(typeof ctx.spanId).toBe('string');
      expect(typeof ctx.traceFlags).toBe('number');
    });

    it('returns a static no-op span context with sentinel values', () => {
      const { trace } = getOtelApi();
      const tracer = trace.getTracer('test');
      const span1 = tracer.startSpan('span-1');
      const span2 = tracer.startSpan('span-2');
      const ctx1 = span1.spanContext();

      expect(ctx1.traceId).toHaveLength(32);
      expect(ctx1.traceId).toBe('0'.repeat(32));
      expect(ctx1.spanId).toHaveLength(16);
      expect(ctx1.spanId).toBe('0'.repeat(16));
      expect(ctx1.traceFlags).toBe(0); // Not sampled
      // All no-op spans share the same instance
      expect(span1).toBe(span2);
    });
  });

  describe('no-op meter', () => {
    it('creates a meter via metrics.getMeter()', () => {
      const { metrics } = getOtelApi();
      const meter = metrics.getMeter('test');
      expect(meter).toBeDefined();
    });

    it('creates histogram, counter, and upDownCounter without throwing', () => {
      const { metrics } = getOtelApi();
      const meter = metrics.getMeter('test');

      const histogram = meter.createHistogram('test.hist', { unit: 'ms' });
      expect(histogram).toBeDefined();
      expect(() => histogram.record(42)).not.toThrow();
      expect(() => histogram.record(100, { key: 'value' })).not.toThrow();

      const counter = meter.createCounter('test.counter');
      expect(counter).toBeDefined();
      expect(() => counter.add(1)).not.toThrow();
      expect(() => counter.add(5, { key: 'value' })).not.toThrow();

      const upDown = meter.createUpDownCounter('test.updown');
      expect(upDown).toBeDefined();
      expect(() => upDown.add(1)).not.toThrow();
      expect(() => upDown.add(-1)).not.toThrow();
    });
  });

  describe('context utilities', () => {
    it('trace.setSpan returns a context value', () => {
      const { trace, context } = getOtelApi();
      const tracer = trace.getTracer('test');
      const span = tracer.startSpan('test-span');
      const ctx = trace.setSpan(context.ROOT_CONTEXT, span);
      expect(ctx).toBeDefined();
    });

    it('context.with calls the callback and returns its result', () => {
      const { context } = getOtelApi();
      const result = context.with(context.ROOT_CONTEXT, () => 'hello');
      expect(result).toBe('hello');
    });
  });

  it('returns the same API on repeated calls (cached)', () => {
    const api1 = getOtelApi();
    const api2 = getOtelApi();
    expect(api1).toBe(api2);
  });
});
