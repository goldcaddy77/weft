# Runtime Support Matrix

Every public entry point and storage adapter, with its supported runtimes.

| Entry Point                | Bun       | Node 22+   | Browser                            | Edge / CF Workers                |
| -------------------------- | --------- | ---------- | ---------------------------------- | -------------------------------- |
| `weft` (root)              | yes       | yes        | yes                                | yes                              |
| `weft/server`              | yes       | no         | no                                 | no                               |
| `weft/server/handler`      | yes       | yes        | yes                                | yes                              |
| `weft/client`              | yes       | yes        | yes                                | yes                              |
| `weft/client/local`        | yes       | yes        | yes                                | yes                              |
| `weft/storage/memory`      | yes       | yes        | yes                                | yes                              |
| `weft/storage/sqlite`      | yes (bun) | yes (node) | no                                 | no                               |
| `weft/storage/sqlite/bun`  | yes       | no         | no                                 | no                               |
| `weft/storage/sqlite/node` | no        | yes        | no                                 | no                               |
| `weft/storage/bun-sqlite`  | yes       | no         | no                                 | no                               |
| `weft/storage/indexeddb`   | no        | no         | yes                                | conditional (requires IndexedDB) |
| `weft/storage/lmdb`        | yes       | yes        | no                                 | no                               |
| `weft/storage/turso`       | yes       | yes        | conditional (requires fetch)       | conditional (requires fetch)     |
| `weft/storage/compressed`  | yes       | yes        | no (requires node:zlib for brotli) | no                               |
| `weft/service-worker`      | no        | no         | yes                                | yes                              |

## Legend

- **yes** — supported and tested.
- **no** — not supported; import resolution will fail cleanly.
- **conditional** — works if the named capability is available in the runtime.

## Notes

- The root `weft` entry point is portable: it contains no `bun:*`, `node:*`, or filesystem dependencies.
- `serve()` is Bun-only; use `handleRequest()` for portable HTTP handling.
- Storage adapters are isolated behind subpath exports. Heavy backends (`bun:sqlite`, `lmdb`, `better-sqlite3`) are never bundled into the portable root.
