import { describe, expect, it } from 'bun:test';

import { clampWorkerReconnectGracePeriod } from './serve-internals.ts';

describe('clampWorkerReconnectGracePeriod', () => {
  it('returns the 100ms default when undefined', () => {
    expect(clampWorkerReconnectGracePeriod(undefined)).toBe(100);
  });

  it('returns the 100ms default for non-finite values', () => {
    expect(clampWorkerReconnectGracePeriod(Number.NaN)).toBe(100);
    expect(clampWorkerReconnectGracePeriod(Number.POSITIVE_INFINITY)).toBe(100);
    expect(clampWorkerReconnectGracePeriod(Number.NEGATIVE_INFINITY)).toBe(100);
  });

  it('honors 0 as the explicit no-grace bypass', () => {
    expect(clampWorkerReconnectGracePeriod(0)).toBe(0);
  });

  it('honors finite positive values inside the 1..5000 range', () => {
    expect(clampWorkerReconnectGracePeriod(1)).toBe(1);
    expect(clampWorkerReconnectGracePeriod(250)).toBe(250);
    expect(clampWorkerReconnectGracePeriod(5_000)).toBe(5_000);
  });

  it('clamps negative values to 0', () => {
    expect(clampWorkerReconnectGracePeriod(-1)).toBe(0);
    expect(clampWorkerReconnectGracePeriod(-1_000)).toBe(0);
  });

  it('clamps values above 5000 to 5000', () => {
    expect(clampWorkerReconnectGracePeriod(5_001)).toBe(5_000);
    expect(clampWorkerReconnectGracePeriod(1_000_000)).toBe(5_000);
  });

  it('floors fractional values', () => {
    expect(clampWorkerReconnectGracePeriod(123.7)).toBe(123);
  });
});
