# Code Review Findings

Last reviewed: 2026-03-26

## Critical

- [ ] **Race condition in server event sequence counter initialization** (`src/server/index.ts:107-137`). `sequenceCounters` and `sequenceInitPromises` Maps are shared across concurrent event handlers. When multiple events for the same workflow fire simultaneously, two handlers can both find no entry in `sequenceInitPromises`, both create new promises, and both initialize the same counter. This can produce duplicate sequence numbers, causing silent data loss when events are persisted to storage.

- [ ] **Unhandled promise in server event persistence** (`src/server/index.ts:177-186`). The event persistence chain is prefixed with `void` but the async `.then()` chain can reject silently if `ensureSequenceInitialized()` or `engine.storage.put()` fails. Additionally, the WebSocket publish at line 190 happens synchronously before persistence is guaranteed, so clients may observe events that never get durably stored — violating durability guarantees.

## High

- [ ] **Event listener cleanup gap on server init failure** (`src/server/index.ts:162-200, 261`). `wireEventBroadcasting` attaches 13 event listeners to the engine via an AbortController. If an error occurs during server initialization after listeners are attached but before `cleanupBroadcasting` is assigned, the listeners remain attached indefinitely. Use try/finally during server initialization to guarantee cleanup.

- [ ] **Timer callback error stops processing remaining timers** (`src/core/scheduler.ts:159-167`). `await this.#onTimerFired(entry)` is not wrapped in try/catch. If the callback throws, subsequent timers in the already-loaded `expired` array are never processed. This breaks durability guarantees — timers after a failed callback are silently skipped.

- [ ] **Missing error boundary in UpdateCoordinator lifecycle** (`src/server/handler.ts:434-463`). The UpdateCoordinator request lifecycle lacks a comprehensive try/catch. Unexpected errors from `createRequest`, `checkIdempotency`, or `waitForResponse` propagate as 500 responses without proper logging context.

## Medium

- [ ] **IndexedDB cursor leak on early iteration termination** (`src/storage/indexeddb.ts:61-123`). The async generator for scan creates an IDBCursorWithValue that remains open if the consumer stops iterating early without consuming all items. There is no try/finally cleanup mechanism, so IndexedDB transactions can remain open indefinitely if async iteration is cancelled mid-stream.

- [ ] **FinalizationRegistry cleanup not guaranteed before shutdown** (`src/core/engine.ts`). The engine uses `FinalizationRegistry` to clean up stale `WeakRef` entries in `#handleCache`. However, FinalizationRegistry callbacks are not guaranteed to run before process shutdown. If the engine is disposed before all handles are garbage collected, internal Maps may retain stale entries.

- [ ] **Empty string prefix causes invalid scan upper bound** (`src/storage/bun-sql.ts:50-51`). Prefix range calculation computes `prefixEnd` by incrementing the last character. If prefix is an empty string, `prefix.charCodeAt(prefix.length - 1)` returns `NaN` and `String.fromCharCode(NaN)` returns `"\0"`, creating an invalid upper bound. While unlikely in practice due to how key constants are constructed, this is a latent bug.

- [ ] **Unsafe type assertions in server event serialization** (`src/server/index.ts:166-168, 178, 189`). Multiple `as unknown as Record<string, unknown>` casts when extracting `workflowId` and other data from events. If an event class is modified and no longer includes `workflowId`, this code silently produces `undefined` values without any runtime error.

## Low

- [ ] **No bounds checking on `limit` query parameter** (`src/server/handler.ts:289-292`). The `limit` parameter from query strings is parsed via `Number(limit)` without validation. Values like `-1` or `99999999999` could cause unexpected behavior in storage scans. Add validation: clamp to a reasonable range (e.g., 1-1000).

- [ ] **Route parameter non-null assertions** (`src/server/handler.ts:693-726`). Throughout the handler switch statement, `route.params['id']!` uses non-null assertions. While the route regex guarantees the param exists, if routing logic changes without updating assertions, runtime errors will occur. Consider providing a default or explicit check.

## Architecture Doc Discrepancies

- [ ] **`BunSQLStorage` renamed to `BunSQLiteStorage`** in architecture doc (19 occurrences updated this review). Verify no references to the old name remain in other docs or comments.

- [ ] **`Weft.Context` vs `Context`**. Architecture doc uses `Weft.Context` as a type annotation in examples. Actual implementation exports `Context` directly (not namespaced). Readers following examples need `import { Context } from 'weft'`.

- [ ] **`engine.profile()` not implemented**. Architecture doc shows `engine.profile()` returning checkpoint/task timing metrics. No such method exists on the Engine class. Either implement or remove from doc.

- [ ] **`alerts` configuration not implemented**. Architecture doc shows alert rules and webhook hooks in Engine constructor options. No `alerts` property exists in `EngineOptions`. Either implement or remove from doc.

- [ ] **`AsyncDisposableStack` not used in server setup**. Architecture doc states "AsyncDisposableStack used in server setup" but the server uses manual event listener cleanup and disposable patterns instead. Either implement or update the checklist item.

- [ ] **Activity registry uses `Map`, not `WeakMap`**. Architecture doc states "Activity registry uses WeakMap. Metadata is keyed to function references and auto-collected." Actual implementation at `engine.ts:285` uses `Map<string, ...>` keyed by string names, not WeakMap keyed by function references.

- [ ] **LMDBStorage and Turso adapter not implemented**. Architecture doc lists both as acceptance criteria but neither exists in `src/storage/`. Only MemoryStorage, BunSQLiteStorage, and IndexedDBStorage are implemented.

## Not Yet Implemented (Notable Gaps)

These are significant architecture doc features with no implementation:

- [ ] **Long-poll fallback** (`GET /v1/tasks/:queue`). No long-poll endpoint exists for non-WebSocket environments.
- [ ] **Authentication** (API keys, JWT, mTLS). No auth checks in server handler — all endpoints are open.
- [ ] **Single binary distribution** (`bun build --compile`). No build script for standalone executables.
- [ ] **MCP server integration** for agent tools. Full section (lines 5170-5180) is unimplemented.
- [ ] **Context window management strategies** (sliding-window, summarize, RAG). Full section (lines 5184-5194) is unimplemented.
- [ ] **Multi-agent coordination** (handoff, debate, supervise, SharedState). Full section (lines 5198-5207) is unimplemented.
- [ ] **Interceptor system** (WorkflowInterceptor, ActivityInterceptor). Full section (lines 5325-5340) is unimplemented.
- [ ] **OpenTelemetry integration** via interceptors. Full section (lines 5344-5365) is unimplemented.
- [ ] **Model routing and fallback chains** for agents. Full section (lines 5229-5237) is unimplemented.
