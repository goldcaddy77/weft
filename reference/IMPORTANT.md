# Code Review Findings

Last reviewed: 2026-03-27

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
- [ ] **Interceptor system** (WorkflowInterceptor, ActivityInterceptor). Types defined but runtime wiring incomplete — remote worker interceptors not supported.
- [ ] **OpenTelemetry integration** via interceptors. Full section (lines 5344-5365) is unimplemented.
- [ ] **Model routing and fallback chains** for agents. Full section (lines 5229-5237) is unimplemented.
