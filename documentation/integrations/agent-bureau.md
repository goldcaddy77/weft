# Agent Bureau

[Agent Bureau](https://github.com/stevekinney/agent-bureau) is a separate framework for orchestrating LLM agents. It treats Weft as its durability substrate: Agent Bureau consumes Weft, never the reverse. Weft has no runtime dependency on Agent Bureau, and never will.

This page covers the one place the two projects need to meet: storage.

## Why a wrapper exists

Weft's `Storage` interface and Agent Bureau's `KeyValueStore` interface describe the same idea—durable key/value persistence—with two small shape differences:

- **Values.** Weft stores `Uint8Array`. Agent Bureau stores `string`.
- **Key listing.** Weft exposes keys as `AsyncIterable<string>` via `storageKeys()` and `scan()`. Agent Bureau expects `list(prefix): Promise<string[]>`.

Rather than push those differences into either core interface, Weft ships a thin compatibility wrapper that lives entirely on the Weft side. Agent Bureau hands it a `KeyValueStore`-shaped value and never knows it was originally a Weft `Storage`.

## Using `textValueStore`

```ts
import { resolveStorage } from 'weft/storage';
import { textValueStore } from 'weft/storage/text-value-store';

await using weftStorage = await resolveStorage({ type: 'auto' });
const keyValueStore = textValueStore(weftStorage);

await keyValueStore.set('greeting', 'hello 🌍');
console.log(await keyValueStore.get('greeting')); // 'hello 🌍'
console.log(await keyValueStore.list('')); // ['greeting']
```

Pass `keyValueStore` to any Agent Bureau consumer that accepts a `KeyValueStore`. The wrapper holds no state—every call delegates straight to the underlying Weft storage after UTF-8 encoding or decoding.

The wrapper also surfaces the optional `has`, `deletePrefix`, and `close` methods that Agent Bureau's `KeyValueStore` defines, so adapters that need them work without further plumbing.

## Encoding and corruption

The wrapper encodes with `TextEncoder()` and decodes with `TextDecoder('utf-8', { fatal: true })`. _Fatal_ matters: if something else writes non-UTF-8 bytes through the underlying Weft storage and a `get()` runs over them, the wrapper raises `TypeError` instead of returning replacement characters. A string consumer never sees silently corrupted text.

In practice this only matters when the same key namespace is shared between code paths that write raw bytes and code paths that write strings. If that sharing is intentional, route both sides through the wrapper.

## `list()` and memory cost

`list(prefix)` materializes every matching key into a single array. It's exactly what Agent Bureau expects, and fine for the small, bounded namespaces it uses (sessions, identities, skill manifests, scheduler state). For very large prefixes, prefer the underlying Weft API:

```ts
import { storageKeys } from 'weft/storage/interface';

for await (const key of storageKeys(weftStorage, 'big-prefix:')) {
  // streaming
}
```

The wrapper deliberately does not offer an async-iterable variant of `list()`. Callers who need streaming already have it through `storageKeys()`.

## Migration path

Agent Bureau ships its own `KeyValueStoreConfiguration` with these backends: `memory`, `sqlite`, `indexeddb`, `chrome-storage`, `remote`, and `auto`. Every one of them has a Weft equivalent:

| Agent Bureau backend | Weft equivalent                                         |
| -------------------- | ------------------------------------------------------- |
| `memory`             | `MemoryStorage` from `weft/storage`                     |
| `sqlite`             | `SQLiteStorage` from `weft/storage/sqlite`              |
| `indexeddb`          | `IndexedDBStorage` from `weft/storage/indexeddb`        |
| `chrome-storage`     | `WebExtensionStorage` from `weft/storage/web-extension` |
| `remote`             | `HTTPStorage` from `weft/storage/http`                  |
| `auto`               | `resolveDefaultStorage()` from `weft/storage/auto`      |

To migrate a project from Agent Bureau's bundled storage to Weft's, swap the configuration object for an explicit Weft adapter, wrap it in `textValueStore`, and hand the result to whatever Agent Bureau consumer used to receive the bundled store. Existing data persists in place when the underlying backend (`sqlite`, `indexeddb`, `chrome-storage`) is the same and the key/value bytes are UTF-8—which they always are when written through `textValueStore`.

## Caveats

- The wrapper is for `KeyValueStore` consumers, not for moving binary data. If you need bytes on both sides, use Weft's `Storage` directly.
- `close()` on the wrapper disposes the underlying Weft storage. Don't share one Weft `Storage` between code that calls `close()` and code that still expects the storage to be live.
- This page is the canonical integration contract between Weft and Agent Bureau. Any change to the vendored `KeyValueStore` shape in `src/storage/text-value-store.test-d.ts` should be reflected here.
