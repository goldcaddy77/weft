import { hashString } from '../../runtime/portable.ts';
import type { Message } from '../providers/types.ts';

/**
 * A single node in the prefix trie. Each node represents one message in the
 * prefix sequence, keyed by that message's content hash.
 *
 * @internal
 */
export interface TrieNode {
  /** Child nodes indexed by the next message's content hash. */
  children: Map<string, TrieNode>;
  /**
   * True when this node is the endpoint of at least one stored sequence.
   * Only endpoints carry the cache_control annotation boundary.
   */
  isTerminal: boolean;
  /**
   * True when this subtree contains at least one live terminal (either this
   * node itself or any descendant). Used by `#longestMatchingPrefix` to
   * distinguish live intermediate nodes (on the path to a real sequence) from
   * orphaned intermediates left behind after eviction.
   */
  hasTerminalDescendant: boolean;
  /**
   * Insertion-order sequence number, used to evict the oldest terminal when
   * the cache exceeds `maxEntries`.
   */
  sequence: number;
}

/**
 * Hash the content-relevant fields of a single message to a compact key.
 *
 * Uses `hashString` (stable FNV-1a across runtimes) — fast and good enough for a cache key. Two
 * messages with identical role + content + tool data produce identical keys.
 *
 * @internal
 */
export function hashMessage(message: Message): string {
  const payload = JSON.stringify({
    role: message.role,
    content: message.content,
    toolCalls: message.toolCalls,
    toolResults: message.toolResults,
    name: message.name,
  });
  return hashString(payload);
}

/**
 * Check whether `target` is reachable from `from` via children edges.
 *
 * Used by {@link PromptCache.#evictOldest} to trace a root→target path without
 * materializing ancestor arrays during the initial DFS. Defined at module scope
 * so it is allocated once rather than on every eviction call.
 *
 * @internal
 */
export function subtreeContains(from: TrieNode, target: TrieNode): boolean {
  if (from === target) return true;
  for (const [, child] of from.children) {
    if (subtreeContains(child, target)) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// PromptCache
// ---------------------------------------------------------------------------
