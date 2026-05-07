import { describe, expect, it } from 'bun:test';
import { z } from 'zod';

import { schedule } from './schedules.ts';

describe('schedule()', () => {
  it('returns the definition unchanged when no schema is supplied', () => {
    const definition = schedule({
      workflow: 'report',
      cron: '0 9 * * *',
      input: null,
    });

    expect(definition.workflow).toBe('report');
    expect(definition.inputSchema).toBeUndefined();
  });

  it('preserves a Standard Schema inputSchema', () => {
    const inputSchema = z.object({ day: z.string() });
    const definition = schedule({
      workflow: 'report',
      cron: '0 9 * * *',
      input: { day: 'today' },
      inputSchema,
    });

    expect(definition.inputSchema).toBe(inputSchema);
  });

  it('rejects an inputSchema that is not Standard Schema-shaped', () => {
    expect(() =>
      schedule({
        workflow: 'report',
        cron: '0 9 * * *',
        input: { day: 'today' },
        inputSchema: { not: 'a schema' } as never,
      }),
    ).toThrow(/Standard Schema-compatible/);
  });
});
