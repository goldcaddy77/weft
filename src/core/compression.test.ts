import { describe, expect, it } from 'bun:test';

import {
  compressPayload,
  createBunCompressor,
  decompressPayload,
  resolveCompressionOptions,
} from './compression';

// ---------------------------------------------------------------------------
// resolveCompressionOptions
// ---------------------------------------------------------------------------

describe('resolveCompressionOptions', () => {
  it('applies defaults when called with no arguments', () => {
    const resolved = resolveCompressionOptions();
    expect(resolved).toEqual({ threshold: 4096, algorithm: 'gzip' });
  });

  it('applies defaults when called with an empty object', () => {
    const resolved = resolveCompressionOptions({});
    expect(resolved).toEqual({ threshold: 4096, algorithm: 'gzip' });
  });

  it('respects a custom threshold', () => {
    const resolved = resolveCompressionOptions({ threshold: 1024 });
    expect(resolved.threshold).toBe(1024);
    expect(resolved.algorithm).toBe('gzip');
  });

  it('respects a custom algorithm', () => {
    const resolved = resolveCompressionOptions({ algorithm: 'brotli' });
    expect(resolved.algorithm).toBe('brotli');
    expect(resolved.threshold).toBe(4096);
  });
});

// ---------------------------------------------------------------------------
// Round-trip: gzip
// ---------------------------------------------------------------------------

describe('gzip round-trip', () => {
  const compressor = createBunCompressor('gzip');

  it('round-trips data above the threshold', async () => {
    const original = new Uint8Array(8192).fill(42);
    const compressed = await compressPayload(original, compressor, 4096);
    const decompressed = await decompressPayload(compressed);
    expect(decompressed).toEqual(original);
  });

  it('round-trips data below the threshold (stored uncompressed)', async () => {
    const original = new Uint8Array(100).fill(7);
    const compressed = await compressPayload(original, compressor, 4096);
    const decompressed = await decompressPayload(compressed);
    expect(decompressed).toEqual(original);
  });
});

// ---------------------------------------------------------------------------
// Round-trip: brotli
// ---------------------------------------------------------------------------

describe('brotli round-trip', () => {
  const compressor = createBunCompressor('brotli');

  it('round-trips data above the threshold', async () => {
    const original = new Uint8Array(8192).fill(99);
    const compressed = await compressPayload(original, compressor, 4096);
    const decompressed = await decompressPayload(compressed);
    expect(decompressed).toEqual(original);
  });

  it('round-trips data below the threshold (stored uncompressed)', async () => {
    const original = new Uint8Array(100).fill(13);
    const compressed = await compressPayload(original, compressor, 4096);
    const decompressed = await decompressPayload(compressed);
    expect(decompressed).toEqual(original);
  });
});

// ---------------------------------------------------------------------------
// Round-trip: none
// ---------------------------------------------------------------------------

describe('none round-trip', () => {
  const compressor = createBunCompressor('none');

  it('round-trips data with magic + uncompressed header regardless of size', async () => {
    const original = new Uint8Array(8192).fill(55);
    const compressed = await compressPayload(original, compressor, 4096);
    expect(compressed[0]).toBe(0xc1);
    expect(compressed[1]).toBe(0x00);
    expect(compressed.length).toBe(original.length + 2);

    const decompressed = await decompressPayload(compressed);
    expect(decompressed).toEqual(original);
  });
});

// ---------------------------------------------------------------------------
// Threshold boundary behavior
// ---------------------------------------------------------------------------

describe('threshold boundary', () => {
  const compressor = createBunCompressor('gzip');

  it('does not compress data below the threshold', async () => {
    const data = new Uint8Array(4095).fill(1);
    const compressed = await compressPayload(data, compressor, 4096);
    expect(compressed[0]).toBe(0xc1);
    expect(compressed[1]).toBe(0x00);
    // Uncompressed: 2-byte header + original data
    expect(compressed.length).toBe(data.length + 2);
  });

  it('compresses data at exactly the threshold', async () => {
    const data = new Uint8Array(4096).fill(1);
    const compressed = await compressPayload(data, compressor, 4096);
    expect(compressed[0]).toBe(0xc1);
    expect(compressed[1]).toBe(0x01);
    // Repetitive data should compress significantly
    expect(compressed.length).toBeLessThan(data.length);
  });

  it('compresses data above the threshold', async () => {
    const data = new Uint8Array(8192).fill(1);
    const compressed = await compressPayload(data, compressor, 4096);
    expect(compressed[0]).toBe(0xc1);
    expect(compressed[1]).toBe(0x01);
    expect(compressed.length).toBeLessThan(data.length);
  });
});

// ---------------------------------------------------------------------------
// Cross-algorithm reads
// ---------------------------------------------------------------------------

describe('cross-algorithm reads', () => {
  it('reads gzip-compressed data even when current algorithm is brotli', async () => {
    const gzipCompressor = createBunCompressor('gzip');
    const original = new Uint8Array(8192).fill(77);
    const compressed = await compressPayload(original, gzipCompressor, 4096);
    expect(compressed[0]).toBe(0xc1);
    expect(compressed[1]).toBe(0x01); // gzip algorithm byte

    // decompressPayload uses the header bytes, not a configured algorithm
    const decompressed = await decompressPayload(compressed);
    expect(decompressed).toEqual(original);
  });

  it('reads brotli-compressed data even when current algorithm is gzip', async () => {
    const brotliCompressor = createBunCompressor('brotli');
    const original = new Uint8Array(8192).fill(33);
    const compressed = await compressPayload(original, brotliCompressor, 4096);
    expect(compressed[0]).toBe(0xc1);
    expect(compressed[1]).toBe(0x02); // brotli algorithm byte

    const decompressed = await decompressPayload(compressed);
    expect(decompressed).toEqual(original);
  });
});

// ---------------------------------------------------------------------------
// Legacy data (no header)
// ---------------------------------------------------------------------------

describe('legacy data without header', () => {
  it('passes through raw msgpack data starting with 0x80+', async () => {
    // msgpack fixmap starts at 0x80 — not the magic byte
    const legacy = new Uint8Array([0x80, 0xa1, 0x61, 0x01]);
    const result = await decompressPayload(legacy);
    expect(result).toEqual(legacy);
  });

  it('passes through data with arbitrary unrecognized first byte', async () => {
    const legacy = new Uint8Array([0xff, 0xab, 0xcd]);
    const result = await decompressPayload(legacy);
    expect(result).toEqual(legacy);
  });

  it('passes through msgpack-encoded bare integer 0 (0x00) without corruption', async () => {
    // msgpack encodes integer 0 as a single byte 0x00.
    // With the old 1-byte header scheme, this would collide with the
    // "uncompressed" header and strip the data byte. The 0xC1 magic
    // byte prefix eliminates this collision.
    const legacyZero = new Uint8Array([0x00]);
    const result = await decompressPayload(legacyZero);
    expect(result).toEqual(legacyZero);
  });

  it('passes through msgpack-encoded bare integer 1 (0x01) without corruption', async () => {
    const legacyOne = new Uint8Array([0x01]);
    const result = await decompressPayload(legacyOne);
    expect(result).toEqual(legacyOne);
  });

  it('passes through msgpack-encoded bare integer 2 (0x02) without corruption', async () => {
    const legacyTwo = new Uint8Array([0x02]);
    const result = await decompressPayload(legacyTwo);
    expect(result).toEqual(legacyTwo);
  });
});

// ---------------------------------------------------------------------------
// Empty data
// ---------------------------------------------------------------------------

describe('empty data', () => {
  it('round-trips an empty Uint8Array', async () => {
    const compressor = createBunCompressor('gzip');
    const original = new Uint8Array(0);
    const compressed = await compressPayload(original, compressor, 4096);
    // Below threshold → magic + uncompressed header
    expect(compressed[0]).toBe(0xc1);
    expect(compressed[1]).toBe(0x00);
    expect(compressed.length).toBe(2);

    const decompressed = await decompressPayload(compressed);
    expect(decompressed).toEqual(original);
  });

  it('returns empty data as-is when decompressing', async () => {
    const result = await decompressPayload(new Uint8Array(0));
    expect(result.length).toBe(0);
  });

  it('returns single-byte data as-is when decompressing (too short for header)', async () => {
    const result = await decompressPayload(new Uint8Array([0x42]));
    expect(result).toEqual(new Uint8Array([0x42]));
  });
});

// ---------------------------------------------------------------------------
// Large payload actually reduces size
// ---------------------------------------------------------------------------

describe('compression effectiveness', () => {
  it('reduces the size of a large repetitive payload with gzip', async () => {
    const compressor = createBunCompressor('gzip');
    // 100KB of repetitive data
    const original = new Uint8Array(102_400);
    for (let i = 0; i < original.length; i++) {
      original[i] = i % 256;
    }
    const compressed = await compressPayload(original, compressor, 4096);
    expect(compressed.length).toBeLessThan(original.length);
    // Verify it still round-trips
    const decompressed = await decompressPayload(compressed);
    expect(decompressed).toEqual(original);
  });

  it('reduces the size of a large repetitive payload with brotli', async () => {
    const compressor = createBunCompressor('brotli');
    const original = new Uint8Array(102_400);
    for (let i = 0; i < original.length; i++) {
      original[i] = i % 256;
    }
    const compressed = await compressPayload(original, compressor, 4096);
    expect(compressed.length).toBeLessThan(original.length);
    const decompressed = await decompressPayload(compressed);
    expect(decompressed).toEqual(original);
  });
});

// ---------------------------------------------------------------------------
// Header bytes are correct
// ---------------------------------------------------------------------------

describe('header byte values', () => {
  it('always starts with magic byte 0xC1', async () => {
    const compressor = createBunCompressor('gzip');
    const small = new Uint8Array(10).fill(1);
    const result = await compressPayload(small, compressor, 4096);
    expect(result[0]).toBe(0xc1);
  });

  it('uses algorithm byte 0x00 for uncompressed', async () => {
    const compressor = createBunCompressor('gzip');
    const small = new Uint8Array(10).fill(1);
    const result = await compressPayload(small, compressor, 4096);
    expect(result[0]).toBe(0xc1);
    expect(result[1]).toBe(0x00);
  });

  it('uses algorithm byte 0x01 for gzip', async () => {
    const compressor = createBunCompressor('gzip');
    const large = new Uint8Array(8192).fill(1);
    const result = await compressPayload(large, compressor, 4096);
    expect(result[0]).toBe(0xc1);
    expect(result[1]).toBe(0x01);
  });

  it('uses algorithm byte 0x02 for brotli', async () => {
    const compressor = createBunCompressor('brotli');
    const large = new Uint8Array(8192).fill(1);
    const result = await compressPayload(large, compressor, 4096);
    expect(result[0]).toBe(0xc1);
    expect(result[1]).toBe(0x02);
  });
});
