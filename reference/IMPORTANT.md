# Code Review Findings

Last reviewed: 2026-04-06

All items in this list are also tracked as acceptance criteria in the **"Competitive Parity & Gap Closure"** section of `reference/architecture.md`. Keep the two lists in sync: when an item flips to `[x]` in the architecture doc, flip it here as well (or remove it and add a brief note of the measured outcome).

## Not Yet Implemented (Notable Gaps)

- [~] **Performance targets measured against spec** (2026-04-06): The spec thresholds in `reference/architecture.md` "Performance Targets" were measured with the current benchmark suite (`bun test src/benchmarks`). Findings:
  - **Workflow recovery**: spec `<1ms`, measured `~0.08ms` median → **meets spec** (12x headroom).
  - **Cold start (library mode)**: spec `<50ms`, measured `0.18ms` median → **meets spec**.
  - **Event dispatch**: spec `<100μs`, measured `~0.17μs` per dispatch → **meets spec** (500x headroom).
  - **Search attribute scan (100K workflows)**: spec `<1ms`, measured `~0.14ms` median → **meets spec**.
  - **Activity completions**: spec `>30K/sec`, measured `~9K/sec` → **does not meet spec** (3x short; relaxed test still passes at 3K/sec).
  - **Workflow starts**: spec `>50K/sec`, measured `~13K/sec` → **does not meet spec** (4x short; relaxed test still passes at 5K/sec).
  - **Memory per workflow**: spec `≤2KB`, measured `~7KB` in isolation and `~15KB` under full-suite pollution → **does not meet spec** (3-7x over; also a flaky benchmark — suite order causes the jump from 7KB to 15KB).
  - **Cold start (binary mode)**: spec `<100ms`, measured `~1022ms` → **does not meet spec** (10x over; this may be measurement-method dependent — the binary bundle spawn cost dominates).
    The gaps are genuine architectural work, not benchmark sloppiness. Any future attempt to hit the spec targets should start with workflow start throughput and memory-per-workflow, since those are the two the architecture doc most loudly advertises.
- [x] **Index scan performance benchmark**: `src/benchmarks/search-attributes-scan.test.ts` verifies the spec. Measured ~0.14ms median / ~0.2ms p95 on 100K workflows with `BunSQLiteStorage` after fixing `engine.list()` to load constrained IDs directly instead of full-scanning `wf:*`.
- [x] **OTel metrics exporter pluggable**: `/v1/metrics` now delegates to a `PrometheusExporter` interface in `src/observability/metrics.ts`. Default implementation still sources from `MetricsCollector`, but projects that install `@opentelemetry/exporter-prometheus` can adapt it to the interface and pass it via `ServeOptions.prometheusExporter` — no changes to weft core required.
- [x] **JSDoc examples added**: Module-level `weft` docs and `Engine` / `activity` / `defineAgent` carry `@example` blocks. Key new primitives (tenant, routing, scheduling, Prometheus exporter) are exported from `src/index.ts`.
- [x] **Serverless suspension primitive**: `ctx.suspendUntil(resumeToken)` in `src/core/context.ts` parks a workflow in its checkpoint until an external signal with the matching token is delivered. Agent-loop integration (automatic suspension during LLM waits) still requires a provider that exposes async resume hints and remains opt-in / deferred.
- [x] **Multi-tenant primitives**: `TenantResolver` and `ctx.tenant` live in `src/core/tenant.ts`; `defineAgent()` supports `toolsForTenant` and `validateInput` hooks. Tenancy state survives recovery via `WorkflowState.tenant`.
- [x] **Routing and scheduling policies**: `WorkerRegistry` supports `least-loaded`, `round-robin`, `fair-share`; `TaskQueue` supports `priority`, `fifo`, `lifo`. Both plumbed through `serve()` options.
- [~] **AI dashboard detail view (core landed)**: `workflow-detail-agent.svelte` already composes the agent fragments into a per-workflow view (route `/ui/workflows/:id/agent`). The three proposed extra fragments (cost waterfall, conversation, reasoning trace) remain deferred until the underlying event data is emitted end-to-end.
