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
      import: './dist/storage/node-sqlite.js',
      default: './dist/storage/node-sqlite.js',
    });
  });

  it('keeps explicit SQLite runtime override subpaths runtime-specific', () => {
    expect(packageJson.exports['./storage/sqlite/bun']).toEqual({
      types: './dist/storage/bun-sql.d.ts',
      bun: './dist/storage/bun-sql.js',
    });
    expect(packageJson.exports['./storage/sqlite/node']).toEqual({
      types: './dist/storage/node-sqlite.d.ts',
      node: './dist/storage/node-sqlite.js',
    });
  });

  it('exposes WebExtension, HTTP, and resolve storage subpaths', () => {
    expect(Object.hasOwn(packageJson.exports, './storage/web-extension')).toBe(true);
    expect(Object.hasOwn(packageJson.exports, './storage/http')).toBe(true);
    expect(Object.hasOwn(packageJson.exports, './storage/resolve')).toBe(true);
  });

  it('exposes the RemoteWorker protocol contract as a package subpath', () => {
    expect(packageJson.exports['./worker-protocol']).toEqual({
      types: './dist/worker/protocol.d.ts',
      bun: './dist/worker/protocol.js',
      import: './dist/worker/protocol.js',
      default: './dist/worker/protocol.js',
    });
  });
});
