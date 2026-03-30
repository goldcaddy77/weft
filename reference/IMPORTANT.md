# Code Review Findings

Last reviewed: 2026-03-30

## Architecture Doc Discrepancies

- [ ] **`engine.profile()` not implemented**: Architecture doc shows `engine.profile()` returning checkpoint/task timing metrics. No such method exists on the Engine class. Either implement or remove from doc.

- [ ] **`alerts` configuration not implemented**: Architecture doc shows alert rules and webhook hooks in Engine constructor options. No `alerts` property exists in `EngineOptions`. Either implement or remove from doc.

- [ ] **`engine.getReview()` not exposed on Engine**: Architecture doc (line ~2554) referenced `engine.getReview()` but this method only exists on `HumanReviewCoordinator`, not the Engine. Either expose it on Engine or update the doc. (Doc pseudo-code has been updated to use `engine.listReviews()` as a workaround.)

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

- [ ] **Fire-and-forget `transitionInflightToResolved` in WebSocket message handler** (`src/server/index.ts:751`): The `taskResult` case calls `void transitionInflightToResolved(...)` without awaiting or attaching an error handler. If the storage batch write fails, the `op:inflight:*` key leaks in storage, causing the visibility timeout scanner to later re-dispatch an already-completed task. Add a `.catch()` that logs the error and falls back to a retry, or wrap in `withRetry()` like the heartbeat handler does.

- [ ] **Fire-and-forget `transitionInflightToResolved` in long-poll result handler** (`src/server/index.ts:682`): Same pattern as above in the `POST /v1/tasks/:queue/result` HTTP handler. Storage failure silently leaks the inflight record.

### Medium Severity

- [ ] **Zero resource leaks test missing**: Architecture doc claims a test starts/stops the engine 1000 times with no file handle or memory growth. No such test exists. Criterion was incorrectly marked `[x]`; unchecked in this review. Write the test or remove the criterion.

- [ ] **`workerAffinity` entries not cleaned up on workflow completion**: The `workerAffinity` Map (`src/server/index.ts:452`) is bounded by `MAX_AFFINITY_ENTRIES` with FIFO eviction, but entries for completed workflows are never explicitly removed. Stale entries waste space and can route tasks to workers that no longer have the relevant data cached. Consider clearing affinity on workflow completion.

- [ ] **`scanExpiredTasks` iterates all inflight records on every tick** (`src/server/index.ts:951`): The visibility timeout scanner does a full `scan('op:inflight:')` every `visibilityPollMs` (default 5 seconds). With thousands of in-flight tasks, this is an O(n) storage scan per interval. Consider maintaining an in-memory min-heap of deadlines or using the registry's tracked tasks instead of re-scanning storage.
