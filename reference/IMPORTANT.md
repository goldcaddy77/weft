# Code Review Findings

Last reviewed: 2026-03-31

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
- [ ] **Remote worker interceptors**: Architecture doc specifies `Worker` accepts `interceptors` option but this is not implemented. Activity interceptors only apply to local workers via `engine.addActivityInterceptor()`.
- [ ] **OpenTelemetry integration** via interceptors. Adapter file exists (`src/observability/opentelemetry.ts`) but acceptance criteria for trace context propagation to remote workers, span links for child workflows, and custom `attributeExtractor` are not met.
- [ ] **Model routing and fallback chains** for agents. Full section is unimplemented.

## Code Review Issues

### High Severity

- [x] **Fire-and-forget `transitionInflightToResolved` in WebSocket message handler**: Replaced `void` with `.catch()` that logs the error with the operation ID.
- [x] **Fire-and-forget `transitionInflightToResolved` in long-poll result handler**: Same fix applied to the HTTP handler.

- [ ] **Timer leak in synchronous update `Promise.race`** (`engine.ts:946-952`): When `respondPromise` resolves before the timeout, the `setTimeout` timer continues running until it fires, creating an unhandled rejection. Under high update throughput this accumulates dangling timers. Fix: store the timer ID and clear it on both race outcomes.

### Medium Severity

- [ ] **Zero resource leaks test missing**: Architecture doc claims a test starts/stops the engine 1000 times with no file handle or memory growth. No such test exists. Write the test or remove the criterion.

- [x] **`workerAffinity` entries not cleaned up on workflow completion**: Added event listeners for terminal workflow events that delete the corresponding affinity entry.

- [x] **`scanExpiredTasks` iterates all inflight records on every tick**: Replaced full storage scan with an in-memory `DeadlineTracker` min-heap. The scanner now drains only expired entries. A reconciliation scan runs at a much lower frequency as a safety net.

- [ ] **Search attribute value size unbounded** (`search-attributes.ts:55-57`): Attribute values are encoded into storage keys (`idx:{attr}:{encodedValue}:{wfId}`) with no size validation. A large string value (e.g. 100KB) creates oversized keys that may exceed storage backend key limits (LMDB, SQLite). Add validation in `setAttributes` to reject values above a reasonable threshold.

- [ ] **Search attribute type not validated against schema** (`engine.ts:1233-1269`): When a schema is declared at registration time, only attribute _names_ are validated — not types. Setting `{ status: 12345 }` when the schema declares `status: 'string'` silently succeeds. The encoded key prefix (`n:` vs `s:`) then mismatches expectations, causing filters to miss results.

- [ ] **Interceptor error swallowed in `composeWorkflowStartHook`** (`interceptor.ts:267-291`): The `workflowStart` interceptor composition does not catch or propagate exceptions. If an interceptor throws, the error is silently lost and the workflow may start with incomplete initialization. Compare with `composeAgentHook` which correctly propagates via generators.

- [ ] **Swallowed errors in fire-and-forget cleanup operations** (`engine.ts` lines 422, 1135, 1754-1772): Multiple `.catch(() => {})` blocks silently discard storage errors during update cleanup, pending update processing, and batch operations. These should at minimum log at warn level so failures in cleanup are visible in production.

- [ ] **Multi-backend test coverage missing for search attributes and updates**: All search attribute and synchronous update tests use `MemoryStorage` only. The acceptance criteria require identical behavior on SQLite, LMDB, and IndexedDB. Parametrize the test suites to run against all backends.

- [ ] **`headers` propagation to remote workers unverified**: Interceptor headers are serialized into the WebSocket `task` message (`server/index.ts`), but no integration test verifies that a remote worker actually receives and can read them from the activity context.
