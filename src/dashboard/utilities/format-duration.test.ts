import { describe, expect, it } from 'bun:test';

import { formatDuration } from './format-duration.ts';

describe('formatDuration', () => {
  it('formats millisecond durations into the largest useful unit pair', () => {
    expect(formatDuration(250)).toBe('250ms');
    expect(formatDuration(45_000)).toBe('45s');
    expect(formatDuration(72_000)).toBe('1m 12s');
    expect(formatDuration(8_100_000)).toBe('2h 15m');
  });

  it('formats start and end timestamps', () => {
    expect(formatDuration(1_000, 4_000)).toBe('3s');
    expect(formatDuration(new Date(1_000), new Date(61_000))).toBe('1m');
    expect(formatDuration('2026-05-15T00:00:00.000Z', '2026-05-15T02:00:00.000Z')).toBe('2h');
  });

  it('returns a dash for missing or negative durations', () => {
    expect(formatDuration(null, 1_000)).toBe('-');
    expect(formatDuration(2_000, null)).toBe('-');
    expect(formatDuration(2_000, 1_000)).toBe('-');
  });
});
