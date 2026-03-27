# Code Review Findings

Last reviewed: 2026-03-27

## Medium

- [ ] **Unsafe type assertion in `serializeEvent`** (`src/server/index.ts:73`). `(event as unknown as Record<string, unknown>)[key]` still uses the `as unknown as` cast pattern. Since `Object.keys(event)` already confirms the key exists, use an `in` check and index directly, or use a helper that narrows the type safely. If an event class is modified and a property changes type, this code silently produces wrong values.

- [ ] **BroadcastChannel listener never removed on disposal** (`src/core/worker-execution-strategy.ts:39-48, 121-140`). The constructor adds a `message` event listener to the BroadcastChannel at line 42. Both `[Symbol.dispose]()` and `[Symbol.asyncDispose]()` close the channel but never call `removeEventListener`. The listener closure holds a reference to `this` and `#workersByWorkflowId`, potentially keeping the entire `WorkerExecutionStrategy` alive longer than intended.

- [ ] **Missing `AbortController.abort()` in `RemoteWorker.disconnect()`** (`src/worker/index.ts:123-136`). The `disconnect()` method stops the heartbeat and closes the WebSocket but never calls `this.#abortController.abort()`. Event listeners registered with `{ signal: this.#abortController.signal }` at lines 75, 93, 101, 112 remain attached to the closed WebSocket. The `[Symbol.dispose]()` method at line 153 does abort, but disconnect alone does not.

- [ ] **`RemoteWorker.disconnect()` can hang indefinitely** (`src/worker/index.ts:127-130`). The `while (this.#inFlight > 0)` loop polls with `Bun.sleep(50)` but has no timeout. If a task hangs, `disconnect()` never resolves, blocking graceful shutdown. Add a configurable timeout that logs a warning and proceeds after a reasonable wait.

- [ ] **Service Worker scheduler swallows periodic sync registration failure** (`src/service-worker/scheduler.ts:137-140`). `void periodicSync.register(...)` discards the promise. If registration fails, the scheduler reports as running (`#running = true` at line 132) but no polling fallback is activated. Timers persist in storage but are never processed.

- [ ] **Service Worker scheduler polling loop stops on tick error** (`src/service-worker/scheduler.ts:167-172`). `void this.tick().then(...)` has no `.catch()` handler. If `tick()` rejects, `#schedulePoll()` is never called again and the polling loop dies silently.

- [ ] **Timer callback can race with scheduler disposal** (`src/core/scheduler.ts:104-118, 147-172`). `stop()` sets `#intervalHandle` to `null` at line 116, but an already-dispatched `tick()` call at line 108 continues executing. It may access storage or fire callbacks after the scheduler (or engine) is disposed. Add a `#stopped` flag checked at the start of `tick()`.

- [ ] **Update response cleanup leaves orphaned idempotency mappings** (`src/core/updates.ts:179-201`). `cleanupExpiredResponses()` only deletes `upr:` keys. Corresponding `upk:{workflowId}:{key}` entries that point to the deleted responses remain in storage indefinitely. While not functionally harmful (the idempotency check would fall through), they accumulate and waste space.

## Low

- [ ] **Worker error handler and release have overlapping cleanup** (`src/core/worker-execution-strategy.ts:195-233`). `#handleWorkerError()` manually removes listeners and terminates the worker, while `#releaseWorker()` also removes listeners and returns the worker to the pool. These two paths have duplicated cleanup logic. If both execute for the same workflow (e.g., error arrives during normal completion), the second pass operates on stale state.

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
