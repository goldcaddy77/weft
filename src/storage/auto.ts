/**
 * Runtime-detected default storage backend.
 *
 * Imported via `weft/storage/auto`. Resolves a persistent storage
 * adapter appropriate for the current runtime:
 *
 *   1. Bun → `BunSQLiteStorage`
 *   2. IndexedDB-if-present (over Node, for Electron / jsdom) → `IndexedDBStorage`
 *   3. Node → `NodeSQLiteStorage`
 *   4. otherwise → throw
 *
 * Path policy for SQLite branches:
 *   - `process.env.WEFT_DEFAULT_STORAGE_PATH` if set
 *   - else `${tmpdir()}/weft-default/<cwd-hash>.db`
 *
 * The parent directory is created (recursive) before the path is returned.
 *
 * `resolveDefaultStorage()` is for developer convenience. Production
 * deployments should pick an explicit adapter and pass it to
 * `new Engine({ storage })`.
 *
 * Imported only when needed — service-worker and other browser bundles
 * never reach into this module's Node/Bun-only code paths because they
 * never import `weft/storage/auto`.
 *
 * @module weft/storage/auto
 */

import * as nodeCrypto from 'node:crypto';
import * as nodeFs from 'node:fs';
import * as nodeOs from 'node:os';
import * as nodePath from 'node:path';

import type { Storage as WeftStorage } from './interface.ts';

interface DetectionGlobals {
  hasBun: boolean;
  hasNode: boolean;
  hasIndexedDB: boolean;
}

function detectGlobals(): DetectionGlobals {
  return {
    hasBun: typeof (globalThis as { Bun?: unknown }).Bun !== 'undefined',
    hasNode:
      typeof process !== 'undefined' &&
      typeof (process as { versions?: { node?: unknown } }).versions?.node === 'string',
    hasIndexedDB: typeof (globalThis as { indexedDB?: unknown }).indexedDB !== 'undefined',
  };
}

function projectStorageHash(): string {
  const cwd = typeof process !== 'undefined' ? process.cwd() : 'weft-default';
  return nodeCrypto.createHash('sha256').update(cwd).digest('hex').slice(0, 16);
}

function defaultSqlitePath(): string {
  const override =
    typeof process !== 'undefined' ? process.env['WEFT_DEFAULT_STORAGE_PATH'] : undefined;
  const path =
    override !== undefined && override.length > 0
      ? override
      : nodePath.join(nodeOs.tmpdir(), 'weft-default', `${projectStorageHash()}.db`);
  nodeFs.mkdirSync(nodePath.dirname(path), { recursive: true });
  return path;
}

/**
 * Resolve a runtime-appropriate persistent storage adapter.
 *
 * @param overrides - Test hook. Production callers leave this undefined.
 *
 * @example
 * ```ts
 * import { Engine } from 'weft';
 * import { resolveDefaultStorage } from 'weft/storage/auto';
 *
 * await using storage = await resolveDefaultStorage();
 * await using engine = new Engine({ storage });
 * void engine;
 * ```
 */
export async function resolveDefaultStorage(
  overrides?: Partial<DetectionGlobals>,
): Promise<WeftStorage> {
  const detected = { ...detectGlobals(), ...overrides };

  if (detected.hasBun) {
    const { BunSQLiteStorage } = await import('./bun-sql.ts');
    return new BunSQLiteStorage(defaultSqlitePath());
  }

  if (detected.hasIndexedDB) {
    // IndexedDB wins over Node when both are present (Electron / jsdom).
    const { IndexedDBStorage } = await import('./indexeddb.ts');
    return new IndexedDBStorage('weft');
  }

  if (detected.hasNode) {
    const { NodeSQLiteStorage } = await import('./node-sqlite.ts');
    return new NodeSQLiteStorage(defaultSqlitePath());
  }

  throw new Error(
    'resolveDefaultStorage: could not auto-detect a storage backend. ' +
      'Checked globals: ' +
      `typeof Bun=${detected.hasBun ? 'object' : 'undefined'}, ` +
      `typeof process=${detected.hasNode ? 'object' : 'undefined'}, ` +
      `typeof indexedDB=${detected.hasIndexedDB ? 'object' : 'undefined'}. ` +
      'Pass `storage` explicitly to `new Engine({ storage })`.',
  );
}
