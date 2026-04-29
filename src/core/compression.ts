/**
 * Payload compression utilities for transparent gzip/brotli compression
 * at the storage layer. Uses a 2-byte header (magic byte `0xC1` + algorithm
 * byte) for format detection, enabling cross-algorithm reads and backward
 * compatibility with pre-compression data.
 *
 * @module core/compression
 */

import { gunzipSync, gzipSync, tryLoadNodeZlib } from '../runtime/portable.ts';

// ---------------------------------------------------------------------------
// Brotli — lazy-loaded from node:zlib via the portable runtime layer.
// Available in Bun and Node 22.5+; not available in browsers (throws).
// ---------------------------------------------------------------------------

function getBrotliZlib(): typeof import('node:zlib') {
  const zlib = tryLoadNodeZlib();
  if (!zlib) {
    throw new Error(
      'Brotli compression requires Bun or Node 22.5+ with process.getBuiltinModule support. ' +
        'Use gzip compression for browser/edge runtimes.',
    );
  }
  return zlib;
}

function brotliCompressSync(data: Uint8Array): Uint8Array {
  return new Uint8Array(getBrotliZlib().brotliCompressSync(data));
}

function brotliDecompressSync(data: Uint8Array): Uint8Array {
  return new Uint8Array(getBrotliZlib().brotliDecompressSync(data));
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type CompressionAlgorithm = 'gzip' | 'brotli' | 'none';

export type CompressionOptions = {
  /** Minimum size in bytes before compression kicks in. Default: 4096. */
  threshold?: number;
  /** Algorithm to use. Default: 'gzip'. */
  algorithm?: CompressionAlgorithm;
};

export type Compressor = {
  compress(data: Uint8Array): Uint8Array | Promise<Uint8Array>;
  readonly algorithm: CompressionAlgorithm;
};

// ---------------------------------------------------------------------------
// Header constants
// ---------------------------------------------------------------------------

/**
 * Magic byte that prefixes all compressed-storage payloads. Uses msgpack's
 * reserved `0xC1` byte, which is defined as "never used" in the msgpack
 * specification and will never appear as the first byte of valid msgpack data.
 * This guarantees zero collisions with legacy (pre-compression) data.
 */
const MAGIC_BYTE = 0xc1;

/** Algorithm byte indicating the payload is stored uncompressed (with header). */
const ALGORITHM_UNCOMPRESSED = 0x00;

/** Algorithm byte indicating gzip compression. */
const ALGORITHM_GZIP = 0x01;

/** Algorithm byte indicating brotli compression. */
const ALGORITHM_BROTLI = 0x02;

/** The total header size: magic byte + algorithm byte. */
const HEADER_SIZE = 2;

// ---------------------------------------------------------------------------
// Compressor factory
// ---------------------------------------------------------------------------

/**
 * Create a compressor backed by the portable runtime layer.
 *
 * - `gzip`: uses Bun's native gzip when available, otherwise `node:zlib`
 * - `brotli`: uses `node:zlib` brotli (available in both Bun and Node)
 * - `none`: pass-through (no compression)
 *
 * @example
 * ```ts
 * import { createBunCompressor } from 'weft';
 *
 * const compressor = createBunCompressor('gzip');
 * const data = new TextEncoder().encode('hello world'.repeat(100));
 * const compressed = await compressor.compress(data);
 * console.log(compressed.byteLength < data.byteLength); // true
 * ```
 */
export function createBunCompressor(algorithm: CompressionAlgorithm): Compressor {
  return createCompressor(algorithm);
}

/**
 * Create a compressor. Preferred portable factory — delegates to the runtime
 * abstraction layer for gzip and brotli implementations.
 *
 * @example
 * ```ts
 * import { createCompressor } from 'weft';
 *
 * const gzip = createCompressor('gzip');
 * const brotli = createCompressor('brotli');
 * const none = createCompressor('none');
 *
 * const payload = new TextEncoder().encode('workflow state'.repeat(50));
 * const compressed = gzip.compress(payload);
 * console.log(compressed instanceof Uint8Array); // true
 * ```
 */
export function createCompressor(algorithm: CompressionAlgorithm): Compressor {
  switch (algorithm) {
    case 'gzip':
      return {
        algorithm: 'gzip',
        compress(data: Uint8Array): Uint8Array {
          return gzipSync(data);
        },
      };

    case 'brotli':
      return {
        algorithm: 'brotli',
        compress(data: Uint8Array): Uint8Array {
          return brotliCompressSync(data);
        },
      };

    case 'none':
      return {
        algorithm: 'none',
        compress(data: Uint8Array): Uint8Array {
          return data;
        },
      };
  }
}

// ---------------------------------------------------------------------------
// Compress / decompress with header framing
// ---------------------------------------------------------------------------

/**
 * Compress a payload, prepending a 2-byte header: magic byte (`0xC1`) +
 * algorithm byte. This distinguishes compressed-storage data from legacy
 * (pre-compression) data with zero risk of collision.
 *
 * If the data is below the threshold or the algorithm is `'none'`, the payload
 * is stored with a `[0xC1, 0x00]` header and no compression is applied.
 */
export async function compressPayload(
  data: Uint8Array,
  compressor: Compressor,
  threshold: number,
): Promise<Uint8Array> {
  if (data.length < threshold || compressor.algorithm === 'none') {
    const result = new Uint8Array(data.length + HEADER_SIZE);
    result[0] = MAGIC_BYTE;
    result[1] = ALGORITHM_UNCOMPRESSED;
    result.set(data, HEADER_SIZE);
    return result;
  }

  const compressed = await compressor.compress(data);

  // Fall back to uncompressed framing if compression expanded the data
  // (common with high-entropy payloads like already-compressed images).
  if (compressed.length + HEADER_SIZE >= data.length + HEADER_SIZE) {
    const result = new Uint8Array(data.length + HEADER_SIZE);
    result[0] = MAGIC_BYTE;
    result[1] = ALGORITHM_UNCOMPRESSED;
    result.set(data, HEADER_SIZE);
    return result;
  }

  const algorithmByte = compressor.algorithm === 'gzip' ? ALGORITHM_GZIP : ALGORITHM_BROTLI;

  const result = new Uint8Array(compressed.length + HEADER_SIZE);
  result[0] = MAGIC_BYTE;
  result[1] = algorithmByte;
  result.set(compressed, HEADER_SIZE);
  return result;
}

/**
 * Decompress a payload by reading the 2-byte header (magic + algorithm).
 *
 * - `[0xC1, 0x00]` → uncompressed, return the rest as-is
 * - `[0xC1, 0x01]` → gzip-compressed, decompress
 * - `[0xC1, 0x02]` → brotli-compressed, decompress
 * - Any other first byte → legacy data without header, return as-is
 *   (backward compatible with pre-compression storage)
 */
export async function decompressPayload(data: Uint8Array): Promise<Uint8Array> {
  if (data.length < HEADER_SIZE) {
    // Too short to contain a header — must be legacy data or empty.
    return data;
  }

  if (data[0] !== MAGIC_BYTE) {
    // First byte is not the magic byte — legacy data, return unchanged.
    return data;
  }

  const algorithm = data[1]!;
  const body = data.slice(HEADER_SIZE);

  switch (algorithm) {
    case ALGORITHM_UNCOMPRESSED:
      return body;

    case ALGORITHM_GZIP:
      return gunzipSync(body);

    case ALGORITHM_BROTLI:
      return brotliDecompressSync(body);

    default:
      // Unrecognized algorithm byte after magic — return as-is for safety.
      return data;
  }
}

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

const DEFAULT_THRESHOLD = 4096;
const DEFAULT_ALGORITHM: CompressionAlgorithm = 'gzip';

/** Resolve partial compression options into a fully specified configuration. */
export function resolveCompressionOptions(
  options?: CompressionOptions,
): Required<CompressionOptions> {
  return {
    threshold: options?.threshold ?? DEFAULT_THRESHOLD,
    algorithm: options?.algorithm ?? DEFAULT_ALGORITHM,
  };
}
