# Code Review Findings

Last reviewed: 2026-03-30

## Architecture Doc Discrepancies

All three items below have been resolved by updating the architecture doc to mark unimplemented APIs as planned:

- [x] **`engine.profile()` not implemented**: Marked as "not yet implemented" in architecture doc.
- [x] **`alerts` configuration not implemented**: Marked as "not yet implemented" in architecture doc.
- [x] **`engine.getReview()` not exposed on Engine**: Doc pseudo-code corrected to use `engine.listReviews()` without unsupported filter arguments.

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

## Code Review Issues

### High Severity

- [x] **Fire-and-forget `transitionInflightToResolved` in WebSocket message handler**: Replaced `void` with `.catch()` that logs the error with the operation ID.
- [x] **Fire-and-forget `transitionInflightToResolved` in long-poll result handler**: Same fix applied to the HTTP handler.

### Medium Severity

- [ ] **Zero resource leaks test missing**: Architecture doc claims a test starts/stops the engine 1000 times with no file handle or memory growth. No such test exists. Criterion was incorrectly marked `[x]`; unchecked in this review. Write the test or remove the criterion.

- [x] **`workerAffinity` entries not cleaned up on workflow completion**: Added event listeners for terminal workflow events that delete the corresponding affinity entry.

- [x] **`scanExpiredTasks` iterates all inflight records on every tick**: Replaced full storage scan with an in-memory `DeadlineTracker` min-heap. The scanner now drains only expired entries. A reconciliation scan runs at a much lower frequency as a safety net.
