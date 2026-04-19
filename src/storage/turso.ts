import { createClient, type Client, type InValue } from '@libsql/client';

import {
  resolvePrefixRangeEnd,
  storageValuesEqual,
  type BatchOperation,
  type ConditionalBatchCondition,
  type ScanOptions,
  type Storage,
} from './interface';
import { assertReadOnlyQuery } from './read-only-query';
import { scopedStorage } from './scoped-storage';

/** Configuration for connecting to a Turso/libSQL database. */
export type TursoStorageOptions = {
  /** The database URL (e.g., `libsql://your-db.turso.io`, `file:local.db`, `file::memory:`). */
  url: string;
  /** Authentication token for remote Turso databases. */
  authToken?: string;
};

const TABLE_INIT = `CREATE TABLE IF NOT EXISTS kv (
  key TEXT PRIMARY KEY,
  value BLOB NOT NULL
) WITHOUT ROWID;`;

/**
 * Storage adapter backed by Turso/libSQL for distributed SQLite deployments.
 *
 * Implements the same `Storage` interface as `BunSQLiteStorage`, but uses `@libsql/client`
 * so the database can be a remote Turso instance, an embedded replica, or a local file.
 * Switch from `BunSQLiteStorage` to `TursoStorage` by changing the connection string —
 * the rest of the application stays the same.
 */
export class TursoStorage implements Storage {
  #client: Client;
  #initialized = false;

  constructor(options: TursoStorageOptions) {
    this.#client = createClient(
      options.authToken ? { url: options.url, authToken: options.authToken } : { url: options.url },
    );
  }

  async #ensureTable(): Promise<void> {
    if (this.#initialized) return;
    await this.#client.executeMultiple(TABLE_INIT);
    this.#initialized = true;
  }

  async get(key: string): Promise<Uint8Array | null> {
    await this.#ensureTable();

    const result = await this.#client.execute({
      sql: 'SELECT value FROM kv WHERE key = ?',
      args: [key],
    });

    if (result.rows.length === 0) return null;

    const raw = result.rows[0]!['value'] as unknown;
    if (raw === null || raw === undefined) return null;
    return new Uint8Array(raw as ArrayBuffer);
  }

  async put(key: string, value: Uint8Array): Promise<void> {
    await this.#ensureTable();

    await this.#client.execute({
      sql: 'INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
      args: [key, value],
    });
  }

  async delete(key: string): Promise<void> {
    await this.#ensureTable();

    await this.#client.execute({
      sql: 'DELETE FROM kv WHERE key = ?',
      args: [key],
    });
  }

  async has(key: string): Promise<boolean> {
    await this.#ensureTable();

    const result = await this.#client.execute({
      sql: 'SELECT 1 AS present FROM kv WHERE key = ? LIMIT 1',
      args: [key],
    });

    return result.rows.length > 0;
  }

  async deletePrefix(prefix: string): Promise<number> {
    await this.#ensureTable();

    const prefixEnd = resolvePrefixRangeEnd(prefix);
    const result = await this.#client.execute({
      sql: 'DELETE FROM kv WHERE key >= ? AND key < ?',
      args: [prefix, prefixEnd],
    });

    return result.rowsAffected;
  }

  #buildRangeQuery(
    prefix: string,
    options: ScanOptions = {},
  ): {
    parameters: InValue[];
    sqlSuffix: string;
  } {
    const { limit, reverse, gt, lt, gte, lte } = options;
    const prefixEnd = resolvePrefixRangeEnd(prefix);

    const conditions: string[] = ['key >= ? AND key < ?'];
    const parameters: InValue[] = [prefix, prefixEnd];

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
    const limitClause = limit !== undefined ? ' LIMIT ?' : '';
    if (limit !== undefined) {
      parameters.push(limit);
    }

    return {
      parameters,
      sqlSuffix: `WHERE ${conditions.join(' AND ')} ORDER BY key ${direction}${limitClause}`,
    };
  }

  async *scan(prefix: string, options: ScanOptions = {}): AsyncIterable<[string, Uint8Array]> {
    await this.#ensureTable();

    const { parameters, sqlSuffix } = this.#buildRangeQuery(prefix, options);
    const result = await this.#client.execute({
      sql: `SELECT key, value FROM kv ${sqlSuffix}`,
      args: parameters,
    });

    for (const row of result.rows) {
      const key = row['key'] as string;
      const raw = row['value'] as unknown;
      const value = new Uint8Array(raw as ArrayBuffer);
      yield [key, value];
    }
  }

  async *keys(prefix: string, options: ScanOptions = {}): AsyncIterable<string> {
    await this.#ensureTable();

    const { parameters, sqlSuffix } = this.#buildRangeQuery(prefix, options);
    const result = await this.#client.execute({
      sql: `SELECT key FROM kv ${sqlSuffix}`,
      args: parameters,
    });

    for (const row of result.rows) {
      yield row['key'] as string;
    }
  }

  async count(prefix: string): Promise<number> {
    await this.#ensureTable();

    const prefixEnd = resolvePrefixRangeEnd(prefix);
    const result = await this.#client.execute({
      sql: 'SELECT COUNT(*) AS count FROM kv WHERE key >= ? AND key < ?',
      args: [prefix, prefixEnd],
    });

    return Number(result.rows[0]?.['count'] ?? 0);
  }

  scoped(prefix: string): Storage {
    const scoped = scopedStorage(this, prefix);
    return scoped;
  }

  async batch(operations: BatchOperation[]): Promise<void> {
    if (operations.length === 0) return;

    await this.#ensureTable();

    const statements = operations.map((operation) => {
      if (operation.type === 'put') {
        return {
          sql: 'INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
          args: [operation.key, operation.value] as InValue[],
        };
      }
      return {
        sql: 'DELETE FROM kv WHERE key = ?',
        args: [operation.key] as InValue[],
      };
    });

    await this.#client.batch(statements, 'write');
  }

  async conditionalBatch(
    conditions: ConditionalBatchCondition[],
    operations: BatchOperation[],
  ): Promise<boolean> {
    await this.#ensureTable();

    const transaction = await this.#client.transaction('write');
    try {
      await transaction.executeMultiple(TABLE_INIT);

      for (const condition of conditions) {
        const result = await transaction.execute({
          sql: 'SELECT value FROM kv WHERE key = ?',
          args: [condition.key],
        });

        const raw = result.rows[0]?.['value'] as unknown;
        const currentValue =
          raw === null || raw === undefined ? null : new Uint8Array(raw as ArrayBuffer);
        if (!storageValuesEqual(currentValue, condition.expectedValue)) {
          await transaction.rollback();
          return false;
        }
      }

      for (const operation of operations) {
        if (operation.type === 'put') {
          await transaction.execute({
            sql: 'INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
            args: [operation.key, operation.value],
          });
        } else {
          await transaction.execute({
            sql: 'DELETE FROM kv WHERE key = ?',
            args: [operation.key],
          });
        }
      }

      await transaction.commit();
      return true;
    } catch (error) {
      try {
        await transaction.rollback();
      } catch {
        // Best-effort rollback; preserve the original failure.
      }
      throw error;
    }
  }

  async query<T>(sql: string, parameters?: unknown[]): Promise<T[]> {
    await this.#ensureTable();
    assertReadOnlyQuery(sql);

    const result = await this.#client.execute({
      sql,
      args: (parameters ?? []) as InValue[],
    });

    return result.rows as unknown as T[];
  }

  [Symbol.dispose](): void {
    this.#client.close();
  }
}
