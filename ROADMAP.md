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

- [ ] **Add production workflow visibility queries and aggregates.**

  **Where:** `src/core/bulk-workflow-filter.ts`, `src/core/engine/query.ts`, `src/server/operations/list-workflows.ts`, new workflow-visibility aggregate operations, dashboard workflow-list utilities, and `documentation/reference/api-server.md`.

  Extend workflow listing beyond the current status/type/tag filters with a typed visibility filter for workflow status, type, id prefix, tags, search attributes, created and updated time ranges, execution deadlines, tenant id, and failure category. Add count and group aggregates for status, workflow type, tenant, and selected search attributes so operators can answer fleet questions without exporting raw workflow rows.

  **Acceptance criteria:**
  - `engine.list()` and the transport operation behind `GET /v1/workflows` share one typed visibility filter instead of drifting between in-process, REST, and JSON-RPC inputs.
  - A new aggregate operation returns counts grouped by status, workflow type, tenant id, and selected search attributes with the same visibility filter semantics as workflow listing.
  - The dashboard exposes the richer filters and aggregate summary panels without requiring dashboard-only endpoints.
  - Invalid filter fields and unsupported aggregate dimensions fail with clear diagnostics before scanning workflow storage.
  - Verification passes with `bun run lint`, `bun run typecheck`, `bun test src/server/operations/list-workflows.test.ts src/server/attribute-filters.test.ts src/dashboard/utilities/workflow-list-data.test.ts`, and `bun run verify:documentation`.

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

Per the AI Surface Shrinkage decision, Weft does not ship an MCP client. Weft's workflow surface is a separate concern: registered workflows can be exposed as durable MCP tools and resources to external MCP clients.

- [ ] **Implement an MCP server exposing Weft as a first-class MCP service.**

  **Deployment shapes:**
  - **Remote MCP over Streamable HTTP:** add an authenticated MCP endpoint to the existing server transport surface. Support client-to-server POST, server-to-client GET/SSE, and session resumption via `Mcp-Session-Id`.
  - **Local stdio package:** publish a `weft-mcp` or `@weft/mcp` binary that can run embedded against local storage or proxy to a remote Weft server.

  **Server behavior:**
  - Handle `initialize`, `notifications/initialized`, `notifications/cancelled`, `tools/list`, `tools/call`, `resources/list`, `resources/read`, `resources/subscribe`, `resources/unsubscribe`, `resources/templates/list`, `prompts/list`, `prompts/get`, `logging/setLevel`, `ping`, and `completion/complete`.
  - Advertise `tools`, `resources`, optional `prompts`, and `logging` capabilities.
  - Expose each eligible registered workflow as an MCP tool with a JSON Schema `inputSchema`.
  - Include engine-control tools such as `start_workflow`, `signal_workflow`, `update_workflow`, `query_workflow`, `cancel_workflow`, `list_workflows`, and `get_workflow_state`.
  - Expose read-only resources for workflow state, checkpoint history, event logs, and search-attribute query results.
  - Return `tools/call` failures as `isError: true` content blocks, not JSON-RPC protocol errors.
  - Map MCP cancellation to `engine.cancel(id)` and emit progress notifications for long-running calls.

  **Rules:**
  - Tool names are lowercase with underscores.
  - Tool descriptions come from workflow registration metadata.
  - Activities are never exposed as standalone MCP tools; workflows are the durable unit.
  - Every MCP-exposed workflow must have an input schema.
  - Remote tenant scoping resolves from session authentication; local embedded mode is single-tenant; local proxy forwards the configured token.

  **Acceptance criteria:**
  - A reference MCP client can initialize, list tools, call a workflow tool, cancel an in-flight call, read a workflow resource, and subscribe to resource updates.
  - Both remote HTTP and local stdio transports have integration tests.
  - Authorization and tenant-scoping tests prove cross-tenant data is not exposed.
  - Verification passes with `bun run lint`, `bun run typecheck`, targeted MCP tests, and `bun run verify:documentation`.

- [ ] **Add MCP catalog discovery metadata.**

  **Where:** extend the OpenRPC document with an `x-weft-mcp` extension and add a `/.well-known/mcp.json` route once the live MCP server exists.

  Native MCP `tools/list` is the canonical live introspection surface. The static catalog is for build-time consumers and deployment discovery, so keep it minimal.

  **Acceptance criteria:**
  - `/.well-known/mcp.json` points clients at the correct MCP transport endpoints.
  - OpenRPC includes enough `x-weft-mcp` metadata to connect the static operation catalog to live MCP tool discovery.
  - Static metadata tests fail if MCP-enabled workflows are omitted.
  - Verification passes with `bun run lint`, `bun run typecheck`, targeted catalog tests, and `bun run verify:documentation`.
