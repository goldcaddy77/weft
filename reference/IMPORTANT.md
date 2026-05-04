# Code Review Findings

Last reviewed: 2026-04-12

Action items surfaced by code review. Items here are also tracked in the **"Competitive Parity & Gap Closure"** section of `reference/architecture.md` where they correspond to acceptance criteria. When an item ships, flip the box here and update the architecture doc in the same commit.

## Open Action Items

- [~] **Performance targets measured against spec** (2026-04-07, updated 2026-04-30): Re-measured after optimizations. Findings:
  - **Workflow recovery**: spec `<1ms`, measured `~0.08ms` median → **meets spec** (12x headroom).
  - **Cold start (library mode)**: spec `<50ms`, measured `~0.14ms` median → **meets spec**.
  - **Cold start (binary mode)**: spec `<100ms`, measured `~36ms` median (warm-cache, 5-run median on Apple Silicon) → **meets spec**.
  - **Event dispatch**: spec `<100μs`, measured `~0.18μs` per dispatch → **meets spec** (500x headroom).
  - **Search attribute scan (100K workflows)**: spec `<1ms`, measured `~0.14ms` median → **meets spec** (in-memory SQLite only).
  - **Sustained-load RSS guardrail**: spec `bounded post-warmup RSS drift while sustaining >10K workflows/sec`, measured on 2026-05-02 by `src/benchmarks/load-growth-memory.test.ts` as a three-trial fresh-subprocess benchmark. The gate uses SQLite plus zero terminal retention to isolate steady-state engine churn, and it passes only when median throughput stays above `10K/sec`, post-warmup RSS delta stays below `3MB`, and post-warmup RSS band stays below `4MB` → **meets spec**.
  - **Workflow starts**: spec `>50K/sec`, re-measured on 2026-04-30 at `~28.5K/sec` isolated median → **partially closed**, still ~1.8x short. Latest optimizations: deadline timer operations folded into the start batch (eliminating a separate storage transaction), checkpoint history pruning made non-blocking. Remaining gap is dominated by the per-start SQLite WAL fsync and the inline strategy's generator drive; closing it further requires pipelining the start batch or moving to a binary checkpoint format.
  - **Activity completions**: spec `>30K/sec`, re-measured on 2026-04-30 at `~22.3K/sec` isolated subprocess median → **partially closed**, still ~1.3x short. Latest optimizations: completion state write and attribute cleanup batched into a single storage transaction, scheduler cancel made fire-and-forget for terminal workflows, `#cleanupWorkflowStorage` and `#cleanupReviews` now use `deletePrefix` instead of scan-then-delete loops. Remaining gap requires coalescing terminal cleanup across workflow batches or deferring it to a background queue.
  - **Memory per workflow**: spec `≤2KB`, re-measured on 2026-04-30 at `~132 bytes` for the current checkpoint blob and `~743 bytes` for the total durable idle-workflow footprint across 100K parked workflows → **meets spec**.
  - **Worker spawn**: spec `<5ms`, re-measured on 2026-05-01 at `~2.3ms` isolated subprocess median via `src/benchmarks/worker-spawn-runner.ts` → **meets spec**. The default non-coverage benchmark gate in `src/benchmarks/worker-spawn.test.ts` now enforces the real `<5ms` target because the measurement no longer shares a process with the rest of the suite.

## Resolved Items (2026-05-02)

- [x] **No-unbounded-growth criterion lacked a sustained-load regression benchmark** (2026-05-02 → fixed 2026-05-02): `src/benchmarks/load-growth-memory.test.ts` now shells into `src/benchmarks/load-growth-memory-runner.ts`, runs three short sustained-load trials in fresh Bun subprocesses, and asserts bounded post-warmup RSS delta/band alongside throughput.

## Resolved Items (2026-05-01)

- [x] **Worker spawn benchmark gate was looser than the architecture target** (2026-04-30 → fixed 2026-05-01): `src/benchmarks/worker-spawn.test.ts` now shells into `src/benchmarks/worker-spawn-runner.ts`, so the default non-coverage gate can enforce the actual `<5ms` spec without flaking on full-suite scheduler noise.

## Resolved Items (2026-04-30)

- [x] **Memory-per-workflow benchmark measured RSS instead of durable workflow footprint** (2026-04-30 → fixed 2026-04-30): `src/benchmarks/memory-per-workflow.test.ts` now measures stored bytes across 100K parked workflows in a fresh subprocess, reporting both current-checkpoint size and total durable footprint per workflow. This matches the architecture's checkpoint-oriented memory claim and closes the `≤2KB` target.

## Resolved Items (2026-04-12)

- [x] **Architecture.md performance numbers out of sync with IMPORTANT.md** (2026-04-12 → fixed 2026-04-12): Updated the prose paragraph and checklist items in architecture.md to match the latest measurements (`~19K/sec` workflow starts, `~10K/sec` activity completions).
- [x] **`#failWorkflow` leaks `#resultResolvers` if `#cleanupTerminalWorkflow` throws** (2026-04-12 → fixed 2026-04-12): Wrapped cleanup + event dispatch + resolve/reject in try-finally in both `#completeWorkflow` and `#failWorkflow` so the resolver entry is always deleted.
- [x] **`start()` leaks `#checkpoints` and `#workflowVersionTuples` on failure** (2026-04-12 → fixed 2026-04-12): Extended the `!startSucceeded` guard in `start()`'s finally block to also delete `#checkpoints` and `#workflowVersionTuples` entries.
- [x] **Scheduler deletes timer entry even when callback fails** (2026-04-12 → fixed 2026-04-12): Moved the storage delete into the try block after the successful callback, so failed timers are retained for retry on the next tick. Updated test assertions accordingly.
- [x] **Scheduler `decode()` results cast without validation** (2026-04-12 → fixed 2026-04-12): Added runtime type guards before using decoded values in `cancel()` and `#processExpiredTimers`. Corrupted entries are now logged and skipped instead of silently producing incorrect behavior.
- [x] **`#cleanupWaiters` does O(total-waiters) prefix scan** (2026-04-12 → fixed 2026-04-12): Added reverse indexes (`#signalWaitersByWorkflow`, `#updateWaitersByWorkflow`, `#reviewWaitersByWorkflow`) maintained at all waiter mutation sites, replacing the O(total-waiters) prefix scan with O(workflow's-waiters) direct lookups.

## Resolved Items (2026-04-11)

- [x] **`MetricsCollector` histogram arrays grow without bound** (2026-04-10 → fixed 2026-04-11): Replaced unbounded `number[]` with a `CircularBuffer` backed by `Float64Array`, capped at 10,000 samples per histogram name (~80KB max).
- [x] **`PromptCache.#evictOldest` creates quadratic intermediate arrays** (2026-04-10 → fixed 2026-04-11): Replaced the `[...ancestors, node]` spread per stack entry with a two-pass approach: Pass 1 finds the oldest terminal with no ancestor arrays. Pass 2 does a targeted path walk from root to target.
- [x] **`PromptCache` uses FIFO eviction instead of LRU** (2026-04-10 → fixed 2026-04-11): Re-inserting an existing terminal now refreshes `node.sequence` so frequently-used prefixes are retained.
- [x] **`validateRegistrations` mislabels standalone activities** (2026-04-10 → fixed 2026-04-10): Standalone activities now always labelled `'(standalone)'`.
- [x] **Shared `BudgetTracker` race in `supervise` finally block** (2026-04-10 → fixed 2026-04-11): The finally block now only detaches the controller if `budget.signal === controller.signal`, preventing concurrent `supervise()` calls from overwriting each other's controllers.
