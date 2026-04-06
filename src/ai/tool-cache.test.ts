import { describe, expect, it } from 'bun:test';

import type { CacheEntry } from './tool-cache';
import { sweepExpiredCacheEntries } from './tool-cache';

function createEntry(output: string, timestamp: number): CacheEntry {
  return { output, timestamp };
}

describe('tool cache helpers', () => {
  it('removes expired entries before enforcing the hard size cap', () => {
    const now = Date.now();
    const cache = new Map<string, CacheEntry>([
      ['expired', createEntry('old', now - 10_000)],
      ['fresh-a', createEntry('a', now - 100)],
      ['fresh-b', createEntry('b', now - 50)],
    ]);

    sweepExpiredCacheEntries(cache, 5_000, 2);

    expect([...cache.keys()]).toEqual(['fresh-a', 'fresh-b']);
  });

  it('evicts the oldest surviving entries when the cache still exceeds the hard size cap', () => {
    const now = Date.now();
    const cache = new Map<string, CacheEntry>([
      ['oldest', createEntry('a', now - 300)],
      ['middle', createEntry('b', now - 200)],
      ['newest', createEntry('c', now - 100)],
    ]);

    sweepExpiredCacheEntries(cache, 5_000, 2);

    expect([...cache.keys()]).toEqual(['middle', 'newest']);
  });
});
