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

- [x] **Timer leak in synchronous update `Promise.race`** (`engine.ts:946-952`): Fixed by storing the timer ID and clearing it on both race outcomes via try/finally.

### Medium Severity

- [ ] **Zero resource leaks test missing**: Architecture doc claims a test starts/stops the engine 1000 times with no file handle or memory growth. No such test exists. Write the test or remove the criterion.

- [x] **`@types/bun` missing from devDependencies**: TypeScript `typecheck` was failing because `@types/bun` was not installed despite `tsconfig.json` declaring `"types": ["bun"]`. Added as a dev dependency.

- [x] **`workerAffinity` entries not cleaned up on workflow completion**: Added event listeners for terminal workflow events that delete the corresponding affinity entry.

- [x] **`scanExpiredTasks` iterates all inflight records on every tick**: Replaced full storage scan with an in-memory `DeadlineTracker` min-heap. The scanner now drains only expired entries. A reconciliation scan runs at a much lower frequency as a safety net.

- [x] **Search attribute value size unbounded** (`search-attributes.ts`): Added 1024-byte limit on encoded attribute values with clear error message. Validated via unit tests for within-limit, over-limit, and multi-byte character cases.

- [x] **Search attribute type not validated against schema** (`engine.ts`): Added `validateAttributeType` that checks runtime typeof against all five schema types (string, number, boolean, datetime, keyword_list). Integration tests verify mismatches are rejected.

- [x] **Interceptor error propagation in `composeWorkflowStartHook`** (`interceptor.ts`): Verified that synchronous function call chain correctly propagates errors. Added 13 tests confirming error propagation from interceptors, through nested chains, and from execute callbacks.

- [x] **Swallowed errors in fire-and-forget cleanup operations** (`engine.ts`): Replaced 4 silent `.catch(() => {})` blocks with `.catch((error) => { console.warn(...) })` that logs operation context and error details.

- [x] **Multi-backend test coverage for search attributes and updates**: Added parametrized test suites running against MemoryStorage, BunSQLiteStorage, LMDBStorage, and TursoStorage (112 additional test cases). Shared `storageBackends` infrastructure makes adding new backends automatic.

- [x] **`headers` propagation to remote workers verified**: Added 2 end-to-end integration tests confirming headers flow from `dispatchTask` through WebSocket to `RemoteWorker` activity interceptors, including the empty-headers case.
