# Code Review Findings

Last reviewed: 2026-03-28

## Architecture Doc Discrepancies

- [ ] **`Weft.Context` vs `Context`**: Architecture doc uses `Weft.Context` as a type annotation in 18 examples. Actual implementation exports `Context` directly (not namespaced). Readers following examples need `import { Context } from 'weft'`.

- [ ] **`engine.profile()` not implemented**: Architecture doc shows `engine.profile()` returning checkpoint/task timing metrics. No such method exists on the Engine class. Either implement or remove from doc.

- [ ] **`alerts` configuration not implemented**: Architecture doc shows alert rules and webhook hooks in Engine constructor options. No `alerts` property exists in `EngineOptions`. Either implement or remove from doc.

- [ ] **`AsyncDisposableStack` not used in server setup**: Architecture doc states "AsyncDisposableStack used in server setup" but the server uses manual event listener cleanup and disposable patterns instead. Either implement or update the checklist item.

## Not Yet Implemented (Notable Gaps)

- [ ] **Single binary distribution** (`bun build --compile`). No build script for standalone executables.
- [ ] **MCP server integration** for agent tools. Full section is unimplemented.
- [ ] **Context window management strategies** (sliding-window, summarize, RAG). Full section is unimplemented.
- [ ] **Multi-agent coordination** (handoff, debate, supervise, SharedState). Full section is unimplemented.
- [ ] **Interceptor system**: Remote worker interceptors not supported. Types defined but runtime wiring incomplete.
- [ ] **OpenTelemetry integration** via interceptors. Full section is unimplemented.
- [ ] **Model routing and fallback chains** for agents. Full section is unimplemented.
- [ ] **Graceful shutdown via `shutdown` message**: No handler for worker-initiated graceful shutdown.
- [ ] **Server cancellation propagated to workers**: Server does not send `cancel` messages over WebSocket.

## Code Review: Server (`src/server/index.ts`)

- [ ] **Sequence counter race condition** (`nextSequence`): The `sequenceCounters` map is accessed without synchronization. Two concurrent events for the same workflow could read the same counter value, producing duplicate sequence numbers.

## Code Review: Activity Worker (`src/workers/activity-worker-entry.ts`)

- [ ] **Function serialization via `toString()` is fragile**: `handler.toString()` (line ~69) only works for functions without closures. Arrow functions that capture outer scope, class methods, or functions referencing module-level variables silently produce broken worker scripts with no validation.
