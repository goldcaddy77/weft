import { describe, expect, it } from 'bun:test';

import { parseMarkdownDoctestSkipCounts } from './markdown-doctest-skip-counts.ts';

describe('markdown doctest skip counts', () => {
  const sourcePath = 'scripts/markdown-doctest-skip-counts.json';

  it('parses valid skip-count objects', () => {
    expect(parseMarkdownDoctestSkipCounts('{"setup": 2, "teaching-only": 0}', sourcePath)).toEqual({
      setup: 2,
      'teaching-only': 0,
    });
  });

  it('rejects malformed JSON', () => {
    expect(() => parseMarkdownDoctestSkipCounts('{"setup":', sourcePath)).toThrow(
      `${sourcePath} must contain valid JSON`,
    );
  });

  it('rejects non-object JSON values', () => {
    for (const contents of ['[]', 'null', '"setup"', '42']) {
      expect(() => parseMarkdownDoctestSkipCounts(contents, sourcePath)).toThrow(
        `${sourcePath} must contain a JSON object`,
      );
    }
  });

  it('rejects non-numeric counts', () => {
    expect(() => parseMarkdownDoctestSkipCounts('{"setup": "2"}', sourcePath)).toThrow(
      `${sourcePath} value for "setup" must be a non-negative integer`,
    );
  });

  it('rejects negative counts', () => {
    expect(() => parseMarkdownDoctestSkipCounts('{"setup": -1}', sourcePath)).toThrow(
      `${sourcePath} value for "setup" must be a non-negative integer`,
    );
  });

  it('rejects non-integer counts', () => {
    expect(() => parseMarkdownDoctestSkipCounts('{"setup": 1.5}', sourcePath)).toThrow(
      `${sourcePath} value for "setup" must be a non-negative integer`,
    );
  });
});
