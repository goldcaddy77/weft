/**
 * Storage decorator that transparently compresses and decompresses payloads.
 * Wraps any {@link Storage} implementation and applies compression above a
 * configurable size threshold.
 *
 * Supports agent-aware compression: when a workflow ID belongs to an agent-typed
 * workflow, a different algorithm and threshold can be used (e.g., brotli with
 * lower threshold for conversation-heavy checkpoint data).
 *
 * @module storage/compressed-storage
 */

import type { CompressionAlgorithm, CompressionOptions, Compressor } from '../core/compression.ts';
import {
  compressPayload,
  createBunCompressor,
  decompressPayload,
  resolveCompressionOptions,
} from '../core/compression.ts';

import {
  type BatchOperation,
  type ScanOptions,
  type Storage,
  tryDecodeStorageKeyComponent,
} from './interface.ts';

/**
 * Options for agent-aware compression in {@link CompressedStorage}.
 *
 * @example
 * ```ts
 * import { MemoryStorage } from 'weft';
 * import { CompressedStorage, type AgentCompressionOptions } from 'weft/storage/compressed';
 *
 * const agentOptions: AgentCompressionOptions = {
 *   agentAlgorithm: 'brotli',
 *   agentThreshold: 512,
 * };
 * await using inner = new MemoryStorage();
 * const storage = new CompressedStorage(inner, agentOptions);
 * ```
 */
export type AgentCompressionOptions = {
  /** Returns the set of workflow IDs that are agent-typed. */
  agentWorkflowIds?: () => ReadonlySet<string>;
  /** Compression algorithm for agent workflow checkpoints. Default: same as main algorithm. */
  agentAlgorithm?: CompressionAlgorithm;
  /** Compression threshold for agent workflow checkpoints. Default: same as main threshold. */
  agentThreshold?: number;
};

export class CompressedStorage implements Storage {
  #inner: Storage;
  #compressor: Compressor;
  #threshold: number;
  #agentCompressor: Compressor | null;
  #agentThreshold: number;
  #getAgentWorkflowIds: (() => ReadonlySet<string>) | null;

  constructor(inner: Storage, options?: CompressionOptions & AgentCompressionOptions) {
    this.#inner = inner;
    const resolved = resolveCompressionOptions(options);
    this.#compressor = createBunCompressor(resolved.algorithm);
    this.#threshold = resolved.threshold;

    // Agent-aware compression: create a separate compressor when the caller
    // provides an agent workflow ID source. When `agentAlgorithm` is omitted,
    // falls back to the main algorithm (only the threshold may differ).
    if (options?.agentWorkflowIds) {
      const agentAlg = options.agentAlgorithm ?? resolved.algorithm;
      this.#agentCompressor = createBunCompressor(agentAlg);
      this.#agentThreshold = options.agentThreshold ?? resolved.threshold;
      this.#getAgentWorkflowIds = options.agentWorkflowIds;
    } else {
      this.#agentCompressor = null;
      this.#agentThreshold = resolved.threshold;
      this.#getAgentWorkflowIds = null;
    }

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
    const [compressor, threshold] = this.#selectCompressor(key);
    const compressed = await compressPayload(value, compressor, threshold);
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
          const [compressor, threshold] = this.#selectCompressor(op.key);
          return {
            type: 'put' as const,
            key: op.key,
            value: await compressPayload(op.value, compressor, threshold),
          };
        }
        return op;
      }),
    );
    return this.#inner.batch(compressed);
  }

  /**
   * Select the compressor and threshold for a given storage key. Returns the
   * agent compressor when the key belongs to an agent workflow checkpoint,
   * otherwise returns the default compressor.
   */
  #selectCompressor(key: string): [Compressor, number] {
    if (this.#agentCompressor && this.#getAgentWorkflowIds) {
      const workflowId = extractWorkflowIdFromKey(key);
      if (workflowId && this.#getAgentWorkflowIds().has(workflowId)) {
        return [this.#agentCompressor, this.#agentThreshold];
      }
    }
    return [this.#compressor, this.#threshold];
  }

  [Symbol.dispose](): void {
    this.#inner[Symbol.dispose]();
  }
}

/**
 * Extract the workflow ID from a storage key. Workflow-related keys follow
 * the pattern `wf:{workflowId}` or `wf:{workflowId}:*`. Returns null if the
 * key doesn't match.
 */
function extractWorkflowIdFromKey(key: string): string | null {
  if (!key.startsWith('wf:')) return null;
  const secondColon = key.indexOf(':', 3);
  if (secondColon === -1) {
    // Key is of the form `wf:{workflowId}`
    return tryDecodeStorageKeyComponent(key.slice(3));
  }
  // Key is of the form `wf:{workflowId}:*`
  return tryDecodeStorageKeyComponent(key.slice(3, secondColon));
}
