# Roadmap

A running list of remaining issues, gaps, and follow-ups discovered while reading through the docs and code. Each item should carry enough context that we can pick it up cold later without re-doing the investigation.

This file tracks remaining work only. Completed roadmap items belong in git history and pull request records, not in the active queue.

## 1. Architecture Gap Closure

These items are still present in `reference/architecture.md` and are not completed in the current implementation.

- [ ] **Close the activity-completion throughput gap to the architecture target.**

  **Where:** `src/benchmarks/activity-completions.test.ts`, `src/benchmarks/activity-completions-runner.ts`, terminal workflow cleanup in `src/core/engine/termination.ts`, and hot-path storage writes around activity completion.

  The architecture target is `>30K/sec` activity completions on a single node with SQLite. The current isolated subprocess benchmark is still below that target, with the latest architecture notes and `reference/IMPORTANT.md` reporting roughly `22.3K/sec`. The remaining suspected gap is terminal scratch cleanup on the completion hot path plus SQLite synchronization cost; prefer batching, coalescing, or deferring cleanup over weakening the target.

  **Acceptance criteria:**
  - The non-coverage architecture benchmark enforces at least `30_000` activity completions per second outside constrained Codex runners.
  - The benchmark runs in a fresh subprocess and reports sample values, median throughput, target, coverage mode, and spec target.
  - The implementation keeps terminal cleanup correct for workflow state, checkpoints, review keys, signal/update/review waiters, stream chunks, and search-attribute indexes.
  - Regression tests cover any cleanup queue, batch coalescing, or storage-write changes introduced to move cleanup off the hot path.
  - Verification passes with `bun run lint`, `bun run typecheck`, `WEFT_ACTIVITY_COMPLETION_ARCHITECTURE_BENCHMARK=1 bun test src/benchmarks/activity-completions.test.ts`, and `bun run verify:documentation`.

- [ ] **Add a head-to-head Temporal workflow-start benchmark.**

  **Where:** new benchmark harness under `src/benchmarks/`, new `benchmark:temporal-workflow-starts` package script, `reference/IMPORTANT.md`, and `documentation/architecture/performance.md`.

  `reference/architecture.md` still carries the unchecked claim that Weft is `10x faster than Temporal on workflow start` when benchmarked head-to-head. Weft's own workflow-start admission benchmark now exceeds its internal target, but the Temporal comparison is not currently backed by an executable harness in this repository.

  **Acceptance criteria:**
  - A dedicated benchmark documents its prerequisites and can run Weft and Temporal workflow-start measurements from one command.
  - The benchmark reports enough environment metadata to make the comparison reproducible: runtime versions, storage mode, database location, workflow count, concurrency, warmup count, and median throughput.
  - The default test suite does not require a Temporal server, but the comparison command fails clearly when the required Temporal dependency is missing or not running.
  - `reference/IMPORTANT.md` and `documentation/architecture/performance.md` record the latest measured ratio and link to the benchmark command.
  - Verification passes with `bun run lint`, `bun run typecheck`, `bun run benchmark:temporal-workflow-starts` in an environment with Temporal available, and `bun run verify:documentation`.

## 2. Production Visibility and Fleet Tooling

Weft already has the production primitives operators need to build on: events, metrics, workflow timelines, search attributes, worker registries, task queues, bulk operations, schedules, retention controls, and a built-in dashboard. The remaining gap is turning those primitives into a robust operator control plane for live workflow fleets and remote workers.

The shape should stay Weft-native rather than copying Temporal feature names. Useful reference points include [Temporal Visibility](https://docs.temporal.io/visibility), [Temporal Worker performance](https://docs.temporal.io/develop/worker-performance), [Temporal Worker Versioning](https://docs.temporal.io/worker-versioning), and [Temporal task queue priority and fairness](https://docs.temporal.io/develop/task-queue-priority-fairness), but the implementation should fit Weft's checkpoint model, operation catalog, dashboard, and RemoteWorker protocol.

- [x] **Add production workflow visibility queries and aggregates.**

  **Where:** `src/core/list-filter-validation.ts`, `src/core/aggregate-validation.ts`, `src/core/engine/{listing,aggregate,workflow-indexes,workflow-visibility-queries,list-candidate-resolution}.ts`, `src/core/bulk-workflow-filter.ts`, `src/server/operations/{list-workflows,aggregate-workflows}.ts`, `scripts/rebuild-workflow-visibility-indexes.ts`, and the dashboard data layer in `src/dashboard/{api-client,utilities/workflow-list-data}.ts`.

  Shipped a typed visibility filter (`idPrefix`, time ranges, `tenantId`, `failureCategory`, status arrays) and a single-dimension aggregate operation, both backed by new `wf-idx-*` secondary indexes with a backfill-driven watermark gate. Pre-watermark queries fall back to the existing slow path; post-watermark queries narrow through the indexes. Distinct-key and scan caps surface as `Unprocessable` faults.

  **Acceptance criteria:**
  - `engine.list()` and `GET /v1/workflows` share one validation path through `normalizeListFilter`; the filter shape is identical across REST, JSON-RPC HTTP/WS/stdio, and in-process callers.
  - `engine.aggregate()` and `weft.workflows.aggregate` (`GET /v1/workflows/aggregate`) return grouped counts over the same filter shape, supporting `status`, `type`, `tenant`, `failureCategory`, and arbitrary search attributes.
  - Dashboard data layer (`api-client.aggregateWorkflows`, `buildWorkflowListFilter`, `loadWorkflowAggregate`) round-trips every new filter dimension. **Svelte UI controls are tracked as a follow-up task** to land alongside a design pass against the existing component vocabulary.
  - Invalid filter fields, unknown aggregate attribute names, and scan/distinct-key cap exhaustion all throw before storage scans begin and map to `Unprocessable`.
  - Verification passed with the full `bun test` suite (4756 pass / 0 functional fail), `bun run lint`, `bun run typecheck`, and `bun run verify:documentation`. Replay-fixture and checkpoint-compat binaries regenerated to embed the new `wf-idx-manifest:` rows.

- [ ] **Add safe operator bulk actions with dry-run previews.**

  **Where:** `src/core/engine/bulk-operations.ts`, `src/server/operations/bulk-*.ts`, workflow event/audit plumbing, dashboard bulk-action flows, and `documentation/reference/api-server.md`.

  Upgrade bulk workflow operations into an operator-grade surface: dry-run counts, sampled affected workflow ids, scope summaries, required confirmation tokens for destructive actions, and durable audit events for cancel, signal, delete, tag mutation, retry, and recover where applicable. Keep all actions filter-driven and tenant-aware so operators can preview exactly what will be affected before committing.

  **Acceptance criteria:**
  - Bulk cancel, signal, delete, tag mutation, retry, and recover operations support a `dryRun` mode that returns counts, scope summaries, and sampled workflow ids without mutating state.
  - Destructive bulk actions require a confirmation token derived from the dry-run scope and reject stale or mismatched confirmations.
  - Every committed bulk action emits durable audit events containing the caller principal, filter summary, action type, affected count, sampled ids, and request id.
  - Dashboard bulk-action flows force preview before commit and make tenant scope, filters, and affected counts visible before confirmation.
  - Verification passes with `bun run lint`, `bun run typecheck`, `bun test src/core/bulk-operations.test.ts src/server/operations/bulk-cancel-workflows.test.ts src/server/operations/bulk-delete-workflows.test.ts src/server/operations/bulk-signal-workflows.test.ts src/server/operations/bulk-mutate-workflow-tags.test.ts`, and `bun run verify:documentation`.

## 3. MCP Server Support

Per the AI Surface Shrinkage decision, Weft does not ship a [Model Context Protocol (MCP)](https://modelcontextprotocol.io/) client. Weft's workflow surface is a separate concern: registered workflows can be exposed as durable MCP tools and resources to external MCP clients.

- [ ] **Add MCP catalog discovery metadata.**

  **Where:** extend the OpenRPC document with an `x-weft-mcp` extension and add a `/.well-known/mcp.json` route for the live MCP server.

  Native MCP `tools/list` is the canonical live introspection surface. The static catalog is for build-time consumers and deployment discovery, so keep it minimal.

  **Acceptance criteria:**
  - `/.well-known/mcp.json` points clients at the correct MCP transport endpoints.
  - OpenRPC includes enough `x-weft-mcp` metadata to connect the static operation catalog to live MCP tool discovery.
  - Static metadata tests fail if MCP-enabled workflows are omitted.
  - Verification passes with `bun run lint`, `bun run typecheck`, targeted catalog tests, and `bun run verify:documentation`.
