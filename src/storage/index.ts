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
 * import { SQLiteStorage }     from 'weft/storage/sqlite';     // Bun or Node SQLite
 * import { LMDBStorage }       from 'weft/storage/lmdb';       // peer: lmdb
 * import { TursoStorage }      from 'weft/storage/turso';      // peer: @libsql/client
 * import { IndexedDBStorage }  from 'weft/storage/indexeddb';  // browser-only
 * import { WebExtensionStorage } from 'weft/storage/web-extension'; // extension-only
 * import { HTTPStorage }       from 'weft/storage/http';       // remote storage
 * ```
 *
 * @module weft/storage
 */
import { KEYS, storageConditionalBatch, storageValuesEqual } from './interface';
import { MemoryStorage } from './memory';
import { resolveStorage } from './resolve';
import { ScopedStorage, scopedStorage } from './scoped-storage';
import { jsonCodec, msgpackCodec, withCodec } from './typed-storage';

export type { BatchOperation, ConditionalBatchCondition, ScanOptions, Storage } from './interface';
export type { StorageConfiguration } from './resolve';
export type {
  JsonValue,
  MessagePackValue,
  StorageCodec,
  StorageValueParser,
  TypedBatchOperation,
  TypedStorage,
} from './typed-storage';

export {
  jsonCodec,
  KEYS,
  MemoryStorage,
  msgpackCodec,
  resolveStorage,
  ScopedStorage,
  scopedStorage,
  storageConditionalBatch,
  storageValuesEqual,
  withCodec,
};
