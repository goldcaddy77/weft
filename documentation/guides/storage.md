# Storage

Every checkpoint, workflow state, signal, and timer in Weft is ultimately a key-value pair written to storage. The storage layer is a thin abstraction---five methods and a dispose hook---that lets you swap backends without touching your workflow code.

## The Storage interface

All storage adapters implement this interface.

```typescript partial
interface Storage extends Disposable {
  get(key: string): Promise<Uint8Array | null>;
  put(key: string, value: Uint8Array): Promise<void>;
  delete(key: string): Promise<void>;
  scan(prefix: string, options?: ScanOptions): AsyncIterable<[string, Uint8Array]>;
  batch(operations: BatchOperation[]): Promise<void>;
}
```

Everything is `Uint8Array` in and out. Weft handles its own serialization (via a CBOR-like codec) before writing to storage, so the adapter never needs to understand the data format. This keeps adapters simple and makes it straightforward to build new ones.

The `scan` method returns an `AsyncIterable` of key-value pairs matching a prefix, with optional bounds and ordering.

```typescript
interface ScanOptions {
  limit?: number;
  reverse?: boolean;
  gt?: string; // greater than
  lt?: string; // less than
  gte?: string; // greater than or equal
  lte?: string; // less than or equal
}
```

The `batch` method writes multiple operations atomically. This is critical for consistency---Weft often needs to update a workflow state and write a checkpoint in a single atomic operation.

```typescript partial
type BatchOperation =
  | { type: 'put'; key: string; value: Uint8Array }
  | { type: 'delete'; key: string };
```

Adapters can also opt into optional methods for performance and feature parity: `conditionalBatch` (atomic compare-and-swap batch), `has` (key existence check), `deletePrefix` (bulk prefix delete), `keys` (key-only scan), `count` (prefix count), `scoped` (namespaced sub-storage), and `query` (SQL passthrough, adapter-specific). Adapters that omit optional methods receive generic fallbacks via wrapper functions (`storageHas`, `storageKeys`, etc.).

## Key layout

Weft encodes structure into hierarchical keys. The `KEYS` constants define the layout.

```
wf:{id}                                       -- workflow state
wf:{id}:ckpt                                  -- latest checkpoint
wf:{id}:ckpt:{step}                           -- checkpoint history
op:{queue}:{scheduled}:{id}                   -- operation (sorted by queue + time)
ev:{workflowId}:{seq}                         -- event (sorted by workflow + sequence)
sig:{workflowId}:{name}:{id}                  -- signal
wf-deadline:{deadline}:{workflowId}           -- timeout deadline
attr:{workflowId}                             -- search attributes
idx:{attrName}:{encodedValue}:{workflowId}    -- secondary index for search
upd:{workflowId}:{updateId}                   -- pending update request
upr:{updateId}                                -- update response
```

This listing covers the primary keys. The full canonical list---including `wf:{id}:timeline:`, `schedule:`, `op:inflight:`, `tag:`, `upk:` (idempotency), `budget:`, `quota:`, `archive:`, `shared:`, `blob:`, and others---is in `KEYS` in `src/storage/interface.ts`.

All timestamps are zero-padded to 16 digits for correct lexicographic ordering. This means `scan("op:default:")` returns all operations on the "default" queue in scheduled order---the core hot path is a single range scan, whether the backend is SQLite or something else entirely.

## SQLiteStorage

This is the default for production persistence. Import `SQLiteStorage` from `weft/storage/sqlite`; export conditions resolve it to `BunSQLiteStorage` under Bun and `NodeSQLiteStorage` under Node.js.

```typescript partial
import { SQLiteStorage } from 'weft/storage/sqlite';

using storage = new SQLiteStorage('./weft.db');
const engine = new Engine({ storage });
```

Use `weft/storage/sqlite/bun` or `weft/storage/sqlite/node` only when you need to force one implementation.

Under the hood, it creates a single `kv` table (`key TEXT PRIMARY KEY, value BLOB NOT NULL`) using `WITHOUT ROWID` for optimal key-value performance. It enables WAL mode, sets `synchronous = NORMAL`, and bumps the cache size---sensible defaults for a write-heavy workload.

`BunSQLiteStorage` also exposes an optional `query()` method for ad-hoc SQL queries, which is invaluable for debugging and building dashboards. `NodeSQLiteStorage` intentionally sticks to the portable `Storage` interface and does not expose SQL passthrough. Import the Bun override when you need SQL passthrough.

```typescript partial
import { BunSQLiteStorage } from 'weft/storage/sqlite/bun';

using storage = new BunSQLiteStorage('./weft.db');
const rows = await storage.query<{ key: string }>('SELECT key FROM kv WHERE key LIKE ?', ['wf:%']);
```

Batch operations run inside a SQLite transaction, so they are atomic. A batch that writes a workflow state and a checkpoint either both succeed or neither does.

## MemoryStorage

For tests, use `MemoryStorage`. It is a `Map<string, Uint8Array>` with the same interface, running entirely in memory. Fast, deterministic, no cleanup needed.

```typescript
import { MemoryStorage, Engine } from 'weft';

const storage = new MemoryStorage();
const engine = new Engine({ storage });
```

It also exposes a few `MemoryStorage`-only conveniences: the `size` getter, `clear()`, and `snapshot()` (returns a deep copy of the internal map). The `has()` and `keys()` methods are part of the optional `Storage` interface and are also available on other adapters.

```typescript partial
expect(storage.size).toBe(2);
expect(storage.has('wf:order-1')).toBe(true);
```

If you do not pass a storage option to the `Engine` constructor, it defaults to `MemoryStorage`---so for quick experiments and tests, you can skip storage configuration entirely.

```typescript partial
const engine = new Engine(); // uses MemoryStorage
```

## IndexedDBStorage

`IndexedDBStorage` is the browser equivalent of `BunSQLiteStorage`. It persists workflow state to IndexedDB, making it suitable for Service Worker deployments where the engine runs entirely inside the browser.

```typescript partial
import { IndexedDBStorage } from 'weft/storage/indexeddb';

using storage = new IndexedDBStorage('weft');
const engine = new Engine({ storage });
```

The constructor takes an optional database name (defaults to `'weft'`). Under the hood, it creates a single `kv` object store with string keys and `Uint8Array` values---the same logical structure as the SQLite `kv` table.

`IndexedDBStorage` implements the full `Storage` interface except for `query()`. IndexedDB has no SQL engine, so raw queries are not available. All other methods---`get`, `put`, `delete`, `scan`, and `batch`---work identically to the other adapters.

The `batch()` method is atomic. All operations in a batch run inside a single IndexedDB transaction, so a batch that writes a workflow state and a checkpoint either both succeeds or neither does.

The `using` pattern works for cleanup: `[Symbol.dispose]()` closes the underlying IndexedDB database connection.

Browser consumers should use browser-safe subpath imports such as `weft/storage/indexeddb` or `weft/storage/web-extension` and avoid server-only storage adapters.

## WebExtensionStorage

`WebExtensionStorage` persists bytes through `browser.storage` or `chrome.storage` in extension contexts. Values are JSON envelopes with base64-encoded `Uint8Array` payloads.

```typescript
import { Engine } from 'weft';
import { WebExtensionStorage } from 'weft/storage/web-extension';

using storage = new WebExtensionStorage({ area: 'local' });
const engine = new Engine({ storage });
void engine;
```

The `area` option accepts `local`, `sync`, `session`, or `managed`. The `managed` area is read-only, and `sync` writes are checked against the storage area's quota before committing.

## HTTPStorage

`HTTPStorage` talks to Weft's storage REST routes for remote storage access.

```typescript
import { HTTPStorage } from 'weft/storage/http';

const token = 'example-token';
using storage = new HTTPStorage({
  baseUrl: 'https://weft.example.com',
  headers: { authorization: `Bearer ${token}` },
});
void storage;
```

Single-value operations use `application/octet-stream`; scans stream NDJSON with base64-encoded values. Conditional batches map to the server-side CAS route.

## resolveStorage()

For runtime-driven backend selection, import `resolveStorage` from `weft/storage` or `weft/storage/resolve`.

```typescript
import { resolveStorage } from 'weft/storage';

const storage = await resolveStorage({ type: 'sqlite', path: './weft.db' });
void storage;
```

## When to consider alternatives

SQLite handles most workloads well (roughly 50K writes/sec in WAL mode, 100K reads/sec). But if you are pushing past 30K workflows per second and need maximum read throughput, consider building an adapter for a memory-mapped store like LMDB. Its zero-copy reads are unbeatable for hot-path operations like task claiming.

The storage interface is intentionally KV-oriented rather than SQL-oriented, so building a new adapter is a matter of implementing five methods and a dispose hook. No ORM, no schema migrations, no query builder---just keys and bytes.
