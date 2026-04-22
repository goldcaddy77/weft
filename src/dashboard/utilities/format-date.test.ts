import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';

import { formatRelativeTime, formatTimestamp } from './format-date.ts';

describe('format-date utilities', () => {
  const originalDateNow = Date.now;

  beforeEach(() => {
    Date.now = mock(() => Date.UTC(2026, 0, 1, 12, 0, 0));
  });

  afterEach(() => {
    Date.now = originalDateNow;
  });

  it('formats recent timestamps relative to now across each bucket', () => {
    expect(formatRelativeTime(Date.UTC(2026, 0, 1, 11, 59, 45))).toBe('just now');
    expect(formatRelativeTime(Date.UTC(2026, 0, 1, 11, 55, 0))).toBe('5m ago');
    expect(formatRelativeTime(Date.UTC(2026, 0, 1, 10, 0, 0))).toBe('2h ago');
    expect(formatRelativeTime(Date.UTC(2025, 11, 30, 12, 0, 0))).toBe('2d ago');
    expect(formatRelativeTime(Date.UTC(2025, 11, 18, 12, 0, 0))).toBe('2w ago');
  });

  it('formats older timestamps and nullish values for display', () => {
    expect(formatRelativeTime(new Date(Date.UTC(2025, 10, 1, 12, 0, 0)))).toMatch(
      /Nov \d{1,2}, 2025/,
    );
    expect(formatTimestamp(null)).toBe('-');
    expect(formatTimestamp(undefined)).toBe('-');
    expect(formatTimestamp('2026-01-01T12:34:56.000Z')).toContain('12:34:56');
  });
});
