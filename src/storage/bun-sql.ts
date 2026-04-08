import { Database, Statement, type SQLQueryBindings } from 'bun:sqlite';

import type { BatchOperation, ScanOptions, Storage } from './interface';

export class BunSQLiteStorage implements Storage {
  #database: Database;
  // Prepared statements are cached on the instance so the hot paths (get,
  // put, batch) never pay `prepare()` cost after construction. This matters:
  // the start/complete benchmarks make 2-3 storage calls per workflow, and
  // re-preparing the same SQL on every call drops throughput by roughly 2x.
  #getStatement: Statement<{ value: Uint8Array }, [string]>;
  #putStatement: Statement<unknown, [string, Uint8Array]>;
  #deleteStatement: Statement<unknown, [string]>;
  #batchTransaction: (entries: BatchOperation[]) => void;
  // Cache prepared statements for scan() keyed by the fully-built SQL string.
  // The set of SQL variants is finite (bounded by the combinations of
  // gt/gte/lt/lte/reverse/limit), so an unbounded Map is acceptable here and
  // avoids leaking a compiled statement on every call. bun:sqlite tracks live
  // statements on the database and refuses to close while any are
  // outstanding, so we finalize every cached entry in [Symbol.dispose].
  #scanStatements: Map<string, Statement<{ key: string; value: Uint8Array }, SQLQueryBindings[]>> =
    new Map();

  constructor(path: string = ':memory:') {
    this.#database = new Database(path);

    this.#database.exec('PRAGMA journal_mode = WAL');
    this.#database.exec('PRAGMA synchronous = NORMAL');
    this.#database.exec('PRAGMA cache_size = -64000');
    this.#database.exec('PRAGMA mmap_size = 268435456');
    this.#database.exec('PRAGMA temp_store = MEMORY');
    this.#database.exec('PRAGMA wal_autocheckpoint = 10000');

    this.#database.exec(`
      CREATE TABLE IF NOT EXISTS kv (
        key TEXT PRIMARY KEY,
        value BLOB NOT NULL
      ) WITHOUT ROWID
    `);

    this.#getStatement = this.#database.prepare<{ value: Uint8Array }, [string]>(
      'SELECT value FROM kv WHERE key = ?',
    );
    this.#putStatement = this.#database.prepare<unknown, [string, Uint8Array]>(
      'INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
    );
    this.#deleteStatement = this.#database.prepare<unknown, [string]>(
      'DELETE FROM kv WHERE key = ?',
    );
    // Build the transaction wrapper once; bun:sqlite memoizes the compiled
    // transaction so subsequent calls just run the prepared statements.
    this.#batchTransaction = this.#database.transaction((entries: BatchOperation[]) => {
      for (const entry of entries) {
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
    // bun:sqlite may return a Buffer; ensure we return a proper Uint8Array.
    return new Uint8Array(row.value);
  }

  async put(key: string, value: Uint8Array): Promise<void> {
    this.#putStatement.run(key, value);
  }

  async delete(key: string): Promise<void> {
    this.#deleteStatement.run(key);
  }

  async *scan(prefix: string, options: ScanOptions = {}): AsyncIterable<[string, Uint8Array]> {
    const { limit, reverse, gt, lt, gte, lte } = options;

    // Compute the exclusive upper bound for the prefix range, same as MemoryStorage.
    // When prefix is empty, use '\xff' to match all keys since all valid string keys sort before it.
    const prefixEnd =
      prefix.length > 0
        ? prefix.slice(0, -1) + String.fromCharCode(prefix.charCodeAt(prefix.length - 1) + 1)
        : '\xff';

    const conditions: string[] = ['key >= ? AND key < ?'];
    const parameters: SQLQueryBindings[] = [prefix, prefixEnd];

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
    const limitClause = limit !== undefined ? `LIMIT ${limit}` : '';

    const sql = `SELECT key, value FROM kv WHERE ${conditions.join(' AND ')} ORDER BY key ${direction} ${limitClause}`;

    let statement = this.#scanStatements.get(sql);
    if (!statement) {
      statement = this.#database.prepare<{ key: string; value: Uint8Array }, SQLQueryBindings[]>(
        sql,
      );
      this.#scanStatements.set(sql, statement);
    }

    const rows = statement.all(...parameters);

    for (const row of rows) {
      yield [row.key, new Uint8Array(row.value)];
    }
  }

  async batch(operations: BatchOperation[]): Promise<void> {
    if (operations.length === 0) return;
    this.#batchTransaction(operations);
  }

  async query<T>(sql: string, parameters?: SQLQueryBindings[]): Promise<T[]> {
    // query() accepts arbitrary caller-supplied SQL, so caching is not safe
    // (the set of distinct strings is unbounded). Finalize the statement
    // explicitly — bun:sqlite tracks live statements on the database handle
    // and refuses to close while any are outstanding.
    const statement = this.#database.prepare<T, SQLQueryBindings[]>(sql);
    try {
      return statement.all(...(parameters ?? []));
    } finally {
      statement.finalize();
    }
  }

  [Symbol.dispose](): void {
    // Finalize cached statements before closing — bun:sqlite tracks live
    // statements on the database and refuses to close while any are
    // outstanding. Finalizing also ensures subsequent get/put calls throw
    // synchronously instead of silently no-oping against a freed DB handle.
    this.#getStatement.finalize();
    this.#putStatement.finalize();
    this.#deleteStatement.finalize();
    for (const statement of this.#scanStatements.values()) {
      statement.finalize();
    }
    this.#scanStatements.clear();
    // database.close() finalizes any remaining compiled statements including the
    // internal BEGIN/COMMIT/ROLLBACK statements created by database.transaction().
    // We close after finalizing named statements so their handles are released
    // explicitly, giving bun:sqlite a clean shutdown path.
    this.#database.close();
  }
}
