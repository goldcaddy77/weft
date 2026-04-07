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
- [ ] **Tenant in worker-execution mode**: `WorkerExecutionStrategy` still drops the resolved tenant across the `postMessage` boundary. As of 2026-04-07 the `Engine` constructor throws when both `workerExecution` and `tenantResolver` are configured, closing the isolation bypass as a stop-gap. Full fix still requires extending `WorkerInboundMessage.run` to carry the tenant and constructing an engine-equivalent `Context` inside `src/workers/workflow-runner.ts`.
- [~] **AI dashboard detail view (core landed)**: `workflow-detail-agent.svelte` already composes the agent fragments into a per-workflow view (route `/ui/workflows/:id/agent`). The three proposed extra fragments (cost waterfall, conversation, reasoning trace) remain deferred until the underlying event data is emitted end-to-end.

## Addressed in follow-up PR (2026-04-07)

The PR #73 review items previously tracked here have been resolved. Summary of measured outcomes:

- **Fair-share routing via `serve()`**: `TaskDispatch.fairShareKey` now threads through `dispatchTaskImpl` → `findWorker` → `assignTask`. Integration test in `src/server/index.test.ts` asserts six `tenant-alpha` tasks distribute evenly across three workers.
- **Worker-mode tenant isolation stop-gap**: `Engine` constructor throws when `workerExecution` and `tenantResolver` are both configured. Tracked above until the protocol is extended.
- **`WorkerRegistry.unregister()` cleanup**: `unregister` now purges `#fairShareCounts` and any `#inFlightTasks` entries matching the worker id; covered by `src/worker/registry.test.ts`.
- **Abort listener leak in `TaskQueue.poll`**: poll now removes its abort listener on every settle path. Regression test wraps the `AbortSignal` in a counting proxy and asserts 50 polls = 50 add + 50 remove calls.
- **`engine.list()` fast path parallelization**: replaced the serial `for..of` loop with `Promise.all` over `storage.get`; test verifies order preservation and filter semantics.
- **LIFO starvation documentation**: JSDoc on the `'lifo'` variant carries a prominent starvation warning and the `TaskQueue` constructor emits a one-time `console.warn` when `'lifo'` is paired with a finite `pendingTaskTimeToLive`.
- **`decodeWorkflowState` runtime tenant guard**: added `isValidDecodedTenant` predicate; corrupt tenant fields are warned and rewritten to `undefined` during decode.
- **Round-robin cursor desync**: cursor now keyed by `(queue, activityName)` tuple; new test covers mixed-activity workloads on a shared queue.
- **`paginateWorkflowSummaries.total` semantics**: JSDoc clarifies `total` is the filtered count.
- **`tenantFromInputField` numeric ids**: accepts finite numbers and coerces to strings.
- **`tenant.test.ts` SQLite file leak**: `afterEach` hook removes the temp `.sqlite`/`-wal`/`-shm` files via `node:fs`.
- **`/v1/metrics` PII warning**: `PrometheusExporter` JSDoc now carries a `> [!WARNING]` block explaining the default-public endpoint and recommending `auth.publicPaths` gating when labels are sensitive.
- **Custom exporter exception handling**: `handleGetMetrics` wraps `exporter.serialize()` in try/catch and returns a 503 JSON error response instead of a 500.
- **`ctx.suspendUntil` JSDoc**: updated to clarify that the slot-release benefit applies only to inline execution; worker-mode caveat documented.
- **Dashboard agent detail view buffer**: `events` now capped at 2000 entries with oldest-first eviction on both WS append and initial fetch paths.
- **Attribute scan fan-out**: `#resolveConstrainedIds` now uses a small worker-pool helper capping concurrent storage scans at 8.
