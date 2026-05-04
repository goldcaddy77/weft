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
// Bun 1.3.13 minifier workaround: pure re-export barrels
// (`export { X } from './m'`) emit invalid JavaScript with undeclared
// identifiers in `dist/`. Loading the bundle from Node throws
// `Export 'B' is not defined in module`. Rebinding each value to a
// local const before re-exporting forces the bundler to keep the
// reference live. Mirrors the same workaround in `src/testing/index.ts`.
// Remove this workaround once Bun ships the fix and CI proves a clean
// build with direct re-exports.
import { KEYS, storageConditionalBatch, storageValuesEqual } from './interface';
import { MemoryStorage } from './memory';
import { ScopedStorage, scopedStorage } from './scoped-storage';
import { jsonCodec, msgpackCodec, withCodec } from './typed-storage';

const exportedJsonCodec = jsonCodec;
const exportedKeys = KEYS;
const exportedMemoryStorage = MemoryStorage;
const exportedMsgpackCodec = msgpackCodec;
const exportedScopedStorage = ScopedStorage;
const exportedScopedStorageFactory = scopedStorage;
const exportedStorageConditionalBatch = storageConditionalBatch;
const exportedStorageValuesEqual = storageValuesEqual;
const exportedWithCodec = withCodec;

export type { BatchOperation, ConditionalBatchCondition, ScanOptions, Storage } from './interface';
export type {
  JsonValue,
  MessagePackValue,
  StorageCodec,
  StorageValueParser,
  TypedBatchOperation,
  TypedStorage,
} from './typed-storage';
export {
  exportedJsonCodec as jsonCodec,
  exportedKeys as KEYS,
  exportedMemoryStorage as MemoryStorage,
  exportedMsgpackCodec as msgpackCodec,
  exportedScopedStorage as ScopedStorage,
  exportedScopedStorageFactory as scopedStorage,
  exportedStorageConditionalBatch as storageConditionalBatch,
  exportedStorageValuesEqual as storageValuesEqual,
  exportedWithCodec as withCodec,
};
