# Code Review Findings

Last reviewed: 2026-04-01

## Not Yet Implemented (Notable Gaps)

- [ ] **Remote worker interceptors**: Architecture doc specifies `Worker` accepts `interceptors` option but this is not implemented. Activity interceptors only apply to local workers via `engine.addActivityInterceptor()`.
- [ ] **MCP OAuth2 authentication**: Only bearer token and API-key auth supported. OAuth2 client credentials specified in architecture doc but not implemented.
- [ ] **MCP stdio and SSE transports**: Only HTTP transport implemented. Stdio and SSE transports specified in architecture doc but not built.
- [ ] **`onBudgetWarning` hook not invoked**: Defined in `AgentHooks` interface in `declaration.ts` but never called in `executeAgentLoop()`. Budget warnings fire as events only; the hook callback is dead code.
- [ ] **Multi-agent fan-out budget enforcement**: Budget tracking exists but enforcement during parallel multi-agent execution (via `ctx.all()`) is not fully verified. Total cost across branches should count against `ctx.setBudget()`.
- [ ] **OTel trace context in coordination functions**: W3C Trace Context utilities exist in `src/observability/propagation.ts`, but `ctx.handoff()`, `ctx.debate()`, and `ctx.supervise()` do not inject or propagate trace context headers.
- [ ] **Built-in alerting**: Architecture doc specifies alert rules as engine event listeners with webhook notifications. No alerting mechanism exists.
- [ ] **Automatic payload compression**: No gzip/brotli compression above configurable threshold. Only context summarization (compressing old messages) exists.
- [ ] **Performance benchmarks not meeting architecture targets**: Benchmark tests exist with relaxed thresholds (e.g., >5K workflows/sec vs. spec'd >50K; ≤10KB/workflow vs. spec'd ≤2KB). Tests pass at relaxed thresholds but the architecture doc's aspirational targets are unverified.
- [ ] **IndexedDB not covered in multi-backend tests**: `search-attributes-multibackend.test.ts` and `updates-multibackend.test.ts` cover MemoryStorage, BunSQLiteStorage, LMDBStorage, and TursoStorage but not IndexedDB.

## Code Review Issues

### High Severity

- [ ] **Streaming agent backpressure logic is fundamentally flawed** (`streaming-agent.ts:192-206`): `bufferedBytes` is incremented on each `onToken` call but never decremented when the consumer drains the buffer. The stream will always disconnect after approximately `maxStreamBufferSize` bytes regardless of consumer speed. The backpressure tracking counts bytes enqueued but not bytes dequeued.

- [ ] **SSE stream reader not released on cancellation** (`streaming-agent.ts:462`): In `createSSEStream()`, the `reader` obtained from `tokenStream.getReader()` is never released if the outer SSE stream is cancelled. The underlying token stream becomes locked indefinitely, preventing other consumers from reading. Add a `cancel()` method to the outer `ReadableStream` that calls `reader.cancel()`.

- [ ] **Reader not cleaned up on error in `createStreamingProvider`** (`streaming-agent.ts:68`): If `reader.read()` throws (network failure, provider error), the reader is never cancelled or released. The lock on the provider stream persists even after the chat promise rejects, potentially preventing retry logic. Wrap the read loop in `try/finally { reader.cancel().catch(() => {}) }`.

- [ ] **Observability interceptor uses single mutable root span for concurrent workflows** (`observability/index.ts:179-180`): `currentRootSpan` and `currentWorkflowId` are single variables, not keyed by workflow ID. If multiple workflows run concurrently sharing one interceptor instance, the last `workflowStart` wins and earlier workflows' spans get mis-parented. This is documented in a comment but is a real correctness issue for production use.

- [ ] **Escalation handlers not cleaned up on workflow termination** (`engine.ts:2860-2883`): `#cleanupWaiters` cleans up signal waiters, update waiters, review waiters, and sleep resolvers, but does NOT clean up `#reviewEscalationHandlers`. If a workflow is cancelled while waiting for a human review, the escalation handler remains in the map indefinitely. Add `#reviewEscalationHandlers` cleanup to `#cleanupWaiters`.

### Medium Severity

- [ ] **Race condition between escalation timer and workflow termination** (`engine.ts:2627-2636`): If an escalation timer fires concurrently with `#terminateWorkflow`, the handler at line 2634 can execute after the workflow is already failed/cancelled. The handler calls `#failWorkflow` on an already-terminated workflow. Pre-emptively cancel escalation timers during `#terminateWorkflow` and clean up handlers before cleanup runs.

- [ ] **Event listener not removed on stream close** (`streaming-agent.ts:236`): Abort signal listener registered with `{ once: true }` but never explicitly removed if the stream closes before the signal fires. Holds closure references to `streamController` and other variables.

- [ ] **Observability agent event listener accumulation** (`observability/index.ts:444-449, 462-467`): If the eventTarget exists and an exception throws before the first event fires, listeners stay registered and can fire for unrelated workflows since the interceptor instance may be reused. The workflowId check partially mitigates but doesn't prevent listener accumulation.

- [ ] **No-op span generates random IDs on every call** (`no-op-telemetry.ts:104-119`): When OTel is not installed, every span creation calls `randomHex()` to generate traceId/spanId that are never used. This burns CPU on crypto operations on the hot path. Consider using static sentinel values for no-op spans.

- [ ] **Review webhook fire-and-forget not tied to engine lifecycle** (`engine.ts:2705-2717`): The webhook `fetch()` is fire-and-forget with `.catch()` logging, but not wrapped in `AbortController`-based cancellation tied to engine disposal. If the engine is disposed while the fetch is pending, the error handler may not execute properly.

- [ ] **Zero resource leaks test exists but does not meet original criteria**: `resource-leaks.test.ts` runs 1000 iterations and checks heap growth stays under 5MB. Architecture doc claims "no file handle or memory growth" — the test uses a generous 5MB threshold which may mask slow leaks.
