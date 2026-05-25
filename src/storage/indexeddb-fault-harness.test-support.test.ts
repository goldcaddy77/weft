import { describe, expect, it } from 'bun:test';

import {
  createFakeTransaction,
  withFakeIndexedDb,
} from './indexeddb-fault-harness.test-support.ts';

describe('IndexedDB fault harness support', () => {
  it('fires the fake transaction complete handler synchronously', () => {
    let completed = false;
    const transaction = createFakeTransaction({
      store: () => ({}),
    });

    transaction.oncomplete = () => {
      completed = true;
    };

    transaction.fireComplete();

    expect(completed).toBe(true);
  });

  it('drives upgrade before success when installing the default fake database', async () => {
    await withFakeIndexedDb(
      {
        transaction: createFakeTransaction({
          store: () => ({}),
        }),
      },
      async () => {
        const request = indexedDB.open(`test-${crypto.randomUUID()}`, 1);
        const lifecycle: string[] = [];

        request.onupgradeneeded = () => {
          lifecycle.push('upgrade');
          expect(request.result.objectStoreNames.contains('kv')).toBe(true);
        };

        request.onsuccess = () => {
          lifecycle.push('success');
        };

        await Promise.resolve();

        expect(lifecycle).toEqual(['upgrade', 'success']);
      },
    );
  });
});
