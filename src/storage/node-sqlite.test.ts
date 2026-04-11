import { afterEach, beforeEach, describe, expect, it } from 'bun:test';

import { NodeSQLiteStorage } from './node-sqlite.ts';

// better-sqlite3 uses native bindings that aren't supported in Bun.
// These tests are designed to run under Node.js. When running under Bun,
// they verify only that the class exists and the capability check error
// message is correct.
const IS_BUN = typeof globalThis.Bun !== 'undefined';

function canLoadBetterSqlite3(): boolean {
  try {
    new NodeSQLiteStorage(':memory:')[Symbol.dispose]();
    return true;
  } catch {
    return false;
  }
}

const AVAILABLE = !IS_BUN && canLoadBetterSqlite3();
const describeIfAvailable = AVAILABLE ? describe : describe.skip;

describe('NodeSQLiteStorage', () => {
  if (IS_BUN) {
    it('throws a clear error when better-sqlite3 is unavailable under Bun', () => {
      expect(() => new NodeSQLiteStorage(':memory:')).toThrow(/better-sqlite3/);
    });
  }
});

describeIfAvailable('NodeSQLiteStorage (integration)', () => {
  let storage: NodeSQLiteStorage;

  beforeEach(() => {
    storage = new NodeSQLiteStorage(':memory:');
  });

  afterEach(() => {
    storage[Symbol.dispose]();
  });

  describe('get / put / delete', () => {
    it('returns null for a missing key', async () => {
      expect(await storage.get('missing')).toBeNull();
    });

    it('stores and retrieves a value', async () => {
      const value = new Uint8Array([1, 2, 3]);
      await storage.put('key1', value);
      const result = await storage.get('key1');
      expect(result).toEqual(value);
    });

    it('overwrites an existing key', async () => {
      await storage.put('key1', new Uint8Array([1]));
      await storage.put('key1', new Uint8Array([2]));
      const result = await storage.get('key1');
      expect(result).toEqual(new Uint8Array([2]));
    });

    it('deletes a key', async () => {
      await storage.put('key1', new Uint8Array([1]));
      await storage.delete('key1');
      expect(await storage.get('key1')).toBeNull();
    });

    it('delete on missing key is a no-op', async () => {
      // Should not throw.
      await storage.delete('nonexistent');
    });
  });

  describe('scan', () => {
    beforeEach(async () => {
      await storage.put('a:1', new Uint8Array([1]));
      await storage.put('a:2', new Uint8Array([2]));
      await storage.put('a:3', new Uint8Array([3]));
      await storage.put('b:1', new Uint8Array([4]));
    });

    it('scans all keys with a matching prefix', async () => {
      const results: [string, Uint8Array][] = [];
      for await (const entry of storage.scan('a:')) {
        results.push(entry);
      }
      expect(results).toHaveLength(3);
      expect(results[0]![0]).toBe('a:1');
      expect(results[1]![0]).toBe('a:2');
      expect(results[2]![0]).toBe('a:3');
    });

    it('respects limit', async () => {
      const results: [string, Uint8Array][] = [];
      for await (const entry of storage.scan('a:', { limit: 2 })) {
        results.push(entry);
      }
      expect(results).toHaveLength(2);
    });

    it('supports reverse ordering', async () => {
      const results: [string, Uint8Array][] = [];
      for await (const entry of storage.scan('a:', { reverse: true })) {
        results.push(entry);
      }
      expect(results[0]![0]).toBe('a:3');
      expect(results[2]![0]).toBe('a:1');
    });

    it('supports gt option', async () => {
      const results: [string, Uint8Array][] = [];
      for await (const entry of storage.scan('a:', { gt: 'a:1' })) {
        results.push(entry);
      }
      expect(results).toHaveLength(2);
      expect(results[0]![0]).toBe('a:2');
    });

    it('supports lt option', async () => {
      const results: [string, Uint8Array][] = [];
      for await (const entry of storage.scan('a:', { lt: 'a:3' })) {
        results.push(entry);
      }
      expect(results).toHaveLength(2);
      expect(results[1]![0]).toBe('a:2');
    });

    it('supports gte option', async () => {
      const results: [string, Uint8Array][] = [];
      for await (const entry of storage.scan('a:', { gte: 'a:2' })) {
        results.push(entry);
      }
      expect(results).toHaveLength(2);
      expect(results[0]![0]).toBe('a:2');
    });

    it('supports lte option', async () => {
      const results: [string, Uint8Array][] = [];
      for await (const entry of storage.scan('a:', { lte: 'a:2' })) {
        results.push(entry);
      }
      expect(results).toHaveLength(2);
      expect(results[1]![0]).toBe('a:2');
    });

    it('returns empty for non-matching prefix', async () => {
      const results: [string, Uint8Array][] = [];
      for await (const entry of storage.scan('z:')) {
        results.push(entry);
      }
      expect(results).toHaveLength(0);
    });

    it('caches scan statements', async () => {
      // Run two scans with the same shape but different parameters.
      const results1: [string, Uint8Array][] = [];
      for await (const entry of storage.scan('a:', { limit: 1 })) {
        results1.push(entry);
      }
      const results2: [string, Uint8Array][] = [];
      for await (const entry of storage.scan('a:', { limit: 2 })) {
        results2.push(entry);
      }

      // Same SQL shape → single cache entry.
      expect(storage.scanStatementCacheSize).toBe(1);
      expect(results1).toHaveLength(1);
      expect(results2).toHaveLength(2);
    });
  });

  describe('batch', () => {
    it('applies multiple operations atomically', async () => {
      await storage.batch([
        { type: 'put', key: 'k1', value: new Uint8Array([10]) },
        { type: 'put', key: 'k2', value: new Uint8Array([20]) },
        { type: 'put', key: 'k3', value: new Uint8Array([30]) },
      ]);

      expect(await storage.get('k1')).toEqual(new Uint8Array([10]));
      expect(await storage.get('k2')).toEqual(new Uint8Array([20]));
      expect(await storage.get('k3')).toEqual(new Uint8Array([30]));
    });

    it('handles mixed put and delete operations', async () => {
      await storage.put('existing', new Uint8Array([1]));
      await storage.batch([
        { type: 'put', key: 'new', value: new Uint8Array([2]) },
        { type: 'delete', key: 'existing' },
      ]);

      expect(await storage.get('new')).toEqual(new Uint8Array([2]));
      expect(await storage.get('existing')).toBeNull();
    });

    it('handles empty batch', async () => {
      // Should not throw.
      await storage.batch([]);
    });
  });

  describe('dispose', () => {
    it('closes the database cleanly', () => {
      const instance = new NodeSQLiteStorage(':memory:');
      // Should not throw.
      instance[Symbol.dispose]();
    });
  });
});
