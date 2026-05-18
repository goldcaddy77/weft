/**
 * WAL-mode on-disk durability baseline.
 *
 * Per adapter:
 *   1. Round-trip: write → close → reopen → assert byte-identical reads.
 *   2. Sidecar / checkpoint durability — adapter-aware: Bun and Node force
 *      a `PRAGMA wal_checkpoint(TRUNCATE)`, assert success, optionally
 *      delete remaining sidecar files, and reopen. Turso uses the
 *      libSQL-shaped equivalent: write → close → reopen with a fresh
 *      client.
 *   3. Multi-session continuity: alternating write/close/reopen across
 *      multiple sessions.
 *
 * To break this test manually (negative-control documentation): edit
 * `src/storage/bun-sql.ts` and replace `PRAGMA journal_mode = WAL` with
 * `PRAGMA journal_mode = OFF`, then rerun. Revert before committing.
 */

import { existsSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';

import { availableAdapterSpecs, FixtureScope } from './adapter-spec.ts';

function bytesEqual(actual: Uint8Array | null, expected: Uint8Array): void {
  expect(actual).not.toBeNull();
  expect(Array.from(actual!)).toEqual(Array.from(expected));
}

for (const spec of availableAdapterSpecs()) {
  describe(`WAL durability — ${spec.name}`, () => {
    let scope: FixtureScope;

    beforeEach(() => {
      scope = new FixtureScope();
    });

    afterEach(() => {
      scope.cleanup();
    });

    it('write → close → reopen preserves all values byte-for-byte', async () => {
      try {
        const directory = scope.makeTempDirectory('wal-roundtrip');
        const databasePath = join(directory, 'weft.db');

        const writer = await spec.open(databasePath);
        await writer.storage.put('single:a', new Uint8Array([1, 2, 3]));
        await writer.storage.put('single:b', new Uint8Array([4, 5, 6]));
        await writer.storage.batch([
          { type: 'put', key: 'batch:x', value: new Uint8Array([7, 8, 9]) },
          { type: 'put', key: 'batch:y', value: new Uint8Array([10, 11, 12]) },
        ]);
        await writer.close();

        const reader = await spec.open(databasePath);
        bytesEqual(await reader.storage.get('single:a'), new Uint8Array([1, 2, 3]));
        bytesEqual(await reader.storage.get('single:b'), new Uint8Array([4, 5, 6]));
        bytesEqual(await reader.storage.get('batch:x'), new Uint8Array([7, 8, 9]));
        bytesEqual(await reader.storage.get('batch:y'), new Uint8Array([10, 11, 12]));
        await reader.close();
      } catch (error) {
        scope.markFailed();
        throw error;
      }
    });

    if (spec.exposesStandardSidecars) {
      it('explicit checkpoint truncates WAL, sidecar deletion is safe', async () => {
        try {
          const directory = scope.makeTempDirectory('wal-sidecar');
          const databasePath = join(directory, 'weft.db');

          const writer = await spec.open(databasePath);
          await writer.storage.put('keep:me', new Uint8Array([42]));
          await writer.storage.batch([
            { type: 'put', key: 'keep:also', value: new Uint8Array([43]) },
          ]);
          await writer.close();

          // Checkpoint runs after the adapter is closed so the sibling
          // connection has exclusive access. The checkpoint truncates the
          // WAL into the main database file.
          const checkpointer = await spec.open(databasePath);
          const result = await checkpointer.checkpoint();
          expect(result.truncated).toBe(true);
          await checkpointer.close();

          // Delete the WAL sidecar after the explicit checkpoint. Leaving
          // the `-shm` file in place is intentional: `-shm` is a private
          // shared-memory artifact that SQLite manages internally; deleting
          // it from under SQLite has undocumented behavior on some
          // platforms. The durability claim being tested is the documented
          // one: after a successful TRUNCATE checkpoint, the WAL is no
          // longer needed for correctness.
          const walPath = `${databasePath}-wal`;
          if (existsSync(walPath)) unlinkSync(walPath);

          const reader = await spec.open(databasePath);
          bytesEqual(await reader.storage.get('keep:me'), new Uint8Array([42]));
          bytesEqual(await reader.storage.get('keep:also'), new Uint8Array([43]));
          await reader.close();
        } catch (error) {
          scope.markFailed();
          throw error;
        }
      });
    } else {
      it('fresh client against same file URL reads all prior values', async () => {
        try {
          const directory = scope.makeTempDirectory('libsql-reopen');
          const databasePath = join(directory, 'weft.db');

          const writer = await spec.open(databasePath);
          await writer.storage.put('keep:me', new Uint8Array([42]));
          await writer.storage.batch([
            { type: 'put', key: 'keep:also', value: new Uint8Array([43]) },
          ]);
          await writer.close();

          const reader = await spec.open(databasePath);
          bytesEqual(await reader.storage.get('keep:me'), new Uint8Array([42]));
          bytesEqual(await reader.storage.get('keep:also'), new Uint8Array([43]));
          await reader.close();
        } catch (error) {
          scope.markFailed();
          throw error;
        }
      });
    }

    it('multi-session continuity preserves writes across three open/close cycles', async () => {
      try {
        const directory = scope.makeTempDirectory('wal-multisession');
        const databasePath = join(directory, 'weft.db');

        const session1 = await spec.open(databasePath);
        await session1.storage.put('session:1', new Uint8Array([1]));
        await session1.close();

        const session2 = await spec.open(databasePath);
        await session2.storage.put('session:2', new Uint8Array([2]));
        await session2.close();

        const session3 = await spec.open(databasePath);
        bytesEqual(await session3.storage.get('session:1'), new Uint8Array([1]));
        bytesEqual(await session3.storage.get('session:2'), new Uint8Array([2]));
        await session3.close();
      } catch (error) {
        scope.markFailed();
        throw error;
      }
    });
  });
}
