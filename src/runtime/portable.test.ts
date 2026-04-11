import { describe, expect, it } from 'bun:test';

import {
  detectRuntime,
  fileSize,
  gunzipSync,
  gzipSync,
  hashBytes,
  hashString,
  sleep,
} from './portable.ts';

describe('portable runtime helpers', () => {
  describe('detectRuntime', () => {
    it('returns bun when running under Bun', () => {
      expect(detectRuntime()).toBe('bun');
    });
  });

  describe('sleep', () => {
    it('resolves after approximately the requested duration', async () => {
      const start = performance.now();
      await sleep(50);
      const elapsed = performance.now() - start;
      expect(elapsed).toBeGreaterThanOrEqual(40);
      expect(elapsed).toBeLessThan(200);
    });
  });

  describe('hashBytes', () => {
    it('returns a 16-character hex string', () => {
      const data = new Uint8Array([1, 2, 3, 4]);
      const result = hashBytes(data);
      expect(result).toHaveLength(16);
      expect(result).toMatch(/^[0-9a-f]{16}$/);
    });

    it('returns consistent results for the same input', () => {
      const data = new Uint8Array([10, 20, 30]);
      expect(hashBytes(data)).toBe(hashBytes(data));
    });

    it('returns different results for different inputs', () => {
      const a = new Uint8Array([1, 2, 3]);
      const b = new Uint8Array([4, 5, 6]);
      expect(hashBytes(a)).not.toBe(hashBytes(b));
    });

    it('handles empty input', () => {
      const result = hashBytes(new Uint8Array(0));
      expect(result).toHaveLength(16);
      expect(result).toMatch(/^[0-9a-f]{16}$/);
    });

    it('produces stable known values matching FNV-1a 64-bit reference', () => {
      // Pinned values from reference FNV-1a 64-bit implementation.
      expect(hashBytes(new Uint8Array([1, 2, 3, 4]))).toBe('be7a5e775165785d');
      // The empty input produces the FNV offset basis.
      expect(hashBytes(new Uint8Array(0))).toBe('cbf29ce484222325');
    });
  });

  describe('hashString', () => {
    it('returns a 16-character hex string', () => {
      const result = hashString('hello world');
      expect(result).toHaveLength(16);
      expect(result).toMatch(/^[0-9a-f]{16}$/);
    });

    it('returns consistent results for the same input', () => {
      expect(hashString('test')).toBe(hashString('test'));
    });

    it('returns different results for different inputs', () => {
      expect(hashString('foo')).not.toBe(hashString('bar'));
    });

    it('handles empty string', () => {
      const result = hashString('');
      expect(result).toHaveLength(16);
      expect(result).toMatch(/^[0-9a-f]{16}$/);
    });

    it('produces stable known values matching FNV-1a 64-bit reference', () => {
      expect(hashString('hello world')).toBe('779a65e7023cd2e7');
      // Empty input produces the FNV-1a 64-bit offset basis.
      expect(hashString('')).toBe('cbf29ce484222325');
      // Additional reference values from canonical FNV-1a 64-bit test vectors.
      expect(hashString('a')).toBe('af63dc4c8601ec8c');
      expect(hashString('foobar')).toBe('85944171f73967e8');
    });
  });

  describe('fileSize', () => {
    it('returns the byte size of an existing file', () => {
      // Use this test file itself — it definitely exists.
      const size = fileSize(import.meta.path);
      expect(size).toBeGreaterThan(0);
    });

    it('returns 0 for a non-existent file under Bun', () => {
      // Bun.file().size returns 0 for missing files rather than throwing.
      const size = fileSize('/tmp/__does_not_exist_weft_test__');
      expect(size).toBe(0);
    });
  });

  describe('gzipSync / gunzipSync', () => {
    it('round-trips data correctly', () => {
      const original = new TextEncoder().encode('hello, compressed world!');
      const compressed = gzipSync(original);
      const decompressed = gunzipSync(compressed);
      expect(decompressed).toEqual(original);
    });

    it('produces output smaller than input for compressible data', () => {
      const data = new TextEncoder().encode('a'.repeat(1000));
      const compressed = gzipSync(data);
      expect(compressed.length).toBeLessThan(data.length);
    });

    it('handles empty input', () => {
      const empty = new Uint8Array(0);
      const compressed = gzipSync(empty);
      const decompressed = gunzipSync(compressed);
      expect(decompressed).toEqual(empty);
    });
  });
});
