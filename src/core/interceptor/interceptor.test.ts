import { describe, expect, it } from 'bun:test';
import { z } from 'zod';

import { interceptor } from './index.ts';
import type { ActivityInterception } from './interception-contexts.ts';
import type { Interceptor } from './interceptor-interfaces.ts';

function* passthroughActivity(
  this: void,
  interception: ActivityInterception,
  next: (interception: ActivityInterception) => Generator<unknown, unknown, unknown>,
): Generator<unknown, unknown, unknown> {
  return yield* next(interception);
}

const baseSpec: Interceptor & { name: string } = {
  name: 'tracer',
  activity: passthroughActivity,
};

describe('interceptor()', () => {
  it('returns the spec unchanged when no schemas are supplied', () => {
    const spec = interceptor({ ...baseSpec, name: 'noop' });

    expect(spec.name).toBe('noop');
    expect((spec as { inputSchema?: unknown }).inputSchema).toBeUndefined();
    expect((spec as { outputSchema?: unknown }).outputSchema).toBeUndefined();
  });

  it('preserves Standard Schema inputSchema and outputSchema', () => {
    const inputSchema = z.object({ traceId: z.string() });
    const outputSchema = z.object({ duration: z.number() });
    const spec = interceptor({
      ...baseSpec,
      inputSchema,
      outputSchema,
    });

    expect(spec.inputSchema).toBe(inputSchema);
    expect(spec.outputSchema).toBe(outputSchema);
  });

  it('rejects a malformed inputSchema', () => {
    expect(() =>
      interceptor({
        ...baseSpec,
        name: 'broken',
        inputSchema: { not: 'a schema' } as never,
      }),
    ).toThrow(/Standard Schema-compatible/);
  });
});
