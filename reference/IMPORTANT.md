# Code Review Findings

Last reviewed: 2026-04-02

## Not Yet Implemented (Notable Gaps)

- [ ] **Agent-shaped workflow optimizations**: Architecture doc specifies priority tool call queuing, LLM connection pre-warming, and checkpoint compression for agent-typed workflows. None of these optimizations exist in the engine.
- [ ] **Multi-agent fan-out budget enforcement verification**: Budget tracking and `AbortController` wiring exist in `supervise()`, but enforcement during parallel multi-agent execution (via `ctx.all()`) is not fully verified end-to-end. Total cost across parallel branches should count against `ctx.setBudget()`.
- [ ] **Performance benchmarks not meeting architecture targets**: Benchmark tests exist with relaxed thresholds (e.g., 3K-5K workflows/sec vs. spec'd >50K; 10-16KB/workflow vs. spec'd <=2KB; cold start 200ms vs. spec'd <100ms). Tests pass at relaxed thresholds but the architecture doc's aspirational targets are unverified.
- [ ] **IndexedDB not covered in multi-backend tests**: `search-attributes-multibackend.test.ts` and `updates-multibackend.test.ts` cover MemoryStorage, BunSQLiteStorage, LMDBStorage, and TursoStorage but not IndexedDB.
- [ ] **Index scan performance benchmark missing**: No benchmark exists for the spec'd "<1ms for single-attribute equality filter on 100K workflows" target.
- [ ] **OTel metrics not backed by standard exporter**: `/v1/metrics` uses a custom `MetricsCollector` that outputs Prometheus text manually. OTel metric definitions exist in `src/observability/metrics.ts` but aren't wired to the endpoint via a standard OTel Prometheus exporter.
- [ ] **Remote worker interceptors not documented**: The `RemoteWorker` class accepts an `interceptors` option (implemented in `src/worker/index.ts:35`), but `docs/guides/remote-workers.md` does not show this usage.
- [ ] **JSDoc examples incomplete**: Public API functions have descriptions but most lack inline code examples in their JSDoc.

## Code Review Issues

### Medium Severity

- [ ] **Zero resource leaks test uses generous threshold**: `resource-leaks.test.ts` runs 1000 iterations and checks heap growth stays under 5MB. Architecture doc claims "no file handle or memory growth" — the 5MB threshold may mask slow leaks.
- [ ] **MCP transport: malformed JSON silently ignored in stdio and SSE transports**: In `transport-stdio.ts` (lines 200-218) and `transport-http-sse.ts` (lines 280-298), JSON parse failures are caught and silently discarded. A malformed response leaves the pending request waiting until timeout with no diagnostic logging.
- [ ] **MCP transport: `response.json()` errors not wrapped consistently**: In `transport-http.ts` (line 78), a JSON parse error propagates as a raw `SyntaxError` instead of being wrapped in `MCPTransportError` like other transport errors.
- [ ] **OAuth2 token manager: `response.json()` not catch-guarded**: In `oauth2-token-manager.ts` (line 87), if the token endpoint returns malformed JSON, the error is an unhandled rejection rather than an `OAuth2TokenError`.
- [ ] **StdioTransport stderr output is discarded**: `transport-stdio.ts` (line 153) sets `stderr: 'ignore'`. Diagnostic output from MCP server child processes is lost, making debugging transport issues harder.

### Low Severity

- [ ] **MCP transport test coverage gaps**: Missing tests for: malformed JSON from stdio server, malformed SSE event data, double-dispose behavior on transports, JSON parse failure in HttpTransport, network error vs. JSON error in OAuth2TokenManager.
- [ ] **Alerting only supports two metric types**: `AlertMetric` type is `'workflow.failure_rate' | 'activity.p99_duration'`. The architecture doc example showed `storage.size` as a third metric, but this is not implemented.
