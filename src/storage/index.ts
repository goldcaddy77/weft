/**
 * Storage submodule — zero-native-dependency entry point.
 *
 * Exports the `Storage` interface, `KEYS` key-encoding helpers,
 * `MemoryStorage`, and `CompressedStorage`. These have no native
 * dependencies and are safe to import in any environment.
 *
 * For backends that require optional peer dependencies, use the
 * per-backend subpaths:
 *
 * ```ts
 * import { BunSQLiteStorage } from 'weft/storage/bun-sqlite';
 * import { LMDBStorage } from 'weft/storage/lmdb';        // peer: lmdb
 * import { TursoStorage } from 'weft/storage/turso';      // peer: @libsql/client
 * import { IndexedDBStorage } from 'weft/storage/indexeddb'; // browser-only
 * ```
 *
 * @module weft/storage
 */
export { CompressedStorage } from './compressed-storage';
export { KEYS } from './interface';
export type { BatchOperation, ScanOptions, Storage } from './interface';
export { MemoryStorage } from './memory';
