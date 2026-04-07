# Code Review Findings

Last reviewed: 2026-04-07

All items in this list are also tracked as acceptance criteria in the **"Competitive Parity & Gap Closure"** section of `reference/architecture.md`. Keep the two lists in sync: when an item flips to `[x]` in the architecture doc, flip it here as well (or remove it and add a brief note of the measured outcome).

## Not Yet Implemented (Notable Gaps)

- [~] **Performance targets measured against spec** (2026-04-06): The spec thresholds in `reference/architecture.md` "Performance Targets" were measured with the current benchmark suite (`bun test src/benchmarks`). Findings:
  - **Workflow recovery**: spec `<1ms`, measured `~0.08ms` median → **meets spec** (12x headroom).
  - **Cold start (library mode)**: spec `<50ms`, measured `0.18ms` median → **meets spec**.
  - **Event dispatch**: spec `<100μs`, measured `~0.17μs` per dispatch → **meets spec** (500x headroom).
  - **Search attribute scan (100K workflows)**: spec `<1ms`, measured `~0.14ms` median → **meets spec** (in-memory SQLite only — see issue below).
  - **Activity completions**: spec `>30K/sec`, measured `~9K/sec` → **does not meet spec** (3x short; relaxed test still passes at 3K/sec).
  - **Workflow starts**: spec `>50K/sec`, measured `~13K/sec` → **does not meet spec** (4x short; relaxed test still passes at 5K/sec).
  - **Memory per workflow**: spec `≤2KB`, measured `~7KB` in isolation and `~15KB` under full-suite pollution → **does not meet spec** (3-7x over; also a flaky benchmark — suite order causes the jump from 7KB to 15KB).
  - **Cold start (binary mode)**: spec `<100ms`, measured `~1022ms` → **does not meet spec** (10x over; this may be measurement-method dependent — the binary bundle spawn cost dominates).
    The gaps are genuine architectural work, not benchmark sloppiness. Any future attempt to hit the spec targets should start with workflow start throughput and memory-per-workflow, since those are the two the architecture doc most loudly advertises.
- [ ] **Tenant in worker-execution mode**: `WorkerExecutionStrategy` currently drops the resolved tenant — the `WorkerInboundMessage` `'run'` payload doesn't carry it across the `postMessage` boundary, and the worker-side runner in `src/workers/workflow-runner.ts` doesn't construct a `Context` with engine-side fields anyway. Inline mode honors `ctx.tenant` correctly. Closing this gap requires extending the worker protocol AND giving the worker-side runner access to the engine's tenant-aware Context construction. **Security impact**: when an agent registered with `validateInput` or `toolsForTenant` runs in worker mode, the hooks see `ctx.tenant === undefined`. A `validateInput` written as "throw if tenant missing" fails open for unrelated reasons; a `toolsForTenant` returning admin tools on `undefined` leaks privileges. As a stop-gap, the engine should refuse to start when `workerExecution` and `tenantResolver` are both configured, until the protocol is extended.
- [~] **AI dashboard detail view (core landed)**: `workflow-detail-agent.svelte` already composes the agent fragments into a per-workflow view (route `/ui/workflows/:id/agent`). The three proposed extra fragments (cost waterfall, conversation, reasoning trace) remain deferred until the underlying event data is emitted end-to-end.

## New Findings — Code Review of PR #73 (commit 76bc891, 2026-04-07)

### Critical

- [ ] **Fair-share routing is dead-on-arrival via `serve()`** (`src/server/index.ts:125-144`, `src/server/index.ts:1442-1443`). The serve-options doc claims `fairShareKey` can be passed at dispatch time via `TaskDispatch`, but the `TaskDispatch` interface does not declare the field, and `dispatchTaskImpl` never threads it into `findWorker`. Setting `routingPolicy: 'fair-share'` on `serve()` is unconditionally a silent fall-back to `least-loaded`. **Fix**: add `fairShareKey?: string` to `TaskDispatch`, thread it through `findWorker` and `assignTask`, and add an integration test that asserts fair-share actually distributes across keys. Alternatively: remove the misleading "until an end-to-end hook is added" wording and document fair-share as registry-only.

- [ ] **Worker mode silently drops resolved tenant — tenant isolation bypass** (`src/core/worker-execution-strategy.ts:78-94`). Covered above in the "Tenant in worker-execution mode" item; tracking the security stop-gap separately so it doesn't get lost: until the protocol is extended, the engine constructor should `throw` when `workerExecution` and `tenantResolver` are both set.

### High

- [ ] **`WorkerRegistry.unregister()` does not clean up `#fairShareCounts`** (`src/worker/registry.ts:97-103`). On a clean disconnect the in-flight loop in `src/server/index.ts:1067-1070` calls `completeTask` for each held task and that releases counts — but `unregister` itself never purges the row, so any future code path that bypasses the in-flight loop (crash recovery, forced removal, registry reset) leaves rows behind. **Fix**: have `unregister` purge `#fairShareCounts.get(workerId)` and any `#inFlightTasks` entries whose `workerId` matches.

- [ ] **Abort listener leak in `TaskQueue.poll`** (`src/server/task-queue.ts:205-207`). `signal.addEventListener('abort', () => settle(null), { once: true })` is registered with no removal when the task arrives or the timer fires normally. `{ once: true }` only prunes the listener after `abort` actually fires; for long-lived signals (one per worker poll loop, which polls thousands of times), each poll leaves a closure on the AbortSignal until the signal itself is GC'd. **Fix**: capture the listener function and call `signal.removeEventListener('abort', listener)` inside `settle` before resolving, or wrap each poll in its own `AbortController` and abort it on settle.

- [ ] **`engine.list()` fast path issues serial `storage.get` per matched id** (`src/core/engine.ts:1180-1198`). The benchmark in `src/benchmarks/search-attributes-scan.test.ts` reports 0.14ms because it uses `BunSQLiteStorage(':memory:')` where each `get` is microseconds. On any remote storage backend (network KV, S3-backed) this becomes N sequential round-trips and undoes the 1200x perf claim. **Fix**: parallelize with `Promise.all` (cheap), or add a `storage.batchGet([keys])` primitive and use it here. At minimum, document that the benchmark is in-memory-only and tag the perf claim accordingly.

- [ ] **LIFO scheduling policy can starve tasks indefinitely with no warning** (`src/server/task-queue.ts:300-344`). Under sustained load, tasks at the bottom of the LIFO stack only get dequeued when the burst stops. Their `pendingTaskTimeToLive` (default 5min) fires and they get rejected by `#expireTask`. The user gets no signal that LIFO was responsible — just spurious "task expired" failures. **Fix**: document the starvation property prominently on `SchedulingPolicy = 'lifo'`. Consider rejecting LIFO + finite TTL combinations at `serve()` time, or emitting a warning when expiration rate exceeds a threshold.

### Medium

- [ ] **`decodeWorkflowState` is an unchecked `as` cast over arbitrary storage bytes** (`src/core/engine.ts:206-209`). Pre-existed for other fields, but now that `state.tenant` is passed directly into `validateInput`/`toolsForTenant`, a corrupt or tampered storage record can inject an arbitrary `tenant` value (e.g. `{id: 'admin', attributes: {...}}`) into security-relevant decision functions. **Fix**: add a runtime guard (Zod schema or type predicate) for `WorkflowState` at decode time, at least validating `tenant.id` is a string.

- [ ] **Round-robin cursor desynchronizes under mixed-activity workloads** (`src/worker/registry.ts:181-190`). The cursor is keyed by queue, but the eligible set is `(queue ∩ activity ∩ has-capacity)`. When two activities share one queue (A: 3 workers, B: 1 worker), interleaved requests advance the same cursor and the A-only requests skip workers. Tests at `src/worker/registry-routing.test.ts:91-100` verify per-queue cursors but not per-(queue, activity). **Fix**: key the cursor by `(queue, activity)` tuple, or accept the imperfection and document it.

- [ ] **`paginateWorkflowSummaries.total` semantics ambiguous after fast-path branch** (`src/core/engine.ts:361-373`). `total` reflects the matched count under filter, not the absolute population. Pre-existing, but the new fast path makes it more visible: a UI showing "page 1 of N" computed from `total` will be correct for the filter but the absolute count is unrecoverable from the response. **Fix**: document on the API that `total` is the filtered total, or add a separate `unfilteredTotal` field.

- [ ] **`tenantFromInputField` silently drops numeric ids** (`src/core/tenant.ts:69-78`). `if (typeof value !== 'string' || value.length === 0) return undefined;` — a workflow input with `{tenantId: 12345}` (common when tenant ids come from numeric DB keys) returns no tenant, with no warning. The user thinks they configured tenancy correctly and silently runs un-tenanted. **Fix**: accept `number` and coerce to string, or throw on non-string with a clear error.

- [ ] **`tenant.test.ts` recovery test leaks SQLite files** (`src/core/tenant.test.ts:142-194`). Each test run leaves a `/tmp/weft-tenant-recovery-${uuid}.sqlite` file behind. Other tests in this codebase use `:memory:`. **Fix**: `afterAll(() => Bun.file(path).delete())`, or switch to `:memory:`.

- [ ] **`/v1/metrics` is unauthenticated by default — custom exporter could leak labels** (`src/server/handler.ts:905-915`). `DEFAULT_PUBLIC_PATHS` includes `/v1/metrics`. Plugging in an OTel exporter that includes labels with PII or tenant ids makes them publicly readable on the default config. The `PrometheusExporter` JSDoc has no warning. **Fix**: add an explicit warning in `PrometheusExporter` JSDoc that `/v1/metrics` is public by default, and recommend gating it behind `auth.publicPaths` if labels are sensitive.

- [ ] **Custom exporter exceptions surface as unhandled 500** (`src/server/handler.ts:909`). `await exporter.serialize()` has no try/catch. A misbehaving custom exporter (e.g. an OTel SDK in a degraded state) crashes the metrics endpoint with no graceful fallback. **Fix**: wrap in try/catch and return a 503 with a one-line error, or fall back to `serializeMetricsSnapshotForPrometheus({})`.

### Low

- [ ] **`ctx.suspendUntil` doc claim does not hold in worker mode** (`src/core/context.ts:496-498`). The JSDoc says "the worker is free to pick up other work while the workflow is parked" — true only in inline-execution. In `WorkerExecutionStrategy`, the worker is held on `#workersByWorkflowId` until the workflow completes, so `suspendUntil` does not actually release the worker. **Fix**: document the inline-only nature of the slot-release benefit, or actually release the worker on suspend in worker mode.

- [ ] **Dashboard agent detail view: unbounded events buffer** (`src/dashboard/views/workflow-detail-agent.svelte:236, 161`). `events = [...events, event]` on every WS message and `buildAgentTurns(events)` recomputes from scratch on each push via `$derived.by`. For a long-running agent with thousands of token events, the dashboard slows linearly and memory grows unbounded. **Fix**: cap the buffer (e.g. last N events), and either memoize the turn map incrementally or store turns as `$state` updated per event.

- [ ] **Unbounded fan-out on attribute filter scans** (`src/core/engine.ts:1442-1446`). `Promise.all` over attribute filters issues N concurrent storage scans. Fine for SQLite, problematic for any backend with connection limits. **Fix**: bound concurrency via a small semaphore or `p-limit`-style helper.
