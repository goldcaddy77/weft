/**
 * Prompt prefix cache using a radix (prefix) trie.
 *
 * LLM providers (Anthropic, OpenAI) support prompt caching: when the request
 * shares a prefix with a recent request, the provider reuses its internal
 * KV-cached activations, cutting both latency and cost by 45–60% on repeated
 * patterns.
 *
 * This module identifies the *stable prefix* of a message array — the system
 * prompt, tool definitions, and any fixed early messages — and annotates the
 * last message of that prefix with an Anthropic `cache_control: ephemeral`
 * marker so the provider knows to cache up to that point.
 *
 * The trie is keyed by per-message SHA-256 content hashes. Two arrays share a
 * prefix when their first N messages hash identically. A hit requires at least
 * two matching messages (a single-message prefix is too short to be worth
 * caching).
 *
 * @see arXiv 2603.16104 ("Helium") for the research motivation.
 *
 * @module ai/prompt-cache
 */

import type { MetricsCollector } from '../observability/metrics';
import type { Message } from './providers/types';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Anthropic provider metadata that marks a cache boundary. */
export interface AnthropicCacheControl {
  cacheControl: { type: 'ephemeral' };
}

/** Provider metadata envelope carried on annotated messages. */
export interface PromptCacheProviderMetadata {
  anthropic?: AnthropicCacheControl;
}

/**
 * A `Message` with an optional `providerMetadata` field added by
 * {@link PromptCache.annotate}. The extra field is transparent to callers
 * that do not inspect it, and is read by Anthropic-aware provider adapters
 * to attach `cache_control` to the corresponding API request content block.
 */
export type AnnotatedMessage = Message & {
  providerMetadata?: PromptCacheProviderMetadata;
};

/** Returned by {@link PromptCache.annotate}. */
export interface AnnotateResult {
  /** The message array with cache_control markers on the prefix boundary. */
  messages: AnnotatedMessage[];
  /** True when a prefix of ≥2 messages was found in the trie. */
  hit: boolean;
}

// ---------------------------------------------------------------------------
// Metric names
// ---------------------------------------------------------------------------

/** Counter name for prompt cache hits. */
export const PROMPT_CACHE_HIT_METRIC = 'weft.prompt_cache.hits';
/** Counter name for prompt cache misses. */
export const PROMPT_CACHE_MISS_METRIC = 'weft.prompt_cache.misses';

// ---------------------------------------------------------------------------
// Radix trie internals
// ---------------------------------------------------------------------------

/**
 * A single node in the prefix trie. Each node represents one message in the
 * prefix sequence, keyed by that message's content hash.
 *
 * @internal
 */
interface TrieNode {
  /** Child nodes indexed by the next message's content hash. */
  children: Map<string, TrieNode>;
  /**
   * True when this node is the endpoint of at least one stored sequence.
   * Only endpoints carry the cache_control annotation boundary.
   */
  isTerminal: boolean;
  /**
   * Insertion-order sequence number, used to evict the oldest terminal when
   * the cache exceeds `maxEntries`.
   */
  sequence: number;
}

/**
 * Hash the content-relevant fields of a single message to a compact key.
 *
 * Uses `Bun.hash` (wyhash) — fast and good enough for a cache key. Two
 * messages with identical role + content + tool data produce identical keys.
 *
 * @internal
 */
function hashMessage(message: Message): string {
  const payload = JSON.stringify({
    role: message.role,
    content: message.content,
    toolCalls: message.toolCalls,
    toolResults: message.toolResults,
    name: message.name,
  });
  // Bun.hash returns a bigint; convert to a fixed-width hex string.
  return Bun.hash(payload).toString(16).padStart(16, '0');
}

// ---------------------------------------------------------------------------
// PromptCache
// ---------------------------------------------------------------------------

/**
 * Templated radix trie for LLM prompt prefix sharing.
 *
 * @example Basic usage
 * ```ts
 * const cache = new PromptCache();
 * const { messages, hit } = cache.annotate(conversationMessages);
 * // Pass `messages` to the provider — the last prefix message carries the
 * // cache_control marker when `hit` is true.
 * ```
 */
export class PromptCache {
  readonly #maxEntries: number;
  readonly #root: TrieNode;
  readonly #metrics: MetricsCollector | undefined;
  #hits: number = 0;
  #misses: number = 0;
  #size: number = 0;
  #sequence: number = 0;

  constructor(options?: { maxEntries?: number; metrics?: MetricsCollector }) {
    this.#maxEntries = Math.max(1, options?.maxEntries ?? 1000);
    this.#metrics = options?.metrics;
    this.#root = { children: new Map(), isTerminal: false, sequence: 0 };
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  /**
   * Annotate a message array with cache_control markers.
   *
   * Walks the trie to find the longest matching prefix. If the longest match
   * covers ≥2 messages, it is a hit: the last message of the prefix receives
   * an Anthropic `cache_control: { type: 'ephemeral' }` marker. The full
   * sequence is then inserted into the trie so future calls can match it.
   *
   * Returns `{ messages, hit }`. The returned array is a shallow copy — the
   * annotated boundary message is replaced with a new object; all other
   * messages are the original references.
   */
  annotate(messages: Message[]): AnnotateResult {
    if (messages.length === 0) {
      this.#recordMiss();
      return { messages: messages as AnnotatedMessage[], hit: false };
    }

    const hashes = messages.map(hashMessage);
    const prefixLength = this.#longestMatchingPrefix(hashes);

    // A prefix of 1 message is too short to be semantically useful as a cache
    // boundary (the provider overhead outweighs the benefit). Require ≥2.
    const hit = prefixLength >= 2;

    if (hit) {
      this.#recordHit();
    } else {
      this.#recordMiss();
    }

    // Insert the full sequence into the trie regardless of hit/miss so future
    // calls with the same prefix will hit.
    this.#insert(hashes);

    if (!hit) {
      return { messages: messages as AnnotatedMessage[], hit: false };
    }

    // Shallow-copy the array and replace the boundary message.
    const annotated: AnnotatedMessage[] = messages.map((m, index) => {
      if (index === prefixLength - 1) {
        return {
          ...m,
          providerMetadata: {
            anthropic: { cacheControl: { type: 'ephemeral' } },
          },
        };
      }
      return m as AnnotatedMessage;
    });

    return { messages: annotated, hit: true };
  }

  /** Total cache hits since construction. */
  get hits(): number {
    return this.#hits;
  }

  /** Total cache misses since construction. */
  get misses(): number {
    return this.#misses;
  }

  /** Number of distinct sequences stored in the trie. */
  get size(): number {
    return this.#size;
  }

  // ---------------------------------------------------------------------------
  // Trie operations
  // ---------------------------------------------------------------------------

  /**
   * Walk the trie and return the length of the longest matching prefix.
   * Returns 0 if no messages match at all.
   *
   * Any existing node was created by a prior insert, so the walk depth is the
   * correct hit boundary — the terminal flag exists only for eviction ordering,
   * not for hit detection.
   *
   * @internal
   */
  #longestMatchingPrefix(hashes: string[]): number {
    let node = this.#root;
    let depth = 0;

    for (const hash of hashes) {
      const child = node.children.get(hash);
      if (!child) break;
      node = child;
      depth++;
    }

    return depth;
  }

  /**
   * Insert a hash sequence into the trie, marking the last node as a
   * terminal. Evicts the oldest terminal if the size cap is exceeded.
   *
   * @internal
   */
  #insert(hashes: string[]): void {
    // Walk/create nodes for the full sequence.
    let node = this.#root;
    const path: string[] = [];

    for (const hash of hashes) {
      let child = node.children.get(hash);
      if (!child) {
        child = {
          children: new Map(),
          isTerminal: false,
          sequence: 0,
        };
        node.children.set(hash, child);
      }
      path.push(hash);
      node = child;
    }

    // If this path is already a terminal, nothing to do.
    if (node.isTerminal) return;

    // Mark as a new terminal and record the insertion sequence.
    node.isTerminal = true;
    node.sequence = ++this.#sequence;
    this.#size++;

    // Evict the oldest terminal if we exceed the cap.
    if (this.#size > this.#maxEntries) {
      this.#evictOldest();
    }
  }

  /**
   * Find and remove the terminal with the smallest sequence number.
   *
   * We do a DFS of all terminal nodes, pick the one with the lowest sequence,
   * then clear its terminal flag. If the node has no children after clearing
   * it, it can be pruned — but we do a lazy prune (only the terminal flag is
   * cleared here; orphaned non-terminal leaf nodes are harmless and low in
   * number since this only fires at the cap).
   *
   * @internal
   */
  #evictOldest(): void {
    let oldestNode: TrieNode | null = null;
    let oldestParent: TrieNode | null = null;
    let oldestHash = '';

    // DFS to find the terminal with the minimum sequence number.
    const stack: Array<{ node: TrieNode; parent: TrieNode | null; hash: string }> = [
      { node: this.#root, parent: null, hash: '' },
    ];

    while (stack.length > 0) {
      const entry = stack.pop();
      if (!entry) break;
      const { node, parent, hash } = entry;

      if (node.isTerminal) {
        if (oldestNode === null || node.sequence < oldestNode.sequence) {
          oldestNode = node;
          oldestParent = parent;
          oldestHash = hash;
        }
      }

      for (const [childHash, child] of node.children) {
        stack.push({ node: child, parent: node, hash: childHash });
      }
    }

    if (oldestNode !== null) {
      oldestNode.isTerminal = false;
      this.#size--;

      // Prune the leaf node if it has no children to avoid accumulating dead
      // nodes over time.
      if (oldestNode.children.size === 0 && oldestParent !== null) {
        oldestParent.children.delete(oldestHash);
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Metrics helpers
  // ---------------------------------------------------------------------------

  #recordHit(): void {
    this.#hits++;
    this.#metrics?.increment(PROMPT_CACHE_HIT_METRIC);
  }

  #recordMiss(): void {
    this.#misses++;
    this.#metrics?.increment(PROMPT_CACHE_MISS_METRIC);
  }
}
