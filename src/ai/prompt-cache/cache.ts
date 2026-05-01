import type { MetricsCollector } from '../../observability/metrics.ts';
import type { Message } from '../providers/types.ts';
import type { TrieNode } from './trie.ts';
import { hashMessage, subtreeContains } from './trie.ts';
import type { AnnotatedMessage, AnnotateResult } from './types.ts';
import { PROMPT_CACHE_HIT_METRIC, PROMPT_CACHE_MISS_METRIC } from './types.ts';

/**
 * Templated radix trie for LLM prompt prefix sharing.
 *
 * The constructor accepts `{ maxEntries?: number; metrics?: MetricsCollector }`.
 * `maxEntries` defaults to 1000 — the oldest terminal entry is evicted when
 * the cap is reached. `metrics`, when provided, increments
 * `PROMPT_CACHE_HIT_METRIC` and `PROMPT_CACHE_MISS_METRIC` on every
 * `annotate()` call.
 *
 * @example Basic usage
 * ```ts
 * import { PromptCache, type Message } from 'weft';
 *
 * const cache = new PromptCache();
 * const conversationMessages: Message[] = [
 *   { role: 'system', content: 'You are helpful.' },
 *   { role: 'user', content: 'Hello!' },
 * ];
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
    this.#root = {
      children: new Map(),
      isTerminal: false,
      hasTerminalDescendant: false,
      sequence: 0,
    };
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
   * Returns `{ messages, hit }`. On a hit, the returned array is a shallow
   * copy — the annotated boundary message is replaced with a new object; all
   * other messages are the original references. On a miss, the original array
   * reference is returned unchanged (no allocation).
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
   * Walk the trie and return the length of the longest prefix of `hashes` that
   * is a prefix of at least one live (non-evicted) stored sequence.
   *
   * A node is "live" when `hasTerminalDescendant` is true — meaning it or one
   * of its descendants is a terminal that has not been evicted. Walking through
   * a live node extends the matching prefix length.
   *
   * An orphaned intermediate node left behind after eviction will have
   * `hasTerminalDescendant === false` (cleared by `#evictOldest`). Reaching
   * such a node stops the walk, preventing false cache hits from orphaned
   * ancestors.
   *
   * @internal
   */
  #longestMatchingPrefix(hashes: string[]): number {
    let node = this.#root;
    let depth = 0;

    for (const hash of hashes) {
      const child = node.children.get(hash);
      if (!child) break;
      // Stop if the child is orphaned (no live terminals in its subtree).
      if (!child.hasTerminalDescendant && !child.isTerminal) break;
      node = child;
      depth++;
    }

    return depth;
  }

  /**
   * Insert a hash sequence into the trie, marking the last node as a
   * terminal and setting `hasTerminalDescendant = true` on all ancestor nodes.
   * Evicts the oldest terminal if the size cap is exceeded.
   *
   * @internal
   */
  #insert(hashes: string[]): void {
    // Walk/create nodes for the full sequence, collecting ancestors.
    let node = this.#root;
    const ancestors: TrieNode[] = [node];

    for (const hash of hashes) {
      let child = node.children.get(hash);
      if (!child) {
        child = {
          children: new Map(),
          isTerminal: false,
          hasTerminalDescendant: false,
          sequence: 0,
        };
        node.children.set(hash, child);
      }
      node = child;
      ancestors.push(node);
    }

    // If this path is already a terminal, refresh its sequence for LRU semantics.
    if (node.isTerminal) {
      node.sequence = ++this.#sequence;
      return;
    }

    // Mark as a new terminal and record the insertion sequence.
    node.isTerminal = true;
    node.hasTerminalDescendant = true;
    node.sequence = ++this.#sequence;
    this.#size++;

    // Propagate hasTerminalDescendant up to all ancestors.
    for (const ancestor of ancestors) {
      ancestor.hasTerminalDescendant = true;
    }

    // Evict the oldest terminal if we exceed the cap.
    if (this.#size > this.#maxEntries) {
      this.#evictOldest();
    }
  }

  /**
   * Find and remove the terminal with the smallest sequence number.
   *
   * Clears `isTerminal` on the evicted node, prunes it from its parent if it
   * has no children, and then recomputes `hasTerminalDescendant` bottom-up on
   * the ancestor path so that `#longestMatchingPrefix` stops walking at the
   * first node that no longer has any live terminals in its subtree.
   *
   * **Performance note.** This is an O(N) DFS over all nodes, where N is at
   * most `maxEntries * avgSequenceLength`. For the default cap of 1000 entries
   * and typical short LLM prefix sequences, this is fast in practice. If your
   * workload uses a very large `maxEntries` under sustained write churn, replace
   * this with an auxiliary min-heap keyed by `sequence` to get O(log N)
   * eviction.
   *
   * @internal
   */
  // oxlint-disable-next-line complexity -- ID:ai-prompt-cache-evict-oldest-complexity
  #evictOldest(): void {
    let oldestNode: TrieNode | null = null;
    let oldestHash = '';

    // Pass 1: DFS to find the terminal with the minimum sequence number.
    // Uses a mutable path array with push/pop instead of spreading a new
    // ancestor array per stack entry, avoiding O(B^D × D) intermediate arrays.
    const findStack: Array<{ node: TrieNode; hash: string }> = [{ node: this.#root, hash: '' }];

    while (findStack.length > 0) {
      const entry = findStack.pop();
      if (!entry) break;
      const { node, hash } = entry;

      if (node.isTerminal) {
        if (oldestNode === null || node.sequence < oldestNode.sequence) {
          oldestNode = node;
          oldestHash = hash;
        }
      }

      for (const [childHash, child] of node.children) {
        findStack.push({ node: child, hash: childHash });
      }
    }

    // Pass 2: Walk from the root to the eviction target to build the ancestor
    // path. This is O(D) for a single path rather than O(B^D × D) arrays.
    const oldestAncestors: TrieNode[] = [];
    if (oldestNode !== null && oldestNode !== this.#root) {
      let current = this.#root;
      oldestAncestors.push(current);
      // Walk trie edges that lead toward the oldest node. Each level has a
      // unique child that is either the target or an ancestor of it. We
      // identify the correct child by recursively checking whether it contains
      // the target, which is still cheaper than materializing ancestor arrays
      // for every node in the full DFS.
      while (current !== oldestNode) {
        let stepped = false;
        for (const [, child] of current.children) {
          if (subtreeContains(child, oldestNode)) {
            oldestAncestors.push(child);
            current = child;
            stepped = true;
            break;
          }
        }
        if (!stepped) break; // shouldn't happen — defensive
      }
      // The ancestor list should not include the target node itself.
      if (oldestAncestors[oldestAncestors.length - 1] === oldestNode) {
        oldestAncestors.pop();
      }
    }

    if (oldestNode !== null) {
      oldestNode.isTerminal = false;
      this.#size--;

      // Update hasTerminalDescendant on the evicted node itself.
      oldestNode.hasTerminalDescendant = this.#subtreeHasTerminal(oldestNode);

      // Walk ancestors bottom-up: recompute hasTerminalDescendant and prune
      // childless non-terminal nodes to prevent memory accumulation.
      //
      // We maintain a "last child hash" so that each ancestor can delete the
      // child below it if that child has become dead (no children, not terminal).
      // Start with the evicted node as the initial "child to maybe prune".
      let childToMaybePrune: TrieNode = oldestNode;
      let childHash = oldestHash;

      for (let i = oldestAncestors.length - 1; i >= 0; i--) {
        const ancestor = oldestAncestors[i];
        if (!ancestor) continue;

        // Prune the child if it is now dead (no children and not terminal).
        if (childToMaybePrune.children.size === 0 && !childToMaybePrune.isTerminal) {
          ancestor.children.delete(childHash);
        }

        ancestor.hasTerminalDescendant = this.#subtreeHasTerminal(ancestor);

        // This ancestor is now the child for the next iteration.
        childToMaybePrune = ancestor;
        const grandparent = oldestAncestors[i - 1];
        childHash = grandparent ? this.#findChildHash(grandparent, ancestor) : '';
      }
    }
  }

  /**
   * Find the key in `parent.children` that maps to `child`.
   * Used during bottom-up ancestor pruning to identify the edge to remove.
   *
   * @internal
   */
  #findChildHash(parent: TrieNode, child: TrieNode): string {
    for (const [hash, node] of parent.children) {
      if (node === child) return hash;
    }
    return '';
  }

  /**
   * Return true if the given node is a terminal or has any terminal
   * descendant. Used to recompute `hasTerminalDescendant` after eviction.
   *
   * @internal
   */
  #subtreeHasTerminal(node: TrieNode): boolean {
    if (node.isTerminal) return true;
    for (const child of node.children.values()) {
      if (child.hasTerminalDescendant || child.isTerminal) return true;
    }
    return false;
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
