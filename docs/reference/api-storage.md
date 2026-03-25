# Storage API

Weft's storage layer is a key-value interface with ordered range scans and atomic batch writes. Two implementations ship out of the box: `BunSQLiteStorage` for production persistence and `MemoryStorage` for tests and ephemeral workloads. All storage adapters implement the `Storage` interface.

## `Storage` Interface

```ts
interface Storage extends Disposable {
  get(key: string): Promise<Uint8Array | null>;
  put(key: string, value: Uint8Array): Promise<void>;
  delete(key: string): Promise<void>;
  scan(prefix: string, options?: ScanOptions): AsyncIterable<[string, Uint8Array]>;
  batch(operations: BatchOperation[]): Promise<void>;
  query?<T>(sql: string, params?: unknown[]): Promise<T[]>;
}
```

### `get()`

```ts
get(key: string): Promise<Uint8Array | null>
```

Retrieve a value by exact key. Returns `null` if the key does not exist.

### `put()`

```ts
put(key: string, value: Uint8Array): Promise<void>
```

Write a key-value pair. Overwrites any existing value at the same key.

### `delete()`

```ts
delete(key: string): Promise<void>
```

Remove a key-value pair. No-op if the key does not exist.

### `scan()`

```ts
scan(prefix: string, options?: ScanOptions): AsyncIterable<[string, Uint8Array]>
```

Iterate over all key-value pairs whose keys start with `prefix`, in lexicographic order. Returns an async iterable of `[key, value]` tuples.

### `batch()`

```ts
batch(operations: BatchOperation[]): Promise<void>
```

Execute multiple put/delete operations atomically. In `BunSQLiteStorage`, this runs inside a SQLite transaction.

### `query()` (optional)

```ts
query?<T>(sql: string, params?: unknown[]): Promise<T[]>
```

Raw SQL passthrough. Only available on `BunSQLiteStorage`. Useful for dashboard queries and debugging.

### `[Symbol.dispose]()`

All storage adapters implement `Disposable`. For `BunSQLiteStorage`, this closes the database. For `MemoryStorage`, this clears the in-memory map.

---

## Types

### `BatchOperation`

```ts
type BatchOperation =
  | { type: 'put'; key: string; value: Uint8Array }
  | { type: 'delete'; key: string };
```

### `ScanOptions`

```ts
interface ScanOptions {
  limit?: number;
  reverse?: boolean;
  gt?: string;
  lt?: string;
  gte?: string;
  lte?: string;
}
```

| Field     | Type      | Description                            |
| --------- | --------- | -------------------------------------- |
| `limit`   | `number`  | Maximum number of entries to return    |
| `reverse` | `boolean` | Iterate in reverse lexicographic order |
| `gt`      | `string`  | Exclusive lower bound on key           |
| `lt`      | `string`  | Exclusive upper bound on key           |
| `gte`     | `string`  | Inclusive lower bound on key           |
| `lte`     | `string`  | Inclusive upper bound on key           |

---

## `KEYS`

```ts
const KEYS: {
  workflow: (id: string) => string;
  checkpoint: (id: string) => string;
  checkpointHistory: (id: string, step: number) => string;
  operation: (queue: string, scheduledAt: number, id: string) => string;
  operationInflight: (id: string) => string;
  event: (workflowId: string, sequence: number) => string;
  signal: (workflowId: string, name: string, id: string) => string;
  deadline: (deadline: number, workflowId: string) => string;
  attribute: (workflowId: string) => string;
  attributeIndex: (attributeName: string, encodedValue: string, workflowId: string) => string;
  update: (workflowId: string, updateId: string) => string;
  updateResponse: (updateId: string) => string;
  updateIdempotency: (workflowId: string, key: string) => string;
  budget: (namespace: string, period: string, date: string) => string;
  review: (workflowId: string, reviewId: string) => string;
  archive: (workflowId: string, key: string) => string;
  sharedState: (workflowId: string, stateKey: string) => string;
  sharedStateVersion: (workflowId: string, stateKey: string) => string;
};
```

Key layout constants for hierarchical key encoding. All timestamps are zero-padded to 16 digits for correct lexicographic ordering. The `KEYS` object is the canonical source for key construction -- never hand-build keys.

```ts
import { KEYS } from 'weft';

const key = KEYS.workflow('my-workflow-id');
// => "wf:my-workflow-id"

const signalKey = KEYS.signal('wf-123', 'approval', 'sig-456');
// => "sig:wf-123:approval:sig-456"
```

---

## `BunSQLiteStorage`

```ts
class BunSQLiteStorage implements Storage
```

SQLite-backed storage using Bun's native `bun:sqlite` module. Suitable for production single-node deployments. Uses WAL journal mode and aggressive cache settings for performance.

### Constructor

```ts
new BunSQLiteStorage(path?: string)
```

| Parameter | Type     | Default      | Description                                                                    |
| --------- | -------- | ------------ | ------------------------------------------------------------------------------ |
| `path`    | `string` | `':memory:'` | File path for the SQLite database. Use `':memory:'` for an in-memory database. |

The constructor automatically creates the `kv` table if it does not exist and configures SQLite pragmas:

- `journal_mode = WAL`
- `synchronous = NORMAL`
- `cache_size = -64000` (64 MB)

```ts
import { BunSQLiteStorage } from 'weft';

const storage = new BunSQLiteStorage('./data/weft.db');
```

### Methods

All methods from the `Storage` interface, plus:

#### `query()`

```ts
async query<T>(sql: string, parameters?: SQLQueryBindings[]): Promise<T[]>
```

Execute raw SQL against the underlying database. Returns all matching rows.

```ts
const rows = await storage.query<{ key: string }>('SELECT key FROM kv WHERE key LIKE ?', ['wf:%']);
```

#### `[Symbol.dispose]()`

Closes the SQLite database connection.

---

## `MemoryStorage`

```ts
class MemoryStorage implements Storage
```

In-memory storage backed by a `Map<string, Uint8Array>`. Ideal for tests, development, and short-lived workflows that do not need persistence.

### Constructor

```ts
new MemoryStorage();
```

No configuration needed.

### Methods

All methods from the `Storage` interface, plus:

#### `size` (getter)

```ts
get size(): number
```

Number of entries currently stored.

#### `clear()`

```ts
clear(): void
```

Remove all entries.

#### `has()`

```ts
has(key: string): boolean
```

Check whether a key exists.

#### `keys()`

```ts
keys(): string[]
```

Return all keys in sorted lexicographic order.

#### `snapshot()`

```ts
snapshot(): Map<string, Uint8Array>
```

Return a deep copy of all stored data. Useful for test assertions and engine recovery simulations.

#### `[Symbol.dispose]()`

Clears all stored data.

---

## `IndexedDBStorage`

```ts
class IndexedDBStorage implements Storage
```

IndexedDB-backed storage for browser environments. Uses a single `kv` object store with string keys and `Uint8Array` values. Suitable for Service Worker deployments where the engine runs entirely in the browser.

```ts
import { IndexedDBStorage } from 'weft/storage/indexeddb';
```

Browser consumers must use the subpath import `weft/storage/indexeddb`. The main `weft` entry point pulls in `bun:sqlite`, which is not available in browser environments.

### Constructor

```ts
new IndexedDBStorage(databaseName?: string)
```

| Parameter      | Type     | Default  | Description                    |
| -------------- | -------- | -------- | ------------------------------ |
| `databaseName` | `string` | `'weft'` | Name of the IndexedDB database |

```ts
const storage = new IndexedDBStorage('my-app');
```

### Methods

All methods from the `Storage` interface are supported except `query()`. IndexedDB has no SQL engine, so raw queries are not available.

| Method     | Supported | Notes                                     |
| ---------- | --------- | ----------------------------------------- |
| `get()`    | Yes       |                                           |
| `put()`    | Yes       |                                           |
| `delete()` | Yes       |                                           |
| `scan()`   | Yes       | Uses IndexedDB cursor iteration           |
| `batch()`  | Yes       | Atomic via a single IndexedDB transaction |
| `query()`  | No        | Not available -- IndexedDB has no SQL     |

#### `[Symbol.dispose]()`

Closes the IndexedDB database connection. Supports the `using` pattern for automatic cleanup.

```ts
{
  using storage = new IndexedDBStorage('weft');
  // storage is open...
} // database connection closed here
```
