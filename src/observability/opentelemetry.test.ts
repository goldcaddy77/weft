import { describe, expect, it } from 'bun:test';

describe('opentelemetry adapter (deprecated re-export)', () => {
  it('module can be imported without throwing', async () => {
    const mod = await import('./opentelemetry.ts');
    expect(mod.createOpenTelemetryInterceptors).toBeFunction();
  });

  it('createOpenTelemetryInterceptors works without @opentelemetry/api installed', async () => {
    const { createOpenTelemetryInterceptors } = await import('./opentelemetry.ts');

    // Now that the main interceptors use the no-op shim, this should not throw.
    const result = createOpenTelemetryInterceptors();
    expect(result.workflow).toBeDefined();
    expect(result.activity).toBeDefined();
    expect(result.metrics).toBeDefined();
  });

  it('accepts observability options', async () => {
    const { createOpenTelemetryInterceptors } = await import('./opentelemetry.ts');

    const result = createOpenTelemetryInterceptors({
      tracerName: 'my-service',
      tracerVersion: '1.0.0',
      recordPayloads: true,
    });

    expect(result.workflow).toBeDefined();
    expect(result.activity).toBeDefined();
  });

  it('is the same function as createObservabilityInterceptors', async () => {
    const { createOpenTelemetryInterceptors } = await import('./opentelemetry.ts');
    const { createObservabilityInterceptors } = await import('./index.ts');

    expect(createOpenTelemetryInterceptors).toBe(createObservabilityInterceptors);
  });
});
