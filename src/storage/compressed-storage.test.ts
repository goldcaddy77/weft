import { describe, expect, it } from 'bun:test';

import { CompressedStorage } from './compressed-storage';
import type { Storage } from './interface';
import { MemoryStorage } from './memory';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Create a CompressedStorage wrapping a fresh MemoryStorage. */
function createStorage(options?: { algorithm?: 'gzip' | 'brotli' | 'none'; threshold?: number }) {
  const inner = new MemoryStorage();
  const storage = new CompressedStorage(inner, options);
  return { storage, inner };
}

// ---------------------------------------------------------------------------
// Basic put/get round-trip
// ---------------------------------------------------------------------------

describe('put/get round-trip', () => {
  it('round-trips a small payload (below threshold)', async () => {
    const { storage } = createStorage();
    const value = new Uint8Array([1, 2, 3, 4, 5]);
    await storage.put('key-small', value);
    const result = await storage.get('key-small');
    expect(result).toEqual(value);
  });

  it('round-trips a large payload (above threshold)', async () => {
    const { storage } = createStorage({ threshold: 64 });
    const value = new Uint8Array(256).fill(42);
    await storage.put('key-large', value);
    const result = await storage.get('key-large');
    expect(result).toEqual(value);
  });

  it('returns null for a missing key', async () => {
    const { storage } = createStorage();
    const result = await storage.get('nonexistent');
    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Storage format verification
// ---------------------------------------------------------------------------

describe('storage format', () => {
  it('stores small values with [0xC1, 0x00] prefix (uncompressed)', async () => {
    const { storage, inner } = createStorage({ threshold: 1024 });
    const value = new Uint8Array([10, 20, 30]);
    await storage.put('small', value);

    const stored = await inner.get('small');
    expect(stored).not.toBeNull();
    expect(stored![0]).toBe(0xc1); // magic byte
    expect(stored![1]).toBe(0x00); // uncompressed algorithm byte
    expect(stored!.slice(2)).toEqual(value);
  });

  it('stores large values compressed (inner has smaller data)', async () => {
    const { storage, inner } = createStorage({ threshold: 64 });
    // Repetitive data compresses well
    const value = new Uint8Array(1024).fill(0xab);
    await storage.put('large', value);

    const stored = await inner.get('large');
    expect(stored).not.toBeNull();
    expect(stored![0]).toBe(0xc1); // magic byte
    expect(stored![1]).toBe(0x01); // gzip algorithm byte
    // The stored data (including header) should be smaller than the original
    expect(stored!.length).toBeLessThan(value.length);
  });
});

// ---------------------------------------------------------------------------
// Scan
// ---------------------------------------------------------------------------

describe('scan', () => {
  it('decompresses all values during scan', async () => {
    const { storage } = createStorage({ threshold: 64 });

    const values = [
      new Uint8Array([1, 2, 3]), // below threshold
      new Uint8Array(128).fill(99), // above threshold
      new Uint8Array(256).fill(77), // above threshold
    ];

    await storage.put('prefix:a', values[0]!);
    await storage.put('prefix:b', values[1]!);
    await storage.put('prefix:c', values[2]!);

    const results: [string, Uint8Array][] = [];
    for await (const entry of storage.scan('prefix:')) {
      results.push(entry);
    }

    expect(results.length).toBe(3);
    expect(results[0]![0]).toBe('prefix:a');
    expect(results[0]![1]).toEqual(values[0]!);
    expect(results[1]![0]).toBe('prefix:b');
    expect(results[1]![1]).toEqual(values[1]!);
    expect(results[2]![0]).toBe('prefix:c');
    expect(results[2]![1]).toEqual(values[2]!);
  });
});

// ---------------------------------------------------------------------------
// Batch
// ---------------------------------------------------------------------------

describe('batch', () => {
  it('handles a mix of put and delete operations', async () => {
    const { storage } = createStorage({ threshold: 64 });

    // Pre-populate a key to delete
    await storage.put('delete-me', new Uint8Array([1]));

    const putValue = new Uint8Array(128).fill(55);

    await storage.batch([
      { type: 'put', key: 'batch-put', value: putValue },
      { type: 'delete', key: 'delete-me' },
    ]);

    const putResult = await storage.get('batch-put');
    expect(putResult).toEqual(putValue);

    const deletedResult = await storage.get('delete-me');
    expect(deletedResult).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Backward compatibility
// ---------------------------------------------------------------------------

describe('backward compatibility', () => {
  it('reads raw data (no header) from inner storage', async () => {
    const { storage, inner } = createStorage();

    // Simulate legacy data: raw bytes without a compression header.
    // 0x80 is msgpack fixmap — not a recognized compression header.
    const legacy = new Uint8Array([0x80, 0xa1, 0x61, 0x01]);
    await inner.put('legacy-key', legacy);

    const result = await storage.get('legacy-key');
    expect(result).toEqual(legacy);
  });
});

// ---------------------------------------------------------------------------
// Algorithm switching
// ---------------------------------------------------------------------------

describe('algorithm switching', () => {
  it('reads gzip-written data after reconfiguring to brotli', async () => {
    const inner = new MemoryStorage();
    const value = new Uint8Array(256).fill(88);

    // Write with gzip
    const gzipStorage = new CompressedStorage(inner, { algorithm: 'gzip', threshold: 64 });
    await gzipStorage.put('cross-algo', value);

    // Read with brotli — decompression uses the header byte, not config
    const brotliStorage = new CompressedStorage(inner, { algorithm: 'brotli', threshold: 64 });
    const result = await brotliStorage.get('cross-algo');
    expect(result).toEqual(value);
  });

  it('reads brotli-written data after reconfiguring to gzip', async () => {
    const inner = new MemoryStorage();
    const value = new Uint8Array(256).fill(44);

    const brotliStorage = new CompressedStorage(inner, { algorithm: 'brotli', threshold: 64 });
    await brotliStorage.put('cross-algo', value);

    const gzipStorage = new CompressedStorage(inner, { algorithm: 'gzip', threshold: 64 });
    const result = await gzipStorage.get('cross-algo');
    expect(result).toEqual(value);
  });
});

// ---------------------------------------------------------------------------
// Delete
// ---------------------------------------------------------------------------

describe('delete', () => {
  it('passes delete through to inner storage', async () => {
    const { storage, inner } = createStorage();
    await storage.put('to-delete', new Uint8Array([1, 2, 3]));
    expect(await inner.get('to-delete')).not.toBeNull();

    await storage.delete('to-delete');
    expect(await inner.get('to-delete')).toBeNull();
    expect(await storage.get('to-delete')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// query forwarding
// ---------------------------------------------------------------------------

describe('query forwarding', () => {
  it('returns undefined when inner storage has no query method', () => {
    const inner = new MemoryStorage();
    const storage: Storage = new CompressedStorage(inner);
    expect(storage.query).toBeUndefined();
  });

  it('forwards query when inner storage provides it', async () => {
    const inner = new MemoryStorage();
    const queryResults = [{ id: 1, name: 'test' }];

    // Attach a mock query method to simulate a storage that supports SQL
    Object.assign(inner, {
      query: async (_sql: string, _params?: unknown[]) => queryResults,
    });

    const storage: Storage = new CompressedStorage(inner);
    expect(storage.query).toBeDefined();
    const result = await storage.query!('SELECT 1', []);
    expect(result).toEqual(queryResults);
  });
});

// ---------------------------------------------------------------------------
// Symbol.dispose
// ---------------------------------------------------------------------------

describe('Symbol.dispose', () => {
  it('calls dispose on inner storage', () => {
    const inner = new MemoryStorage();
    inner.put('key', new Uint8Array([1]));
    expect(inner.size).toBe(1);

    const storage = new CompressedStorage(inner);
    storage[Symbol.dispose]();

    // MemoryStorage.dispose clears the map
    expect(inner.size).toBe(0);
  });
});
