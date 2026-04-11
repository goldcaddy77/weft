function normalizeSql(sql: string): string {
  return sql
    .trim()
    .replace(/;+\s*$/u, '')
    .trim();
}

function isReadOnlyPragma(sql: string): boolean {
  return !sql.includes('=');
}

export function assertReadOnlyQuery(sql: string): void {
  const normalizedSql = normalizeSql(sql);

  if (normalizedSql.length === 0) {
    throw new Error('Storage query must not be empty.');
  }

  if (normalizedSql.includes(';')) {
    throw new Error('Storage query must contain exactly one read-only statement.');
  }

  const uppercaseSql = normalizedSql.toUpperCase();

  if (uppercaseSql.startsWith('SELECT ')) {
    return;
  }

  if (uppercaseSql.startsWith('PRAGMA ') && isReadOnlyPragma(normalizedSql)) {
    return;
  }

  throw new Error('Storage query only supports read-only SELECT and PRAGMA statements.');
}
