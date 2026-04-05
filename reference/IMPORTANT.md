# Code Review Findings

Last reviewed: 2026-04-05

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

No outstanding issues.
