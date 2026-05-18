/**
 * Per-adapter spec shared by the on-disk durability test suite.
 *
 * Each spec opens a disk-backed SQLite adapter, exposes its WAL-checkpoint
 * passthrough, and provides a deterministic in-transaction failure trigger
 * for {@link OpenedAdapter.makeFailingBatch}. The spec is internal to the
 * durability tests; nothing here is re-exported from the public testing
 * surface.
 */

import { mkdirSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Database } from 'bun:sqlite';

import { BunSQLiteStorage } from '../bun-sql.ts';
import type { BatchOperation, Storage } from '../interface.ts';
import { NodeSQLiteStorage } from '../node-sqlite.ts';
import { TursoStorage } from '../turso.ts';

type BetterSqliteRow = { busy: number; log: number; checkpointed: number };

type BetterSqliteDatabaseHandle = {
  pragma(source: string): unknown;
  close(): void;
};

type BetterSqliteConstructor = new (path: string) => BetterSqliteDatabaseHandle;

let cachedBetterSqlite: BetterSqliteConstructor | undefined;

function loadBetterSqlite3Locally(): BetterSqliteConstructor {
  if (cachedBetterSqlite !== undefined) return cachedBetterSqlite;
  const requireFromHere = createRequire(import.meta.url);
  const mod = requireFromHere('better-sqlite3') as BetterSqliteConstructor & {
    default?: BetterSqliteConstructor;
  };
  cachedBetterSqlite = typeof mod.default === 'function' ? mod.default : mod;
  return cachedBetterSqlite;
}

/** Evidence returned by {@link OpenedAdapter.checkpoint}. */
export type CheckpointResult = {
  /** True when the WAL was reset by `PRAGMA wal_checkpoint(TRUNCATE)`. */
  truncated: boolean;
  /** Raw passthrough row, for diagnostics. */
  raw: unknown;
};

/** Handle returned by {@link AdapterSpec.open}. */
export type OpenedAdapter = {
  storage: Storage;
  databasePath: string;
  /** Force a full WAL checkpoint and report whether it truncated. */
  checkpoint(): Promise<CheckpointResult>;
  /** Close the adapter and any side connections opened for diagnostics. */
  close(): Promise<void>;
  /**
   * Build a batch the adapter accepts but whose `failAtIndex`-th entry
   * triggers a SQLite constraint violation inside the adapter's own native
   * transaction. Test-only; uses casts to construct an invalid put.
   */
  makeFailingBatch(failAtIndex: number, validEntries: number): BatchOperation[];
};

/** A disk-backed SQLite adapter under test. */
export type AdapterSpec = {
  name: 'BunSQLiteStorage' | 'NodeSQLiteStorage' | 'TursoStorage';
  /** Whether `${path}-wal` / `${path}-shm` sidecars are part of the on-disk surface. */
  exposesStandardSidecars: boolean;
  open(databasePath: string): Promise<OpenedAdapter>;
};

/**
 * Build a `mid:` batch whose `failAtIndex`-th entry carries a NULL value.
 *
 * The KV schema (`src/storage/sqlite-key-value-queries.ts`) declares
 * `value BLOB NOT NULL`, so a NULL value violates the column constraint and
 * the adapter's native transaction rolls back.
 */
function makeNullValueFailingBatch(failAtIndex: number, validEntries: number): BatchOperation[] {
  const operations: BatchOperation[] = [];
  for (let index = 0; index < validEntries; index++) {
    const key = `mid:${index.toString().padStart(6, '0')}`;
    if (index === failAtIndex) {
      operations.push({ type: 'put', key, value: null as unknown as Uint8Array });
    } else {
      operations.push({ type: 'put', key, value: new Uint8Array([index & 0xff]) });
    }
  }
  return operations;
}

/**
 * Issue `PRAGMA wal_checkpoint(TRUNCATE)` against the given database file.
 *
 * Called only after the adapter has been disposed, so the sibling
 * connection has exclusive access. The adapter's own `query()` passthrough
 * rejects parenthesized PRAGMA statements, so we open a short-lived
 * sibling here and finalize it before returning. Each adapter's
 * `checkpoint()` is responsible for ensuring the primary connection is
 * closed before delegating here.
 */
function bunSqliteCheckpoint(databasePath: string): CheckpointResult {
  const database = new Database(databasePath);
  try {
    const rows = database
      .prepare<
        { busy: number; log: number; checkpointed: number },
        []
      >('PRAGMA wal_checkpoint(TRUNCATE)')
      .all();
    const raw = rows[0];
    const truncated = raw !== undefined && raw.busy === 0;
    return { truncated, raw };
  } finally {
    database.close();
  }
}

const bunSqliteSpec: AdapterSpec = {
  name: 'BunSQLiteStorage',
  exposesStandardSidecars: true,
  async open(databasePath: string) {
    const storage = new BunSQLiteStorage(databasePath);
    return {
      storage,
      databasePath,
      async checkpoint(): Promise<CheckpointResult> {
        return bunSqliteCheckpoint(databasePath);
      },
      async close(): Promise<void> {
        storage[Symbol.dispose]();
      },
      makeFailingBatch: makeNullValueFailingBatch,
    };
  },
};

const nodeSqliteSpec: AdapterSpec = {
  name: 'NodeSQLiteStorage',
  exposesStandardSidecars: true,
  async open(databasePath: string) {
    const storage = new NodeSQLiteStorage(databasePath);
    return {
      storage,
      databasePath,
      async checkpoint(): Promise<CheckpointResult> {
        const BetterSqliteDatabase = loadBetterSqlite3Locally();
        const database = new BetterSqliteDatabase(databasePath);
        try {
          const raw = database.pragma('wal_checkpoint(TRUNCATE)') as
            | readonly BetterSqliteRow[]
            | BetterSqliteRow;
          const row = Array.isArray(raw) ? raw[0] : raw;
          const truncated = row !== undefined && row.busy === 0;
          return { truncated, raw };
        } finally {
          database.close();
        }
      },
      async close(): Promise<void> {
        storage[Symbol.dispose]();
      },
      makeFailingBatch: makeNullValueFailingBatch,
    };
  },
};

const tursoSpec: AdapterSpec = {
  name: 'TursoStorage',
  // libSQL local-file may or may not expose standard sidecars depending on
  // the bundled client. Treat as false by default; the sidecar test routes
  // Turso to a libSQL-shaped equivalent (write/close/reopen with a fresh
  // client against the same `file:` URL).
  exposesStandardSidecars: false,
  async open(databasePath: string) {
    const storage = new TursoStorage({ url: `file:${databasePath}` });
    return {
      storage,
      databasePath,
      async checkpoint(): Promise<CheckpointResult> {
        // Turso's local-file client controls its own checkpointing; we do
        // not have a stable passthrough. The sidecar test does not call
        // checkpoint() for Turso, so this is a no-op success.
        return { truncated: true, raw: { note: 'libsql local-file: no explicit pragma path' } };
      },
      async close(): Promise<void> {
        storage[Symbol.dispose]();
      },
      makeFailingBatch: makeNullValueFailingBatch,
    };
  },
};

/**
 * Whether `better-sqlite3` is loadable in the current runtime. Bun cannot
 * load better-sqlite3's native bindings (oven-sh/bun#4290), so Node-SQLite
 * integration tests run only when the suite is invoked under Node. Mirrors
 * the gating pattern in `src/storage/node-sqlite.test.ts`.
 */
const IS_BUN = typeof globalThis.Bun !== 'undefined';
let nodeSqliteAvailable: boolean | undefined;
function canLoadNodeSqlite(): boolean {
  if (nodeSqliteAvailable !== undefined) return nodeSqliteAvailable;
  if (IS_BUN) {
    nodeSqliteAvailable = false;
    return false;
  }
  try {
    new NodeSQLiteStorage(':memory:')[Symbol.dispose]();
    nodeSqliteAvailable = true;
  } catch {
    nodeSqliteAvailable = false;
  }
  return nodeSqliteAvailable;
}

/** All adapter specs available in the current runtime. */
export function availableAdapterSpecs(): readonly AdapterSpec[] {
  const specs: AdapterSpec[] = [bunSqliteSpec, tursoSpec];
  if (canLoadNodeSqlite()) specs.push(nodeSqliteSpec);
  return specs;
}

/** Bun+Node specs only — used by tests that require a raw client path. */
export function availableBunNodeAdapterSpecs(): readonly AdapterSpec[] {
  const specs: AdapterSpec[] = [bunSqliteSpec];
  if (canLoadNodeSqlite()) specs.push(nodeSqliteSpec);
  return specs;
}

/** Static list of all conceivable adapter specs (for diagnostic use only). */
export const adapterSpecs: readonly AdapterSpec[] = [bunSqliteSpec, nodeSqliteSpec, tursoSpec];

/**
 * Per-test fixture tracker.
 *
 * Each test owns its own scope so a later passing test's cleanup never
 * removes a prior failing test's preserved directories. Set
 * `WEFT_KEEP_DURABILITY_FIXTURES=1` in the environment to retain
 * directories regardless of outcome.
 */
export class FixtureScope {
  readonly #directories: string[] = [];
  #failed = false;

  makeTempDirectory(label: string): string {
    const directory = join(tmpdir(), `weft-durability-${label}-${crypto.randomUUID()}`);
    mkdirSync(directory, { recursive: true });
    this.#directories.push(directory);
    return directory;
  }

  markFailed(): void {
    this.#failed = true;
  }

  cleanup(): void {
    if (this.#failed) return;
    if (process.env['WEFT_KEEP_DURABILITY_FIXTURES'] === '1') return;
    while (this.#directories.length > 0) {
      const directory = this.#directories.pop();
      if (directory === undefined) break;
      try {
        rmSync(directory, { recursive: true, force: true });
      } catch {
        // best-effort
      }
    }
  }
}
