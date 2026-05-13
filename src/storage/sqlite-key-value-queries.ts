import { resolvePrefixRangeEnd, type ScanOptions } from './interface';

export const SQLITE_CREATE_KEY_VALUE_TABLE = `CREATE TABLE IF NOT EXISTS kv (
  key TEXT PRIMARY KEY,
  value BLOB NOT NULL
) WITHOUT ROWID`;

export const SQLITE_SELECT_VALUE_BY_KEY = 'SELECT value FROM kv WHERE key = ?';

export const SQLITE_UPSERT_VALUE_BY_KEY =
  'INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value';

export const SQLITE_DELETE_VALUE_BY_KEY = 'DELETE FROM kv WHERE key = ?';

export const SQLITE_SELECT_KEY_PRESENCE = 'SELECT 1 AS present FROM kv WHERE key = ? LIMIT 1';

export const SQLITE_COUNT_KEYS_BY_PREFIX =
  'SELECT COUNT(*) AS count FROM kv WHERE key >= ? AND key < ?';

export const SQLITE_DELETE_KEYS_BY_PREFIX = 'DELETE FROM kv WHERE key >= ? AND key < ?';

export type SqliteKeyRangeQueryParameter = string | number;

export type SqliteKeyRangeQuery = {
  parameters: SqliteKeyRangeQueryParameter[];
  sqlSuffix: string;
};

export type SqliteRangeSelectQuery = {
  parameters: SqliteKeyRangeQueryParameter[];
  sql: string;
};

export function buildSqlitePrefixRangeParameters(prefix: string): [string, string] {
  return [prefix, resolvePrefixRangeEnd(prefix)];
}

export function buildSqliteKeyRangeQuery(
  prefix: string,
  options: ScanOptions = {},
): SqliteKeyRangeQuery {
  const { limit, reverse, gt, lt, gte, lte } = options;

  const conditions: string[] = ['key >= ? AND key < ?'];
  const parameters: SqliteKeyRangeQueryParameter[] = buildSqlitePrefixRangeParameters(prefix);

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

export function buildSqliteKeyValueRangeSelect(
  prefix: string,
  options: ScanOptions = {},
): SqliteRangeSelectQuery {
  const { parameters, sqlSuffix } = buildSqliteKeyRangeQuery(prefix, options);
  return {
    parameters,
    sql: `SELECT key, value FROM kv ${sqlSuffix}`,
  };
}

export function buildSqliteKeyRangeSelect(
  prefix: string,
  options: ScanOptions = {},
): SqliteRangeSelectQuery {
  const { parameters, sqlSuffix } = buildSqliteKeyRangeQuery(prefix, options);
  return {
    parameters,
    sql: `SELECT key FROM kv ${sqlSuffix}`,
  };
}
