/**
 * Payload compression utilities for transparent gzip/brotli compression
 * at the storage layer. Uses a 1-byte header prefix for format detection,
 * enabling cross-algorithm reads and backward compatibility with
 * pre-compression data.
 *
 * @module core/compression
 */

import { brotliCompressSync, brotliDecompressSync } from 'node:zlib';

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
  decompress(data: Uint8Array): Uint8Array | Promise<Uint8Array>;
  readonly algorithm: CompressionAlgorithm;
};

// ---------------------------------------------------------------------------
// Header byte constants
// ---------------------------------------------------------------------------

/** Header byte indicating the payload is stored uncompressed. */
const HEADER_UNCOMPRESSED = 0x00;

/** Header byte indicating the payload is gzip-compressed. */
const HEADER_GZIP = 0x01;

/** Header byte indicating the payload is brotli-compressed. */
const HEADER_BROTLI = 0x02;

/** Set of recognized header bytes for format detection. */
const KNOWN_HEADERS = new Set([HEADER_UNCOMPRESSED, HEADER_GZIP, HEADER_BROTLI]);

// ---------------------------------------------------------------------------
// Compressor factory
// ---------------------------------------------------------------------------

/**
 * Create a compressor backed by Bun's native gzip or Node's brotli.
 *
 * - `gzip`: uses `Bun.gzipSync` / `Bun.gunzipSync`
 * - `brotli`: uses `node:zlib` `brotliCompressSync` / `brotliDecompressSync`
 * - `none`: pass-through (no compression)
 */
export function createBunCompressor(algorithm: CompressionAlgorithm): Compressor {
  switch (algorithm) {
    case 'gzip':
      return {
        algorithm: 'gzip',
        compress(data: Uint8Array): Uint8Array {
          return new Uint8Array(Bun.gzipSync(new Uint8Array(data)));
        },
        decompress(data: Uint8Array): Uint8Array {
          return new Uint8Array(Bun.gunzipSync(new Uint8Array(data)));
        },
      };

    case 'brotli':
      return {
        algorithm: 'brotli',
        compress(data: Uint8Array): Uint8Array {
          return new Uint8Array(brotliCompressSync(data));
        },
        decompress(data: Uint8Array): Uint8Array {
          return new Uint8Array(brotliDecompressSync(data));
        },
      };

    case 'none':
      return {
        algorithm: 'none',
        compress(data: Uint8Array): Uint8Array {
          return data;
        },
        decompress(data: Uint8Array): Uint8Array {
          return data;
        },
      };
  }
}

// ---------------------------------------------------------------------------
// Compress / decompress with header framing
// ---------------------------------------------------------------------------

/**
 * Compress a payload, prepending a 1-byte header that identifies the format.
 *
 * If the data is below the threshold or the algorithm is `'none'`, the payload
 * is stored with a `0x00` (uncompressed) header and no compression is applied.
 */
export async function compressPayload(
  data: Uint8Array,
  compressor: Compressor,
  threshold: number,
): Promise<Uint8Array> {
  if (data.length < threshold || compressor.algorithm === 'none') {
    const result = new Uint8Array(data.length + 1);
    result[0] = HEADER_UNCOMPRESSED;
    result.set(data, 1);
    return result;
  }

  const compressed = await compressor.compress(data);
  const headerByte = compressor.algorithm === 'gzip' ? HEADER_GZIP : HEADER_BROTLI;

  const result = new Uint8Array(compressed.length + 1);
  result[0] = headerByte;
  result.set(compressed, 1);
  return result;
}

/**
 * Decompress a payload by reading the 1-byte header to determine format.
 *
 * - `0x00` → uncompressed, return the rest as-is
 * - `0x01` → gzip-compressed, decompress with `Bun.gunzipSync`
 * - `0x02` → brotli-compressed, decompress with `brotliDecompressSync`
 * - Any other first byte → legacy data without header, return as-is
 *   (backward compatible with pre-compression storage)
 */
export async function decompressPayload(data: Uint8Array): Promise<Uint8Array> {
  if (data.length === 0) {
    return data;
  }

  // Safe: we've already returned early when data.length === 0 above.
  const header = data[0]!;

  if (!KNOWN_HEADERS.has(header)) {
    // Legacy data without a compression header — return unchanged.
    return data;
  }

  const body = data.slice(1);

  switch (header) {
    case HEADER_UNCOMPRESSED:
      return body;

    case HEADER_GZIP:
      return new Uint8Array(Bun.gunzipSync(new Uint8Array(body)));

    case HEADER_BROTLI:
      return new Uint8Array(brotliDecompressSync(body));

    default:
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
