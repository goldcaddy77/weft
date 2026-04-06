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
 * Number of entries that triggers a proactive eviction sweep when checking
 * an individual cache entry's TTL. Below this threshold the per-access
 * overhead of a full sweep is skipped.
 */
export const TOOL_CACHE_SWEEP_THRESHOLD = 100;

/**
 * Remove all expired entries from the cache and enforce the caller-provided
 * hard size cap. Called proactively during cache reads once the map exceeds
 * {@link TOOL_CACHE_SWEEP_THRESHOLD} entries.
 *
 * The cap is a runtime parameter so it stays in lockstep with the caller's
 * configured `toolCacheMaxSize`. A hardcoded constant here would silently
 * evict entries that the configured max explicitly permits.
 *
 * @internal
 */
export function sweepExpiredCacheEntries(
  cache: Map<string, CacheEntry>,
  ttl: number,
  maxSize: number,
): void {
  const now = Date.now();

  // First pass: remove expired entries.
  // Deleting the current key during Map iteration is safe per the ECMAScript
  // specification — visited entries are not revisited after deletion.
  for (const [key, entry] of cache) {
    if (now - entry.timestamp >= ttl) {
      cache.delete(key);
    }
  }

  // Clamp to a non-negative bound for the same reason `setToolCacheEntry`
  // does: a negative or non-integer value would spin forever if the cache
  // could never shrink below it.
  const effectiveMax = Math.max(0, Math.floor(maxSize));

  // If still over the hard cap, evict oldest entries first.
  if (cache.size <= effectiveMax) {
    return;
  }

  const sorted = [...cache.entries()].toSorted((a, b) => a[1].timestamp - b[1].timestamp);
  const toEvict = sorted.slice(0, cache.size - effectiveMax);
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
