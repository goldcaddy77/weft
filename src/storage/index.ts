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
// Bun 1.3.13 minifier workaround: pure re-export barrels emit invalid
// JavaScript. See PR #173 for the canonical fix; this branch mirrors it
// because PR #173 isn't merged yet and `verify-tree-shaking.ts` would
// otherwise fail on the broken pristine `dist/storage/index.js`.
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
