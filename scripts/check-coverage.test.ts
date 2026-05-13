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
    const generatedFiles = [
      'weft-schedule-workflows-example.ts',
      'weft-schedule-input-example.ts',
      'weft-schedule-lmdb-workflows-example.ts',
      'weft-schedule-lmdb-input-example.ts',
      'weft-cli-edge-workflows-example.ts',
    ];

    for (const generatedFile of generatedFiles) {
      const coverage = parseLcov(
        [
          `SF:../../../../../../private/var/folders/x_/tmp/${generatedFile}`,
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
    }
  });

  it('ignores generated temporary workflow artifacts regardless of relative path depth', () => {
    const generatedPaths = [
      '../../../../private/var/folders/x_/tmp/weft-schedule-workflows-example.ts',
      '../../../../../../private/var/folders/x_/tmp/weft-schedule-input-example.ts',
      '../../../../var/folders/x_/tmp/weft-validate-mixed-clean-example.ts',
    ];

    for (const generatedPath of generatedPaths) {
      const coverage = parseLcov(
        [
          `SF:${generatedPath}`,
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
    }
  });

  it('does not ignore nearby non-generated temporary files', () => {
    const coverage = parseLcov(
      [
        'SF:../../../../../../private/var/folders/x_/tmp/weft-schedule-output-example.ts',
        'FNF:1',
        'FNH:0',
        'DA:1,0',
        'end_of_record',
      ].join('\n'),
    );

    expect(coverage.covered).toBe(false);
    expect(coverage.lines).toEqual({ total: 1, hit: 0, missed: 1 });
    expect(coverage.functions).toEqual({ total: 1, hit: 0, missed: 1 });
    expect(coverage.uncoveredFiles).toEqual([
      '../../../../../../private/var/folders/x_/tmp/weft-schedule-output-example.ts',
    ]);
  });
});
