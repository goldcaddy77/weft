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
 * Maximum number of entries the tool cache can hold. When the cache exceeds
 * this size during an eviction sweep, oldest entries are dropped until the
 * cache is within budget.
 */
export const TOOL_CACHE_MAX_ENTRIES = 1000;

/**
 * Number of entries that triggers a proactive eviction sweep when checking
 * an individual cache entry's TTL. Below this threshold the per-access
 * overhead of a full sweep is skipped.
 */
export const TOOL_CACHE_SWEEP_THRESHOLD = 100;

/**
 * Remove all expired entries from the cache and enforce a hard size cap.
 * Called proactively during cache reads once the map exceeds
 * {@link TOOL_CACHE_SWEEP_THRESHOLD} entries.
 *
 * @internal
 */
export function sweepExpiredCacheEntries(cache: Map<string, CacheEntry>, ttl: number): void {
  const now = Date.now();

  // First pass: remove expired entries.
  // Deleting the current key during Map iteration is safe per the ECMAScript
  // specification — visited entries are not revisited after deletion.
  for (const [key, entry] of cache) {
    if (now - entry.timestamp >= ttl) {
      cache.delete(key);
    }
  }

  // If still over the hard cap, evict oldest entries first.
  if (cache.size <= TOOL_CACHE_MAX_ENTRIES) {
    return;
  }

  const sorted = [...cache.entries()].toSorted((a, b) => a[1].timestamp - b[1].timestamp);
  const toEvict = sorted.slice(0, cache.size - TOOL_CACHE_MAX_ENTRIES);
  for (const [key] of toEvict) {
    cache.delete(key);
  }
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
