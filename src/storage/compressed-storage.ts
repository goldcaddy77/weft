/**
 * Storage decorator that transparently compresses and decompresses payloads.
 * Wraps any {@link Storage} implementation and applies compression above a
 * configurable size threshold.
 *
 * @module storage/compressed-storage
 */

import type { CompressionOptions } from '../core/compression.ts';
import {
  compressPayload,
  createBunCompressor,
  decompressPayload,
  resolveCompressionOptions,
} from '../core/compression.ts';

import type { BatchOperation, ScanOptions, Storage } from './interface.ts';

export class CompressedStorage implements Storage {
  #inner: Storage;
  #compressor;
  #threshold: number;

  constructor(inner: Storage, options?: CompressionOptions) {
    this.#inner = inner;
    const resolved = resolveCompressionOptions(options);
    this.#compressor = createBunCompressor(resolved.algorithm);
    this.#threshold = resolved.threshold;

    // Forward query when the inner storage provides it. Assigned via
    // defineProperty so the property is absent (not undefined) when the
    // inner storage lacks a query method — this satisfies
    // exactOptionalPropertyTypes.
    if (inner.query) {
      const boundQuery = inner.query.bind(inner);
      Object.defineProperty(this, 'query', {
        value: boundQuery,
        enumerable: true,
        configurable: true,
      });
    }
  }

  async get(key: string): Promise<Uint8Array | null> {
    const raw = await this.#inner.get(key);
    if (!raw) return null;
    return decompressPayload(raw);
  }

  async put(key: string, value: Uint8Array): Promise<void> {
    const compressed = await compressPayload(value, this.#compressor, this.#threshold);
    return this.#inner.put(key, compressed);
  }

  async delete(key: string): Promise<void> {
    return this.#inner.delete(key);
  }

  async *scan(prefix: string, options?: ScanOptions): AsyncIterable<[string, Uint8Array]> {
    for await (const [key, value] of this.#inner.scan(prefix, options)) {
      yield [key, await decompressPayload(value)];
    }
  }

  async batch(operations: BatchOperation[]): Promise<void> {
    const compressed = await Promise.all(
      operations.map(async (op) => {
        if (op.type === 'put') {
          return {
            type: 'put' as const,
            key: op.key,
            value: await compressPayload(op.value, this.#compressor, this.#threshold),
          };
        }
        return op;
      }),
    );
    return this.#inner.batch(compressed);
  }

  [Symbol.dispose](): void {
    this.#inner[Symbol.dispose]();
  }
}
