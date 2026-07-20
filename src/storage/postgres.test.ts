import { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';

import { PostgresStorage, type PostgresPool, type PostgresPoolClient } from './postgres.ts';
import {
  bytes as encode,
  runBasicStorageContract,
  runStorageCapabilityConformance,
} from './storage-adapter.test-support.ts';

/**
 * A single PGlite instance is booted once in `beforeAll` and shared by every case
 * in this file purely for speed: a fresh PGlite is a full WASM Postgres boot
 * (~hundreds of ms), so booting one and truncating the table between cases keeps
 * the suite fast instead of re-booting per test. Booting in a hook (not at
 * module-eval) keeps the import phase side-effect-free and lets the boot await
 * cleanly before the first case runs.
 */
let sharedDatabase: PGlite;

beforeAll(async () => {
  sharedDatabase = await new PGlite();
  await sharedDatabase.query('SELECT 1');
});

afterAll(async () => {
  await sharedDatabase.close();
});

/**
 * Wrap the shared PGlite instance as a {@link PostgresPool}. PGlite is a real
 * in-process Postgres, so this exercises the actual `$1`/BYTEA/`ON CONFLICT`/range
 * SQL and the `COLLATE "C"` ordering that a JS-map fake would silently get wrong.
 * PGlite serializes statements on one connection, so an interactive
 * `BEGIN`/`COMMIT` driven through plain `query()` is safe and `connect()` hands
 * back the same instance with a no-op `release()`. `end()` is a no-op because the
 * shared instance outlives any single case and is closed once in `afterAll`.
 */
function sharedPgliteAsPostgresPool(): PostgresPool {
  const client: PostgresPoolClient = {
    query: (sql, parameters) => sharedDatabase.query(sql, parameters as unknown[]),
    release: () => {
      // Single shared connection; nothing to return to a pool.
    },
  };
  return {
    query: (sql, parameters) => sharedDatabase.query(sql, parameters as unknown[]),
    connect: async () => client,
    end: async () => {
      // The shared instance is closed once in afterAll, not per dispose.
    },
  };
}

/**
 * Construct a PostgresStorage over the shared PGlite, resetting the table first so
 * each case starts from an empty store. `PostgresKeyValueStorage.#ensureTable`
 * creates the table on first use; truncating here is enough to isolate cases.
 */
async function createPgliteBackedPostgresStorage(): Promise<PostgresStorage> {
  await sharedDatabase.query(
    'CREATE TABLE IF NOT EXISTS kv (key TEXT COLLATE "C" PRIMARY KEY, value BYTEA NOT NULL)',
  );
  await sharedDatabase.query('DELETE FROM kv');
  return new PostgresStorage({ pool: sharedPgliteAsPostgresPool() });
}

runStorageCapabilityConformance('PostgresStorage', {
  create: createPgliteBackedPostgresStorage,
  // PostgresStorage always reports the production (primary-endpoint) capability
  // row, regardless of the injected backend. PGlite's in-process behavior is a
  // superset of these claims, so the behavioral cases pass.
  expected: {
    persistence: 'remote',
    readAfterWrite: 'linearizable',
    scanConsistency: 'snapshot',
    atomicBatch: true,
    conditionalBatch: true,
    boundedRangeDelete: true,
  },
});

runBasicStorageContract('PostgresStorage', { create: createPgliteBackedPostgresStorage });

describe('PostgresStorage', () => {
  it('accepts an injected pool without a url', async () => {
    // The native pg adapter shares the injected-pool escape hatch: with a pool
    // supplied, `url` is optional and never touched. This is the papercut fix that
    // lets a caller reuse a shared application pool without a dummy connection
    // string.
    await using storage = new PostgresStorage({ pool: sharedPgliteAsPostgresPool() });
    await sharedDatabase.query(
      'CREATE TABLE IF NOT EXISTS kv (key TEXT COLLATE "C" PRIMARY KEY, value BYTEA NOT NULL)',
    );
    await sharedDatabase.query('DELETE FROM kv');
    await storage.put('k', encode('v'));
    expect(await storage.get('k')).toEqual(encode('v'));
  });

  it('throws a clear error when neither a url nor a pool is provided', () => {
    // Without a pool to reuse and no url to build one from, there is nothing to
    // connect to — fail loudly at construction rather than later on first use.
    expect(() => new PostgresStorage({})).toThrow(/either a `url`.*or a pre-built `pool`/);
  });

  it('round-trips binary values including embedded NULs', async () => {
    await using storage = await createPgliteBackedPostgresStorage();
    const binary = new Uint8Array([0, 1, 127, 128, 255, 42, 0, 13, 10]);
    await storage.put('binary', binary);
    expect(await storage.get('binary')).toEqual(binary);
  });

  it('orders punctuated keys by byte value (COLLATE "C")', async () => {
    await using storage = await createPgliteBackedPostgresStorage();
    await storage.put('wf:z', encode('z'));
    await storage.put('wf-idx:a', encode('a'));
    const entries: string[] = [];
    for await (const [key] of storage.scan('wf')) {
      entries.push(key);
    }
    expect(entries).toEqual(['wf-idx:a', 'wf:z']);
  });

  it('batch applies puts and deletes atomically', async () => {
    await using storage = await createPgliteBackedPostgresStorage();
    await storage.put('keep', encode('keep'));
    await storage.put('remove', encode('remove'));
    await storage.batch([
      { type: 'put', key: 'added', value: encode('added') },
      { type: 'delete', key: 'remove' },
    ]);
    expect(await storage.get('keep')).toEqual(encode('keep'));
    expect(await storage.get('remove')).toBeNull();
    expect(await storage.get('added')).toEqual(encode('added'));
  });

  it('conditionalBatch commits when an absent-key precondition holds', async () => {
    await using storage = await createPgliteBackedPostgresStorage();
    const applied = await storage.conditionalBatch(
      [{ key: 'idem:k', expectedValue: null }],
      [{ type: 'put', key: 'idem:k', value: encode('first') }],
    );
    expect(applied).toBe(true);
    expect(await storage.get('idem:k')).toEqual(encode('first'));
  });

  it('does NOT close an injected (caller-owned) pool on async dispose', async () => {
    // Ownership stays with the caller for an injected pool — disposing one
    // PostgresStorage must not tear out a pool shared by other consumers.
    let endCalled = false;
    const stubPool: PostgresPool = {
      query: async () => ({ rows: [] }),
      connect: async () => ({ query: async () => ({ rows: [] }), release: () => {} }),
      end: async () => {
        endCalled = true;
      },
    };
    const storage = new PostgresStorage({ pool: stubPool });
    await storage[Symbol.asyncDispose]();
    expect(endCalled).toBe(false);
  });

  it('closes an owned pool built via the injected poolFactory on async dispose', async () => {
    // The poolFactory seam constructs an owned pool; disposal must close it
    // exactly once. This covers the owned-pool teardown path without importing the
    // real pg driver or contacting any network.
    let endCalls = 0;
    const ownedPool: PostgresPool = {
      query: async () => ({ rows: [] }),
      connect: async () => ({ query: async () => ({ rows: [] }), release: () => {} }),
      end: async () => {
        endCalls += 1;
      },
    };
    const storage = new PostgresStorage(
      { url: 'postgresql://user:pass@localhost/db' },
      () => ownedPool,
    );
    await storage[Symbol.asyncDispose]();
    expect(endCalls).toBe(1);
  });
});

/**
 * Opt-in integration suite against a real Postgres via the `pg` driver. Skipped
 * by default so CI and `bun test` never require a database; set
 * `WEFT_TEST_POSTGRES_URL` (point it at a primary endpoint) to run it. This is the
 * only place the real `pg` wire protocol — TCP connection, BYTEA marshalling, and
 * SERIALIZABLE conflict handling — is exercised end to end.
 */
const POSTGRES_URL = process.env['WEFT_TEST_POSTGRES_URL'];

describe.skipIf(!POSTGRES_URL)('PostgresStorage (live pg)', () => {
  async function createLivePostgresStorage(): Promise<PostgresStorage> {
    const storage = new PostgresStorage({ url: POSTGRES_URL! });
    // Reset the shared remote table so each case starts from an empty store.
    await storage.put('__reset__', new Uint8Array([0]));
    await storage.deletePrefix('');
    return storage;
  }

  it('round-trips put/get and scan over the real driver', async () => {
    await using storage = await createLivePostgresStorage();
    await storage.put('live:a', encode('a'));
    await storage.put('live:b', encode('b'));
    expect(await storage.get('live:a')).toEqual(encode('a'));
    const keys: string[] = [];
    for await (const key of storage.keys('live:')) {
      keys.push(key);
    }
    expect(keys).toEqual(['live:a', 'live:b']);
    await storage.deletePrefix('live:');
  });

  it('applies a mixed batch as one atomic transaction over the real driver', async () => {
    await using storage = await createLivePostgresStorage();
    await storage.put('batch:gone', encode('seed'));
    await storage.batch([
      { type: 'put', key: 'batch:kept', value: encode('value') },
      { type: 'delete', key: 'batch:gone' },
    ]);
    expect(await storage.get('batch:kept')).toEqual(encode('value'));
    expect(await storage.get('batch:gone')).toBeNull();
    await storage.deletePrefix('batch:');
  });
});
