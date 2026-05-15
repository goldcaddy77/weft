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

  it('ignores generated dashboard Svelte harness artifacts', () => {
    const generatedFiles = [
      'src/dashboard/components/.date-range-picker-harness.example.compiled/.date-range-picker-harness.example.svelte.js',
      'src/dashboard/fragments/.workflow-execution-timeline.example.compiled/workflow-execution-timeline.js',
      'src/dashboard/fragments/.schedule-list.example.compiled.mjs',
      'src/dashboard/views/.workflow-list-harness.example.compiled/.workflow-list-harness.example.js',
    ];

    for (const generatedFile of generatedFiles) {
      const coverage = parseLcov(
        [
          `SF:${generatedFile}`,
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
