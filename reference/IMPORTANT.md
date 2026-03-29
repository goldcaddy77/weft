# Code Review Findings

Last reviewed: 2026-03-29

## Architecture Doc Discrepancies

- [ ] **`engine.profile()` not implemented**: Architecture doc shows `engine.profile()` returning checkpoint/task timing metrics. No such method exists on the Engine class. Either implement or remove from doc.

- [ ] **`alerts` configuration not implemented**: Architecture doc shows alert rules and webhook hooks in Engine constructor options. No `alerts` property exists in `EngineOptions`. Either implement or remove from doc.

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

- [ ] **Sequence counter race condition** (`nextSequence` at lines 230–239): The read-modify-write pattern on `sequenceCounters` is not atomic. Two concurrent events for the same workflow can produce duplicate sequence numbers.

- [ ] **No validation of `visibilityTimeout` in task dispatch** (line 825): `task.visibilityTimeout` is accepted as-is with no bounds checking. Negative values cause immediate expiry; `Infinity` prevents expiry entirely.

- [ ] **Fire-and-forget async operations lack retry** (lines 275–303, 577–585, 608–682, 714–737): Multiple critical async paths (event persistence, visibility extension, worker requeue, inflight restoration) use `void (async () => { ... })()` with only `console.error` on failure. No retry or alerting.

## Code Review: Activity Worker (`src/workers/activity-worker-entry.ts`)

- [ ] **Function serialization via `toString()` is fragile** (line 69): `handler.toString()` only works for functions without closures. Arrow functions that capture outer scope, class methods, or functions referencing module-level variables silently produce broken worker scripts with no validation.
