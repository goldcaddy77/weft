# Code Review Findings

Last reviewed: 2026-04-03

## Not Yet Implemented (Notable Gaps)

- [x] **Agent-shaped workflow optimizations**: Priority tool call queuing, LLM connection pre-warming, and checkpoint compression for agent-typed workflows implemented in engine.
- [ ] **Multi-agent fan-out budget enforcement verification**: Budget tracking and `AbortController` wiring exist in `supervise()`, but enforcement during parallel multi-agent execution (via `ctx.all()`) is not fully verified end-to-end. Total cost across parallel branches should count against `ctx.setBudget()`.
- [ ] **Performance benchmarks not meeting architecture targets**: Benchmark tests exist with relaxed thresholds (e.g., 3K-5K workflows/sec vs. spec'd >50K; 10-16KB/workflow vs. spec'd <=2KB; cold start 200ms vs. spec'd <100ms). Tests pass at relaxed thresholds but the architecture doc's aspirational targets are unverified.
- [ ] **IndexedDB not covered in multi-backend tests**: `search-attributes-multibackend.test.ts` and `updates-multibackend.test.ts` cover MemoryStorage, BunSQLiteStorage, LMDBStorage, and TursoStorage but not IndexedDB.
- [ ] **Index scan performance benchmark missing**: No benchmark exists for the spec'd "<1ms for single-attribute equality filter on 100K workflows" target.
- [ ] **OTel metrics not backed by standard exporter**: `/v1/metrics` uses a custom `MetricsCollector` that outputs Prometheus text manually. OTel metric definitions exist in `src/observability/metrics.ts` but aren't wired to the endpoint via a standard OTel Prometheus exporter.
- [ ] **Remote worker interceptors not documented**: The `RemoteWorker` class accepts an `interceptors` option (implemented in `src/worker/index.ts:35`), but `docs/guides/remote-workers.md` does not show this usage.
- [ ] **JSDoc examples incomplete**: Public API functions have descriptions but most lack inline code examples in their JSDoc.

## Code Review Issues

### Medium Severity

- [ ] **Organization budget policy bypassed in `ctx.all()` sub-operations** (`src/core/engine.ts:2980-2991`): When agents execute as sub-operations within `ctx.all()`, `#executeSubOperation` creates a fresh `BudgetTracker` with only local budget constraints but never calls `#checkAgentBudgetPolicy()` or `#recordAgentBudgetCost()`. Compare with `#processAgentContextOperation` (lines 2540-2597) which properly checks and records org-level costs. Multiple agents in `ctx.all()` can collectively exceed org-level budget caps without detection. Fix: extract budget enforcement logic and apply it in `#executeSubOperation` for agent operations.
- [ ] **MCP client resource leak on tool name conflict** (`src/ai/agent.ts:376-377`): `registry.validate()` is called outside the try-catch block (lines 333-374) that disposes MCP clients on failure. If `validate()` throws a `ToolNameConflictError`, all previously created MCP clients in the `clients` array leak because the `dispose` function at line 379 is never reached. Fix: move `registry.validate()` inside the try block.
- [ ] **Visibility poll and reconciliation can race on the same task** (`src/server/index.ts:1145-1224`): `scanExpiredTasks` and `reconcileOrphanedRecords` each have their own running guards but don't coordinate with each other. Both can call `registry.completeTask()` and `reassignOrExpireTask()` for the same operationId concurrently. While storage transitions are likely idempotent, this could produce duplicate `ActivityFailedEvent` dispatches or redundant task re-queuing. Fix: share a `Set<string>` of operationIds currently being processed, or add a single mutex across both scanners.

### Low Severity

- [ ] **Observability workflow spans map grows unbounded** (`src/observability/index.ts:171-180`): The `workflowSpans` Map stores spans by workflowId. If a workflow never reaches a terminal state (orphaned or long-running), the span entry remains indefinitely. Fix: add periodic eviction or tie span cleanup to engine disposal.
- [ ] **Agent tool cache never proactively evicted** (`src/ai/agent.ts:180,450`): The `toolCache` Map in `AgentLoopState` is checked against TTL during access but never proactively pruned. Over a long-running agent with many unique tool calls, entries accumulate without bound. Fix: add periodic eviction or cap the cache size.
