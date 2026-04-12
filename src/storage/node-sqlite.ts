/**
 * Node-compatible SQLite storage adapter using `better-sqlite3`.
 *
 * Implements the same `Storage` interface and SQL schema as `BunSQLiteStorage`
 * but uses `better-sqlite3` instead of `bun:sqlite`, enabling the same
 * storage layer to run on Node.js 22+.
 *
 * `better-sqlite3` is a peer dependency — it must be installed separately by
 * consumers who import `weft/storage/sqlite/node`.
 *
 * @module storage/node-sqlite
 */

import { createRequire } from 'node:module';

import type { BatchOperation, ScanOptions, Storage } from './interface.ts';

/**
 * Minimal subset of the `better-sqlite3` API surface that this adapter uses.
 * Defined here so the module compiles without the package installed — the
 * actual dependency is resolved lazily at construction time.
 */
type BetterSqliteStatement = {
  run(...parameters: unknown[]): unknown;
  get(...parameters: unknown[]): Record<string, unknown> | undefined;
  all(...parameters: unknown[]): Record<string, unknown>[];
};

type BetterSqliteTransaction = (...args: unknown[]) => void;

type BetterSqliteDatabase = {
  pragma(source: string): unknown;
  exec(source: string): void;
  prepare(source: string): BetterSqliteStatement;
  transaction(fn: (...args: unknown[]) => void): BetterSqliteTransaction;
  close(): void;
};

type BetterSqliteConstructor = new (path: string) => BetterSqliteDatabase;

/** Lazily resolved `better-sqlite3` constructor. */
let DatabaseConstructor: BetterSqliteConstructor | undefined;

function loadBetterSqlite3(): BetterSqliteConstructor {
  if (DatabaseConstructor) return DatabaseConstructor;

  // This package is ESM (`type: module` in package.json), so the global
  // `require` is not defined. Use `createRequire` from `node:module` to get
  // a CommonJS require for loading the native better-sqlite3 binding.
  const requireFromHere = createRequire(import.meta.url);

  let mod: { default?: BetterSqliteConstructor } & BetterSqliteConstructor;
  try {
    mod = requireFromHere('better-sqlite3') as {
      default?: BetterSqliteConstructor;
    } & BetterSqliteConstructor;
  } catch (error) {
    throw new Error(
      'NodeSQLiteStorage requires the "better-sqlite3" package. ' +
        'Install it with: bun add better-sqlite3 (or npm install better-sqlite3).',
      { cause: error },
    );
  }

  DatabaseConstructor = typeof mod.default === 'function' ? mod.default : mod;
  return DatabaseConstructor;
}

/**
 * Runtime-neutral alias for the Node SQLite adapter. Consumers that import
 * from `weft/storage/sqlite` get this class under Node.
 */
export { NodeSQLiteStorage as SQLiteStorage };

export class NodeSQLiteStorage implements Storage {
  #database: BetterSqliteDatabase;
  #getStatement: BetterSqliteStatement;
  #putStatement: BetterSqliteStatement;
  #deleteStatement: BetterSqliteStatement;
  #batchTransaction: BetterSqliteTransaction;
  #scanStatements: Map<string, BetterSqliteStatement> = new Map();

  /**
   * Number of distinct prepared-statement cache entries for scan().
   * Exposed for regression tests that assert the cache stays bounded.
   */
  get scanStatementCacheSize(): number {
    return this.#scanStatements.size;
  }

  constructor(
    path: string = ':memory:',
    databaseConstructor: BetterSqliteConstructor = loadBetterSqlite3(),
  ) {
    const Database = databaseConstructor;
    this.#database = new Database(path);

    this.#database.pragma('journal_mode = WAL');
    this.#database.pragma('synchronous = NORMAL');
    this.#database.pragma('cache_size = -64000');
    this.#database.pragma('mmap_size = 268435456');
    this.#database.pragma('temp_store = MEMORY');
    this.#database.pragma('wal_autocheckpoint = 10000');

    this.#database.exec(`
      CREATE TABLE IF NOT EXISTS kv (
        key TEXT PRIMARY KEY,
        value BLOB NOT NULL
      ) WITHOUT ROWID
    `);

    this.#getStatement = this.#database.prepare('SELECT value FROM kv WHERE key = ?');
    this.#putStatement = this.#database.prepare(
      'INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
    );
    this.#deleteStatement = this.#database.prepare('DELETE FROM kv WHERE key = ?');
    this.#batchTransaction = this.#database.transaction((entries: unknown) => {
      for (const entry of entries as BatchOperation[]) {
        if (entry.type === 'put') {
          this.#putStatement.run(entry.key, entry.value);
        } else {
          this.#deleteStatement.run(entry.key);
        }
      }
    });
  }

  async get(key: string): Promise<Uint8Array | null> {
    const row = this.#getStatement.get(key);
    if (!row) return null;
    const value = (row as { value: Uint8Array }).value;
    return new Uint8Array(value);
  }

  async put(key: string, value: Uint8Array): Promise<void> {
    this.#putStatement.run(key, value);
  }

  async delete(key: string): Promise<void> {
    this.#deleteStatement.run(key);
  }

  async *scan(prefix: string, options: ScanOptions = {}): AsyncIterable<[string, Uint8Array]> {
    const { limit, reverse, gt, lt, gte, lte } = options;

    const prefixEnd =
      prefix.length > 0
        ? prefix.slice(0, -1) + String.fromCharCode(prefix.charCodeAt(prefix.length - 1) + 1)
        : '\xff';

    const conditions: string[] = ['key >= ? AND key < ?'];
    const parameters: unknown[] = [prefix, prefixEnd];

    if (gt !== undefined) {
      conditions.push('key > ?');
      parameters.push(gt);
    }
    if (gte !== undefined) {
      conditions.push('key >= ?');
      parameters.push(gte);
    }
    if (lt !== undefined) {
      conditions.push('key < ?');
      parameters.push(lt);
    }
    if (lte !== undefined) {
      conditions.push('key <= ?');
      parameters.push(lte);
    }

    const direction = reverse ? 'DESC' : 'ASC';
    const limitClause = limit !== undefined ? 'LIMIT ?' : '';
    if (limit !== undefined) {
      parameters.push(limit);
    }

    const sql = `SELECT key, value FROM kv WHERE ${conditions.join(' AND ')} ORDER BY key ${direction} ${limitClause}`;

    let statement = this.#scanStatements.get(sql);
    if (!statement) {
      statement = this.#database.prepare(sql);
      this.#scanStatements.set(sql, statement);
    }

    const rows = statement.all(...parameters);

    for (const row of rows) {
      const typedRow = row as { key: string; value: Uint8Array };
      yield [typedRow.key, new Uint8Array(typedRow.value)];
    }
  }

  async batch(operations: BatchOperation[]): Promise<void> {
    if (operations.length === 0) return;
    this.#batchTransaction(operations);
  }

  [Symbol.dispose](): void {
    this.#scanStatements.clear();
    this.#database.close();
  }
}
