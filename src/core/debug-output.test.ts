import { describe, expect, it } from 'bun:test';

import { safeDebugStringify, sanitizeDebugValueForDisplay } from './debug-output.ts';

describe('debug output sanitization', () => {
  it('redacts sensitive keys and token-like strings', () => {
    const sanitized = sanitizeDebugValueForDisplay({
      apiKey: 'sk-test-123',
      authorization: 'Bearer secret-token',
      nested: {
        password: 'p4ssw0rd',
      },
      profile: {
        name: 'Ada',
      },
    });

    expect(sanitized).toEqual({
      apiKey: '[REDACTED]',
      authorization: '[REDACTED]',
      nested: {
        password: '[REDACTED]',
      },
      profile: {
        name: 'Ada',
      },
    });
  });

  it('redacts payment-card-like strings', () => {
    expect(sanitizeDebugValueForDisplay('4111 1111 1111 1111')).toBe('[REDACTED]');
  });

  it('stringifies circular values without throwing', () => {
    const circular: Record<string, unknown> = { id: 'wf-1' };
    circular['self'] = circular;

    expect(safeDebugStringify(circular, 2)).toContain('"self": "[Circular]"');
  });
});
