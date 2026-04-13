import { describe, expect, it } from 'bun:test';

import type { Storage } from './interface.ts';
import { storageDeletePrefix } from './interface.ts';
import { MemoryStorage } from './memory.ts';

function createCoreStorageAdapter(): Storage {
  const storage = new MemoryStorage();

  return {
    get: storage.get.bind(storage),
    put: storage.put.bind(storage),
    delete: storage.delete.bind(storage),
    scan: storage.scan.bind(storage),
    batch: storage.batch.bind(storage),
    [Symbol.dispose]: storage[Symbol.dispose].bind(storage),
  };
}

describe('storageDeletePrefix', () => {
  it('returns 0 when the fallback path finds no matching keys', async () => {
    const storage = createCoreStorageAdapter();

    expect(await storageDeletePrefix(storage, 'missing:')).toBe(0);
  });
});
