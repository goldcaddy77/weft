import type { BunSQLiteStorage } from './bun-sql.ts';
import type { NodeSQLiteStorage } from './node-sqlite.ts';

/**
 * Runtime-specific SQLite storage instance resolved from `weft/storage/sqlite`.
 *
 * @example
 * ```ts
 * import { SQLiteStorage, type SQLiteStorageInstance } from 'weft/storage/sqlite';
 *
 * const storage: SQLiteStorageInstance = new SQLiteStorage('./weft.db');
 * void storage;
 * ```
 */
export type SQLiteStorageInstance = BunSQLiteStorage | NodeSQLiteStorage;

/**
 * Runtime-neutral SQLite storage constructor.
 *
 * The `weft/storage/sqlite` package export resolves this symbol to
 * `BunSQLiteStorage` under Bun and `NodeSQLiteStorage` under Node.js.
 *
 * @example
 * ```ts
 * import { SQLiteStorage } from 'weft/storage/sqlite';
 *
 * await using storage = new SQLiteStorage('./weft.db');
 * void storage;
 * ```
 */
export declare const SQLiteStorage: {
  new (path?: string): SQLiteStorageInstance;
};
