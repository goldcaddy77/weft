import { describe, expect, it } from 'bun:test';

import { workflow } from './workflow-function.ts';

describe('workflow()', () => {
  it('accepts a named function directly and derives the workflow name from it', () => {
    const checkout = workflow(async function* checkout(_ctx, input: string) {
      return input.toUpperCase();
    });

    expect(checkout.name).toBe('checkout');
    expect(checkout.handler).toBeDefined();
  });

  it('rejects unnamed workflow definitions from either branch', () => {
    expect(() =>
      workflow(async function* (_ctx, input: string) {
        return input;
      }),
    ).toThrow('workflow() requires a named function or an options object with name.');

    expect(() =>
      workflow({
        name: '',
        handler: async function* (_ctx, input: string) {
          return input;
        },
      }),
    ).toThrow('workflow() requires a named function or an options object with name.');
  });
});
