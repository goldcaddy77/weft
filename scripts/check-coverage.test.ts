import { describe, expect, it } from 'bun:test';

import { parseLcov } from './check-coverage.ts';

describe('parseLcov', () => {
  it('accepts DA lines with the optional checksum field', () => {
    const coverage = parseLcov(
      [
        'SF:src/example.ts',
        'FNF:0',
        'FNH:0',
        'DA:10,1,abc123',
        'DA:11,0,def456',
        'end_of_record',
      ].join('\n'),
    );

    expect(coverage.lines.total).toBe(2);
    expect(coverage.lines.hit).toBe(1);
    expect(coverage.lines.missed).toBe(1);
    expect(coverage.covered).toBe(false);
    expect(coverage.uncoveredFiles).toEqual(['src/example.ts']);
  });

  it('ignores generated temporary workflow artifacts', () => {
    const coverage = parseLcov(
      [
        'SF:../../../../../../private/var/folders/x_/tmp/weft-schedule-input-example.ts',
        'FNF:1',
        'FNH:0',
        'DA:1,0',
        'end_of_record',
        'SF:src/example.ts',
        'FNF:1',
        'FNH:1',
        'DA:1,1',
        'end_of_record',
      ].join('\n'),
    );

    expect(coverage.covered).toBe(true);
    expect(coverage.lines).toEqual({ total: 1, hit: 1, missed: 0 });
    expect(coverage.functions).toEqual({ total: 1, hit: 1, missed: 0 });
    expect(coverage.uncoveredFiles).toEqual([]);
  });
});
