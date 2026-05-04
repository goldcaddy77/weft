import { describe, expect, it } from 'bun:test';

import packageJson from '../../package.json';

describe('storage package exports', () => {
  it('does not expose the legacy Bun SQLite subpath', () => {
    expect(Object.hasOwn(packageJson.exports, './storage/bun-sqlite')).toBe(false);
  });

  it('exposes a unified SQLite type surface with runtime-specific implementations', () => {
    const sqliteExport = packageJson.exports['./storage/sqlite'];

    expect(sqliteExport).toMatchObject({
      types: './dist/storage/sqlite.d.ts',
      bun: './dist/storage/bun-sql.js',
      node: './dist/storage/node-sqlite.js',
    });
  });

  it('exposes explicit SQLite runtime override subpaths to standard ESM importers', () => {
    expect(packageJson.exports['./storage/sqlite/bun']).toMatchObject({
      types: './dist/storage/bun-sql.d.ts',
      bun: './dist/storage/bun-sql.js',
      import: './dist/storage/bun-sql.js',
      default: './dist/storage/bun-sql.js',
    });
    expect(packageJson.exports['./storage/sqlite/node']).toMatchObject({
      types: './dist/storage/node-sqlite.d.ts',
      node: './dist/storage/node-sqlite.js',
      import: './dist/storage/node-sqlite.js',
      default: './dist/storage/node-sqlite.js',
    });
  });

  it('exposes WebExtension, HTTP, and resolve storage subpaths', () => {
    expect(Object.hasOwn(packageJson.exports, './storage/web-extension')).toBe(true);
    expect(Object.hasOwn(packageJson.exports, './storage/http')).toBe(true);
    expect(Object.hasOwn(packageJson.exports, './storage/resolve')).toBe(true);
  });
});
