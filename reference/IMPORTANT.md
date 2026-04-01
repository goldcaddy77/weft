# Code Review Findings

Last reviewed: 2026-04-01

## Not Yet Implemented (Notable Gaps)

- [ ] **Remote worker interceptors**: Architecture doc specifies `Worker` accepts `interceptors` option but this is not implemented. Activity interceptors only apply to local workers via `engine.addActivityInterceptor()`.
- [ ] **MCP OAuth2 authentication**: Only bearer token and API-key auth supported. OAuth2 client credentials specified in architecture doc but not implemented.
- [ ] **MCP stdio and SSE transports**: Only HTTP transport implemented. Stdio and SSE transports specified in architecture doc but not built.
- [ ] **Multi-agent fan-out budget enforcement**: Budget tracking exists but enforcement during parallel multi-agent execution (via `ctx.all()`) is not fully verified. Total cost across branches should count against `ctx.setBudget()`.
- [ ] **OTel trace context in coordination functions**: W3C Trace Context utilities exist in `src/observability/propagation.ts`, but `ctx.handoff()`, `ctx.debate()`, and `ctx.supervise()` do not inject or propagate trace context headers.
- [ ] **Built-in alerting**: Architecture doc specifies alert rules as engine event listeners with webhook notifications. No alerting mechanism exists.
- [ ] **Automatic payload compression**: No gzip/brotli compression above configurable threshold. Only context summarization (compressing old messages) exists.
- [ ] **Performance benchmarks not meeting architecture targets**: Benchmark tests exist with relaxed thresholds (e.g., >5K workflows/sec vs. spec'd >50K; ≤10KB/workflow vs. spec'd ≤2KB). Tests pass at relaxed thresholds but the architecture doc's aspirational targets are unverified.
- [ ] **IndexedDB not covered in multi-backend tests**: `search-attributes-multibackend.test.ts` and `updates-multibackend.test.ts` cover MemoryStorage, BunSQLiteStorage, LMDBStorage, and TursoStorage but not IndexedDB.

## Code Review Issues

### Medium Severity

- [ ] **Zero resource leaks test exists but does not meet original criteria**: `resource-leaks.test.ts` runs 1000 iterations and checks heap growth stays under 5MB. Architecture doc claims "no file handle or memory growth" — the test uses a generous 5MB threshold which may mask slow leaks.
