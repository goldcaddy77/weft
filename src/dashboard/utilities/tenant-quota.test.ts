import { describe, expect, it } from 'bun:test';

import {
  computeTenantQuotaMeter,
  formatTenantQuotaBytes,
  formatTenantQuotaWindow,
} from './tenant-quota.ts';

describe('computeTenantQuotaMeter', () => {
  it('returns a normal meter when no limit is configured', () => {
    expect(computeTenantQuotaMeter({ used: 42, limit: null })).toEqual({
      percentage: 0,
      severity: 'normal',
    });
  });

  it('treats a zero limit as a hard cap instead of no limit', () => {
    expect(computeTenantQuotaMeter({ used: 0, limit: 0 })).toEqual({
      percentage: 0,
      severity: 'normal',
    });
    expect(computeTenantQuotaMeter({ used: 1, limit: 0 })).toEqual({
      percentage: 100,
      severity: 'danger',
    });
  });

  it('marks ratios at or above 80 percent as warning', () => {
    expect(computeTenantQuotaMeter({ used: 8, limit: 10 })).toEqual({
      percentage: 80,
      severity: 'warning',
    });
  });

  it('marks ratios at or above 100 percent as danger', () => {
    expect(computeTenantQuotaMeter({ used: 10, limit: 10 })).toEqual({
      percentage: 100,
      severity: 'danger',
    });
  });

  it('treats negative limits as effectively unconfigured and clamps percentages above 100', () => {
    expect(computeTenantQuotaMeter({ used: 10, limit: -1 })).toEqual({
      percentage: 0,
      severity: 'normal',
    });
    expect(computeTenantQuotaMeter({ used: 25, limit: 10 })).toEqual({
      percentage: 100,
      severity: 'danger',
    });
  });
});

describe('formatTenantQuotaBytes', () => {
  it('formats bytes below one kilobyte without conversion', () => {
    expect(formatTenantQuotaBytes(512)).toBe('512 B');
  });

  it('formats kilobytes and megabytes with a single decimal place', () => {
    expect(formatTenantQuotaBytes(2048)).toBe('2.0 KB');
    expect(formatTenantQuotaBytes(2 * 1024 * 1024)).toBe('2.0 MB');
  });
});

describe('formatTenantQuotaWindow', () => {
  it('formats null as an unconfigured window', () => {
    expect(formatTenantQuotaWindow({ used: 0, limit: null, windowMilliseconds: null })).toBe(
      'No window configured',
    );
  });

  it('formats second and minute windows', () => {
    expect(formatTenantQuotaWindow({ used: 1, limit: 5, windowMilliseconds: 30_000 })).toBe(
      '30s window',
    );
    expect(formatTenantQuotaWindow({ used: 1, limit: 5, windowMilliseconds: 300_000 })).toBe(
      '5m window',
    );
  });

  it('formats fractional-minute windows when they do not divide evenly', () => {
    expect(formatTenantQuotaWindow({ used: 1, limit: 5, windowMilliseconds: 90_000 })).toBe(
      '1.5m window',
    );
  });
});
