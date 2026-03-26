# Code Review Findings

Last reviewed: 2026-03-26

## Critical

- [x] **Race condition in server event sequence counter initialization** (`src/server/index.ts:107-137`). Fixed: removed redundant `has` check, `nextSequence` now throws if counter uninitialized.

- [x] **Unhandled promise in server event persistence** (`src/server/index.ts:177-186`). Fixed: wrapped persistence in try/catch inside async IIFE, moved WebSocket publish after successful persistence.

## High

- [x] **Event listener cleanup gap on server init failure** (`src/server/index.ts:162-200, 261`). Fixed: wrapped post-`Bun.serve()` setup in try/catch with cleanup on failure.

- [x] **Timer callback error stops processing remaining timers** (`src/core/scheduler.ts:159-167`). Fixed: wrapped callback in try/catch, remaining timers always processed.

- [x] **Missing error boundary in UpdateCoordinator lifecycle** (`src/server/handler.ts:434-463`). Fixed: moved `createRequest` inside try/catch block.

## Medium

- [x] **IndexedDB cursor leak on early iteration termination** (`src/storage/indexeddb.ts:61-123`). Fixed: added try/finally with `transaction.abort()` on early termination.

- [x] **FinalizationRegistry cleanup not guaranteed before shutdown** (`src/core/engine.ts`). Already fixed: `[Symbol.dispose]()` clears all internal Maps.

- [x] **Empty string prefix causes invalid scan upper bound** (`src/storage/bun-sql.ts:50-51`). Fixed: guarded `prefixEnd` calculation in all three storage implementations.

- [x] **Unsafe type assertions in server event serialization** (`src/server/index.ts:166-168, 178, 189`). Fixed: replaced `as unknown as` casts with `in` + `typeof` narrowing.

## Low

- [x] **No bounds checking on `limit` query parameter** (`src/server/handler.ts:289-292`). Fixed: validate, floor, and clamp to 1-1000. Also validated `offset`.

- [x] **Route parameter non-null assertions** (`src/server/handler.ts:693-726`). Fixed: replaced `!` assertions with `param()` helper that throws, caught at handler level.

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
