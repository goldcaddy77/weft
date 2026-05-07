import { describe, expect, it } from 'bun:test';
import { z } from 'zod';

import { constraint } from './constraint.ts';

describe('constraint()', () => {
  it('returns the definition unchanged when no schema is supplied', () => {
    const definition = constraint({
      name: 'positiveBalance',
      scope: 'transaction',
      check: () => true,
      onViolation: 'fail',
    });

    expect(definition.name).toBe('positiveBalance');
    expect(definition.inputSchema).toBeUndefined();
  });

  it('preserves a Standard Schema inputSchema', () => {
    const inputSchema = z.object({ amount: z.number() });
    const definition = constraint({
      name: 'positiveBalance',
      scope: 'transaction',
      check: () => true,
      onViolation: 'fail',
      inputSchema,
    });

    expect(definition.inputSchema).toBe(inputSchema);
  });

  it('rejects an inputSchema that is not Standard Schema-shaped', () => {
    expect(() =>
      constraint({
        name: 'positiveBalance',
        scope: 'transaction',
        check: () => true,
        onViolation: 'fail',
        inputSchema: { not: 'a schema' } as never,
      }),
    ).toThrow(/Standard Schema-compatible/);
  });
});
