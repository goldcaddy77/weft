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
 * Non-cryptographic 64-bit hash returning a 16-character hex string.
 *
 * Uses FNV-1a implemented via two chained 32-bit halves to avoid BigInt
 * (which is slow in some runtimes). The output is runtime-stable — Bun and
 * Node produce identical hashes for the same input, which is critical for
 * data that may be persisted and read across runtimes (event-log chain
 * hashes, tool-effect dedup keys, prompt-cache keys).
 */
function fnv1a64(data: Uint8Array): string {
  let h0 = 0x811c9dc5; // lower 32 bits of FNV offset basis
  let h1 = 0xcbf29ce4; // upper 32 bits

  const FNV_PRIME_LOW = 0x01000193;

  for (let i = 0; i < data.length; i++) {
    h0 ^= data[i]!;
    const prevH0 = h0 >>> 0;
    const product = Math.imul(h0, FNV_PRIME_LOW);
    // Carry: unsigned multiplication wrapped if product < the pre-multiply value.
    const carry = product >>> 0 < prevH0 ? 1 : 0;
    h1 = (Math.imul(h1, FNV_PRIME_LOW) + carry) | 0;
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
 * Uses FNV-1a unconditionally across all runtimes for stable output.
 * Hashes may be persisted to durable storage (event-log chains, tool-effect
 * dedup), so runtime-specific algorithms would break cross-runtime reads.
 */
export function hashBytes(data: Uint8Array): string {
  return fnv1a64(data);
}

/**
 * Hash a string to a 16-character hex string.
 *
 * Uses FNV-1a unconditionally across all runtimes for stable output.
 */
export function hashString(data: string): string {
  return fnv1a64(textEncoder.encode(data));
}

// ---------------------------------------------------------------------------
// Node built-in module loader — ESM-safe via process.getBuiltinModule
// ---------------------------------------------------------------------------

type ProcessWithBuiltinModule = NodeJS.Process & {
  getBuiltinModule?: (id: string) => unknown;
};

/**
 * Load a Node.js built-in module without using `require()`.
 *
 * This package is ESM (`"type": "module"` in package.json), so `require`
 * is not defined in Node runtime. `process.getBuiltinModule` (Node 22.5+)
 * is the correct way to load Node built-ins from ESM code without needing
 * `createRequire`. Returns `undefined` in non-Node runtimes.
 */
function loadNodeBuiltin<T>(id: string): T | undefined {
  const nodeProcess = globalThis.process as ProcessWithBuiltinModule | undefined;
  const getBuiltinModule = nodeProcess?.getBuiltinModule;
  if (typeof getBuiltinModule !== 'function') {
    return undefined;
  }
  return getBuiltinModule(id) as T;
}

// ---------------------------------------------------------------------------
// File size
// ---------------------------------------------------------------------------

/**
 * Return the byte size of a file at the given path.
 *
 * - Bun: `Bun.file(path).size`
 * - Node 22.5+: `node:fs` `statSync` loaded via `process.getBuiltinModule`
 * - Missing files return `0` to match Bun's behavior (important for WAL
 *   probing in the diagnostics module).
 *
 * Not available in browser/edge runtimes — throws if called there.
 */
export function fileSize(path: string): number {
  if (IS_BUN) {
    return Bun.file(path).size;
  }

  const fs = loadNodeBuiltin<typeof import('node:fs')>('node:fs');
  if (!fs) {
    throw new Error(
      'fileSize() requires Bun or Node 22.5+ (process.getBuiltinModule). ' +
        'Not available in browser or edge runtimes.',
    );
  }

  try {
    return fs.statSync(path).size;
  } catch (error) {
    // Match Bun.file().size behavior: return 0 for missing files.
    if (
      typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      (error as { code: unknown }).code === 'ENOENT'
    ) {
      return 0;
    }
    throw error;
  }
}

// ---------------------------------------------------------------------------
// Compression — synchronous gzip
// ---------------------------------------------------------------------------

function loadNodeZlib(): typeof import('node:zlib') {
  const zlib = loadNodeBuiltin<typeof import('node:zlib')>('node:zlib');
  if (!zlib) {
    throw new Error(
      'gzip/gunzip require Bun or Node 22.5+ (process.getBuiltinModule). ' +
        'Not available in browser or edge runtimes — use CompressionStream directly.',
    );
  }
  return zlib;
}

/**
 * Gzip-compress a byte buffer synchronously.
 *
 * - Bun: `Bun.gzipSync`
 * - Node 22.5+: `node:zlib` via `process.getBuiltinModule`
 */
export function gzipSync(data: Uint8Array): Uint8Array {
  if (IS_BUN) {
    return new Uint8Array(Bun.gzipSync(new Uint8Array(data)));
  }
  return new Uint8Array(loadNodeZlib().gzipSync(data));
}

/**
 * Gunzip-decompress a byte buffer synchronously.
 *
 * - Bun: `Bun.gunzipSync`
 * - Node 22.5+: `node:zlib` via `process.getBuiltinModule`
 */
export function gunzipSync(data: Uint8Array): Uint8Array {
  if (IS_BUN) {
    return new Uint8Array(Bun.gunzipSync(new Uint8Array(data)));
  }
  return new Uint8Array(loadNodeZlib().gunzipSync(data));
}

/**
 * Load `node:zlib` if available for Node-side callers (used by compression.ts
 * for brotli). Returns `undefined` in browsers so they can degrade cleanly.
 * @internal
 */
export function tryLoadNodeZlib(): typeof import('node:zlib') | undefined {
  return loadNodeBuiltin<typeof import('node:zlib')>('node:zlib');
}
