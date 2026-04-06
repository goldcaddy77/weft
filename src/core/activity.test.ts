import { describe, expect, it } from 'bun:test';

import { activity } from './activity.ts';
import type { ActivityDefinition } from './types.ts';
import { activity as createConfiguredActivity } from './types.ts';

describe('activity()', () => {
  it('returns the definition unchanged', () => {
    const definition: ActivityDefinition<string, string> = {
      name: 'greet',
      execute: (input: string) => `Hello, ${input}!`,
    };

    const result = activity(definition);
    expect(result).toBe(definition);
  });

  it('preserves all fields including retry, timeout, queue, and idempotent', () => {
    const definition: ActivityDefinition<number, number> = {
      name: 'compute',
      execute: (input: number) => input * 2,
      retry: {
        maxAttempts: 5,
        initialBackoff: 500,
        backoffMultiplier: 1.5,
        maxBackoff: 10_000,
        nonRetryableErrors: ['ValidationError'],
      },
      timeout: '30 seconds',
      queue: 'high-priority',
      idempotent: true,
    };

    const result = activity(definition);

    expect(result.name).toBe('compute');
    expect(result.execute).toBe(definition.execute);
    expect(result.retry).toEqual(definition.retry);
    expect(result.timeout).toBe('30 seconds');
    expect(result.queue).toBe('high-priority');
    expect(result.idempotent).toBe(true);
  });

  it('preserves the execute function behavior', () => {
    const definition: ActivityDefinition<string, string> = {
      name: 'echo',
      execute: (input: string) => input.toUpperCase(),
    };

    const result = activity(definition);
    expect(result.execute('hello')).toBe('HELLO');
  });

  it('types.activity returns a callable function with colocated configuration', async () => {
    const sendEmail = createConfiguredActivity({
      name: 'send-email',
      queue: 'priority',
      execute: async (input: string) => `sent:${input}`,
    });

    expect(await sendEmail('welcome')).toBe('sent:welcome');
    expect(sendEmail.name).toBe('send-email');
    expect(sendEmail.queue).toBe('priority');
    expect(sendEmail.execute).toBeDefined();
  });
});
