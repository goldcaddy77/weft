import { describe, expect, it } from 'bun:test';

describe('opentelemetry adapter', () => {
  it('module can be imported without throwing', async () => {
    // The dynamic import of @opentelemetry/api inside the module should
    // gracefully catch the missing dependency. Importing the module itself
    // must not throw.
    const mod = await import('./opentelemetry.ts');
    expect(mod.createOpenTelemetryInterceptors).toBeFunction();
  });

  it('throws a helpful error when @opentelemetry/api is not installed', async () => {
    // Since @opentelemetry/api is not installed in this project's dev
    // dependencies, calling the factory should throw with install instructions.
    const { createOpenTelemetryInterceptors } = await import('./opentelemetry.ts');

    expect(() => createOpenTelemetryInterceptors()).toThrow(
      'requires @opentelemetry/api to be installed',
    );
  });

  it('accepts standard observability options', async () => {
    const { createOpenTelemetryInterceptors } = await import('./opentelemetry.ts');

    // Should still throw the missing dependency error, but should accept the
    // options shape without a type error at runtime.
    expect(() =>
      createOpenTelemetryInterceptors({
        tracerName: 'my-service',
        tracerVersion: '1.0.0',
        recordPayloads: true,
      }),
    ).toThrow('requires @opentelemetry/api');
  });
});
