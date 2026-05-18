/**
 * Native-transaction batch atomicity.
 *
 * Drives the adapter's real `batch()` (its native SQL transaction) and
 * forces a deterministic failure inside the transaction by passing a NULL
 * value to a column declared `BLOB NOT NULL`. Asserts the pre-batch state
 * is intact afterward — including the entries that came *before* the
 * failing index, which must roll back atomically.
 */

import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';

import { availableAdapterSpecs, FixtureScope } from './adapter-spec.ts';

for (const spec of availableAdapterSpecs()) {
  describe(`batch atomicity — ${spec.name}`, () => {
    let scope: FixtureScope;

    beforeEach(() => {
      scope = new FixtureScope();
    });

    afterEach(() => {
      scope.cleanup();
    });

    it('a failing entry inside batch() rolls back all entries in the same transaction', async () => {
      try {
        const directory = scope.makeTempDirectory('batch-atomicity');
        const databasePath = join(directory, 'weft.db');

        const writer = await spec.open(databasePath);

        // Seed the pre-batch baseline.
        await writer.storage.put('before:1', new Uint8Array([1]));
        await writer.storage.put('before:2', new Uint8Array([2]));

        // Build a 5-entry batch that fails at index 2.
        const operations = writer.makeFailingBatch(2, 5);
        await expect(writer.storage.batch(operations)).rejects.toBeInstanceOf(Error);

        // The transaction must have rolled back: no `mid:` entries at all,
        // including the ones that came before the failing index.
        await writer.close();

        const reader = await spec.open(databasePath);
        expect(await reader.storage.get('before:1')).not.toBeNull();
        expect(await reader.storage.get('before:2')).not.toBeNull();
        for (let index = 0; index < 5; index++) {
          const key = `mid:${index.toString().padStart(6, '0')}`;
          expect(await reader.storage.get(key)).toBeNull();
        }
        await reader.close();
      } catch (error) {
        scope.markFailed();
        throw error;
      }
    });
  });
}
