/**
 * Tool result cache entry.
 *
 * @internal
 */
export interface CacheEntry {
  output: string;
  timestamp: number;
}

/**
 * Insert a tool result cache entry, enforcing the configured max size.
 *
 * `Map` preserves insertion order, so deleting the first key evicts the
 * oldest entry. If the key already exists, we delete it first so the
 * updated entry is re-inserted at the tail, keeping insertion order
 * consistent with recency.
 *
 * @internal
 */
export function setToolCacheEntry(
  cache: Map<string, CacheEntry>,
  key: string,
  entry: CacheEntry,
  maxSize: number,
): void {
  if (cache.has(key)) {
    cache.delete(key);
  }
  cache.set(key, entry);

  // Clamp to a non-negative bound. A negative `maxSize` would otherwise spin
  // forever: once the cache is empty, `cache.size > maxSize` stays true and
  // the inner key-iteration loop has nothing to delete.
  const effectiveMax = Math.max(0, Math.floor(maxSize));

  while (cache.size > effectiveMax) {
    // `Map.keys()` iterates in insertion order; the first key is the oldest.
    // The loop guard (`cache.size > effectiveMax`) guarantees at least one
    // entry, so the iterator's first value is always defined.
    for (const oldestKey of cache.keys()) {
      cache.delete(oldestKey);
      break;
    }
  }
}
