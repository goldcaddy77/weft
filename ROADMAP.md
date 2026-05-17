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

## 2. Oxlint Strict Cleanup

Recent cleanup work removed several clusters of `oxlint-disable` directives, but the repository still carries active suppressions across core, diagnostics, server, worker, storage, dashboard, and testing surfaces. The task graph now tracks each remaining domain-specific refactor and a final enforcement task.

- [ ] **Finish the remaining oxlint suppression refactors.**

  **Where:** `src/core/**`, `src/diagnostics/**`, `src/server/**`, `src/worker/**`, `src/storage/**`, `src/dashboard/**`, `src/testing/**`, and the task graph entries tagged `oxlint-strict`.

  The merged CLI, client, engine-operations, checkpoint, and codec cleanup pull requests reduced the inventory, but current source still contains suppressions for core context, scheduler/search-attribute/tenant-quota helpers, diagnostics and observability, server transports and operations, worker protocol and registry code, dashboard helpers, storage delete-prefix paths, and testing helpers. Keep each domain refactor behavior-preserving and remove suppressions only when the code is genuinely below the enforced threshold or the remaining directive has a durable architectural rationale.

  **Acceptance criteria:**
  - Every live `oxlint-strict` blocker task is completed or explicitly narrowed to justified permanent suppressions.
  - `rg -n "oxlint-disable" src` shows at most five permanent production suppressions, each with an inline rationale.
  - `scripts/check-lint-disables.ts` enforces the permanent-suppression ceiling and inline-rationale requirement.
  - The capstone task removes stale inventory assumptions and documents the resulting policy.
  - Verification passes with `bun run lint`, `bun run typecheck`, `bun run typecheck:tests`, `bun test`, and `bun run verify:documentation`.
