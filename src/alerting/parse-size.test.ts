import { describe, expect, it } from 'bun:test';
import { parseSize } from './parse-size';

describe('parseSize', () => {
  it('parses gigabytes', () => {
    expect(parseSize('8 GB')).toBe(8 * 1024 ** 3);
  });

  it('parses megabytes', () => {
    expect(parseSize('500 MB')).toBe(500 * 1024 ** 2);
  });

  it('parses terabytes', () => {
    expect(parseSize('1 TB')).toBe(1024 ** 4);
  });

  it('parses kilobytes', () => {
    expect(parseSize('100 KB')).toBe(100 * 1024);
  });

  it('parses bytes', () => {
    expect(parseSize('1024 B')).toBe(1024);
  });

  it('is case-insensitive', () => {
    expect(parseSize('8 gb')).toBe(8 * 1024 ** 3);
    expect(parseSize('8 Gb')).toBe(8 * 1024 ** 3);
  });

  it('handles decimal values', () => {
    expect(parseSize('1.5 GB')).toBe(Math.floor(1.5 * 1024 ** 3));
  });

  it('handles whitespace', () => {
    expect(parseSize('  8 GB  ')).toBe(8 * 1024 ** 3);
  });

  it('throws on invalid input', () => {
    expect(() => parseSize('invalid')).toThrow('Invalid size string');
  });

  it('throws on empty string', () => {
    expect(() => parseSize('')).toThrow('Invalid size string');
  });

  it('throws on unknown unit', () => {
    expect(() => parseSize('8 XB')).toThrow('Invalid size string');
  });
});
