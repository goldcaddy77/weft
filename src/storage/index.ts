/**
 * Storage submodule — zero-native-dependency entry point.
 *
 * Exports the `Storage` interface, `KEYS` key-encoding helpers,
 * and `MemoryStorage`. These have no native dependencies and are
 * safe to import in any environment including browsers.
 *
 * For backends or wrappers that have runtime dependencies, use the
 * per-backend subpaths:
 *
 * ```ts
 * import { CompressedStorage } from 'weft/storage/compressed'; // requires node:zlib / Bun
 * import { BunSQLiteStorage }  from 'weft/storage/bun-sqlite'; // requires bun:sqlite
 * import { LMDBStorage }       from 'weft/storage/lmdb';       // peer: lmdb
 * import { TursoStorage }      from 'weft/storage/turso';      // peer: @libsql/client
 * import { IndexedDBStorage }  from 'weft/storage/indexeddb';  // browser-only
 * ```
 *
 * @module weft/storage
 */
export {
  KEYS,
  matchesScanOptions,
  resolvePrefixRangeEnd,
  storageCount,
  storageDeletePrefix,
  storageHas,
  storageKeys,
} from './interface';
export type { BatchOperation, ScanOptions, Storage } from './interface';
export { MemoryStorage } from './memory';
export { ScopedStorage, scopedStorage } from './scoped-storage';
export { jsonCodec, msgpackCodec, withCodec } from './typed-storage';
export type {
  StorageCodec,
  StorageValueParser,
  TypedBatchOperation,
  TypedStorage,
} from './typed-storage';
