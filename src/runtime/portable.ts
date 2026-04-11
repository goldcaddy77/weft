/**
 * Runtime-agnostic primitives that all portable code uses instead of calling
 * `Bun.*` directly. When running under Bun the fast native paths are used;
 * otherwise standard Web APIs are preferred, with Node built-ins as a last
 * resort (lazy-imported so browser bundles never pull in `node:*`).
 *
 * @module runtime/portable
 */

// ---------------------------------------------------------------------------
// Runtime detection
// ---------------------------------------------------------------------------

/** Identifies the JavaScript runtime hosting this process. */
export type RuntimeKind = 'bun' | 'node' | 'browser' | 'edge';

const IS_BUN = typeof globalThis.Bun !== 'undefined';

/** Detect the current JavaScript runtime. */
export function detectRuntime(): RuntimeKind {
  if (IS_BUN) return 'bun';
  if (typeof globalThis.process !== 'undefined' && globalThis.process.versions?.node) return 'node';
  if (typeof globalThis.window !== 'undefined' || typeof globalThis.document !== 'undefined')
    return 'browser';
  return 'edge';
}

// ---------------------------------------------------------------------------
// sleep
// ---------------------------------------------------------------------------

/**
 * Pause execution for the given number of milliseconds.
 *
 * Uses `Bun.sleep` when available (microtask-friendly), otherwise wraps
 * `setTimeout` in a `Promise`.
 */
export const sleep: (ms: number) => Promise<void> = IS_BUN
  ? (ms: number) => Bun.sleep(ms)
  : (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// ---------------------------------------------------------------------------
// Hashing — non-cryptographic, cache-key-quality
// ---------------------------------------------------------------------------

/**
 * FNV-1a 64-bit hash returning a 16-character hex string.
 *
 * Used as the non-Bun fallback for `hashBytes` and `hashString`. The output
 * only needs to be a consistent, collision-resistant cache key — it is never
 * used for security purposes.
 */
function fnv1a64(data: Uint8Array): string {
  // FNV-1a with 64-bit offset basis and prime, implemented via two 32-bit
  // halves to avoid BigInt (which is slow in some runtimes).
  let h0 = 0x811c9dc5; // lower 32 bits of FNV offset basis
  let h1 = 0xcbf29ce4; // upper 32 bits

  const FNV_PRIME_LOW = 0x01000193;

  for (let i = 0; i < data.length; i++) {
    h0 ^= data[i]!;
    // Multiply lower half by prime, propagate carry into upper half.
    const product = Math.imul(h0, FNV_PRIME_LOW);
    h1 = (Math.imul(h1, FNV_PRIME_LOW) + (product >>> 0 > h0 >>> 0 ? 1 : 0)) | 0;
    h0 = product;
  }

  const hi = (h1 >>> 0).toString(16).padStart(8, '0');
  const lo = (h0 >>> 0).toString(16).padStart(8, '0');
  return hi + lo;
}

const textEncoder = new TextEncoder();

/**
 * Hash a byte buffer to a 16-character hex string.
 *
 * Bun: `Bun.hash.wyhash`. Fallback: FNV-1a 64-bit.
 */
export const hashBytes: (data: Uint8Array) => string = IS_BUN
  ? (data: Uint8Array) => Bun.hash.wyhash(data).toString(16).padStart(16, '0')
  : (data: Uint8Array) => fnv1a64(data);

/**
 * Hash a string to a 16-character hex string.
 *
 * Bun: `Bun.hash` (wyhash on string input). Fallback: FNV-1a 64-bit via
 * `TextEncoder`.
 */
export const hashString: (data: string) => string = IS_BUN
  ? (data: string) => Bun.hash(data).toString(16).padStart(16, '0')
  : (data: string) => fnv1a64(textEncoder.encode(data));

// ---------------------------------------------------------------------------
// File size
// ---------------------------------------------------------------------------

/**
 * Return the byte size of a file at the given path.
 *
 * Bun: `Bun.file(path).size`. Fallback: lazy `node:fs` `statSync`.
 * Not available in browser/edge runtimes — throws if called there.
 */
export function fileSize(path: string): number {
  if (IS_BUN) {
    return Bun.file(path).size;
  }
  // Lazy import to avoid pulling node:fs into browser bundles.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { statSync } = require('node:fs') as typeof import('node:fs');
  return statSync(path).size;
}

// ---------------------------------------------------------------------------
// Compression — synchronous gzip
// ---------------------------------------------------------------------------

/**
 * Gzip-compress a byte buffer synchronously.
 *
 * Bun: `Bun.gzipSync`. Fallback: lazy `node:zlib` `gzipSync`.
 */
export function gzipSync(data: Uint8Array): Uint8Array {
  if (IS_BUN) {
    return new Uint8Array(Bun.gzipSync(new Uint8Array(data)));
  }
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const zlib = require('node:zlib') as typeof import('node:zlib');
  return new Uint8Array(zlib.gzipSync(data));
}

/**
 * Gunzip-decompress a byte buffer synchronously.
 *
 * Bun: `Bun.gunzipSync`. Fallback: lazy `node:zlib` `gunzipSync`.
 */
export function gunzipSync(data: Uint8Array): Uint8Array {
  if (IS_BUN) {
    return new Uint8Array(Bun.gunzipSync(new Uint8Array(data)));
  }
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const zlib = require('node:zlib') as typeof import('node:zlib');
  return new Uint8Array(zlib.gunzipSync(data));
}

// ---------------------------------------------------------------------------
// Brotli — synchronous, Node-only (not available in browsers)
// ---------------------------------------------------------------------------

/**
 * Brotli-compress a byte buffer synchronously.
 *
 * Uses `node:zlib` (available in both Bun and Node). Not available in
 * browser/edge runtimes — throws if called there.
 */
export function brotliCompressSync(data: Uint8Array): Uint8Array {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const zlib = require('node:zlib') as typeof import('node:zlib');
  return new Uint8Array(zlib.brotliCompressSync(data));
}

/**
 * Brotli-decompress a byte buffer synchronously.
 *
 * Uses `node:zlib` (available in both Bun and Node). Not available in
 * browser/edge runtimes — throws if called there.
 */
export function brotliDecompressSync(data: Uint8Array): Uint8Array {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const zlib = require('node:zlib') as typeof import('node:zlib');
  return new Uint8Array(zlib.brotliDecompressSync(data));
}
