# Code Review Findings

Last reviewed: 2026-04-12

Action items surfaced by code review. Items here are also tracked in the **"Competitive Parity & Gap Closure"** section of `reference/architecture.md` where they correspond to acceptance criteria. When an item ships, flip the box here and update the architecture doc in the same commit.

## Open Action Items

- [~] **Performance targets measured against spec** (2026-04-07, updated 2026-04-11): Re-measured after optimizations. Findings:
  - **Workflow recovery**: spec `<1ms`, measured `~0.08ms` median → **meets spec** (12x headroom).
  - **Cold start (library mode)**: spec `<50ms`, measured `~0.14ms` median → **meets spec**.
  - **Cold start (binary mode)**: spec `<100ms`, measured `~36ms` median (warm-cache, 5-run median on Apple Silicon) → **meets spec**.
  - **Event dispatch**: spec `<100μs`, measured `~0.18μs` per dispatch → **meets spec** (500x headroom).
  - **Search attribute scan (100K workflows)**: spec `<1ms`, measured `~0.14ms` median → **meets spec** (in-memory SQLite only).
  - **Workflow starts**: spec `>50K/sec`, measured `~19K/sec` → **partially closed**, still ~2.6x short. Latest optimizations: deadline timer operations folded into the start batch (eliminating a separate storage transaction), checkpoint history pruning made non-blocking. Remaining gap is dominated by the per-start SQLite WAL fsync and the inline strategy's generator drive; closing it further requires pipelining the start batch or moving to a binary checkpoint format.
  - **Activity completions**: spec `>30K/sec`, measured `~10K/sec` → **partially closed**, still ~3x short. Latest optimizations: completion state write and attribute cleanup batched into a single storage transaction, scheduler cancel made fire-and-forget for terminal workflows, `#cleanupWorkflowStorage` and `#cleanupReviews` now use `deletePrefix` instead of scan-then-delete loops. Remaining gap requires coalescing terminal cleanup across workflow batches or deferring it to a background queue.
  - **Memory per workflow**: spec `≤2KB`, measured `~6.8KB` in isolation and `~7.7-9.3KB` under full-suite pollution → **partially closed**, still 3-4x over. Closing the gap to 2KB requires architectural changes — releasing suspended generators between yields, or adopting a binary checkpoint format that lets the engine evict in-memory state on suspension.

- [ ] **Architecture.md performance numbers out of sync with IMPORTANT.md** (2026-04-12): Architecture.md § Performance Targets still shows `~21K/sec` workflow starts and `~14K/sec` activity completions (from a prior measurement), while IMPORTANT.md (updated 2026-04-11) shows the latest measurements at `~19K/sec` and `~10K/sec` respectively. The architecture.md numbers at lines 5508–5509 need to be corrected to match.

- [ ] **`#failWorkflow` leaks `#resultResolvers` if `#cleanupTerminalWorkflow` throws** (2026-04-12): In `engine.ts:4859–4901`, the `#resultResolvers.delete(workflowId)` call at line 4899 only runs if `#cleanupTerminalWorkflow` (line 4890) succeeds. If cleanup throws, the resolver entry is never deleted and leaks memory. Same pattern in `#completeWorkflow` (lines 4852–4856). Fix: wrap the cleanup + resolve/reject in try-finally so the resolver is always deleted.

- [ ] **`start()` leaks `#checkpoints` and `#workflowVersionTuples` on failure** (2026-04-12): In `engine.ts:1401–1454`, the finally block (line 1449) only cleans up `#agentWorkflowIds` on failure. If `#createWorkflowHandle` or `#startWorkflowExecution` throws after the batch write, `#checkpoints.set` (line 1401) and `#workflowVersionTuples.set` (line 1404) are not reverted, leaving orphaned entries. Fix: add `this.#checkpoints.delete(workflowId)` and `this.#workflowVersionTuples.delete(workflowId)` to the `!startSucceeded` guard.

- [ ] **Scheduler deletes timer entry even when callback fails** (2026-04-12): In `scheduler.ts:200–210`, `#onTimerFired` failures are caught and logged, but the timer key is still deleted from storage (lines 206–210). This means a transient failure (e.g., storage I/O error during the callback's state write) permanently loses the timer. Fix: move the delete into the try block after the successful callback, so failed timers are retried on the next tick.

- [ ] **Scheduler `decode()` results cast without validation** (2026-04-12): In `scheduler.ts:149` and `scheduler.ts:189`, `decode(value)` results are cast with `as string` and `as TimerEntry` without runtime type checks. Corrupted storage values would silently produce incorrect behavior. Fix: add type guards or Zod validation before using decoded values.

- [ ] **`#cleanupWaiters` does O(total-waiters) prefix scan** (2026-04-12): In `engine.ts:4759–4769`, `#cleanupWaiters` iterates all keys in `#signalWaiters`, `#updateWaiters`, and `#reviewWaiters` to find prefix matches for a single workflow. Under high concurrency with many active workflows, this is O(total waiters) instead of O(workflow's waiters). Fix: maintain a reverse index from `workflowId` to its waiter keys (similar to the existing `#sleepResolversByWorkflow` pattern used for sleep resolvers at lines 4770–4779).

## Resolved Items (2026-04-11)

- [x] **`MetricsCollector` histogram arrays grow without bound** (2026-04-10 → fixed 2026-04-11): Replaced unbounded `number[]` with a `CircularBuffer` backed by `Float64Array`, capped at 10,000 samples per histogram name (~80KB max).
- [x] **`PromptCache.#evictOldest` creates quadratic intermediate arrays** (2026-04-10 → fixed 2026-04-11): Replaced the `[...ancestors, node]` spread per stack entry with a two-pass approach: Pass 1 finds the oldest terminal with no ancestor arrays. Pass 2 does a targeted path walk from root to target.
- [x] **`PromptCache` uses FIFO eviction instead of LRU** (2026-04-10 → fixed 2026-04-11): Re-inserting an existing terminal now refreshes `node.sequence` so frequently-used prefixes are retained.
- [x] **`validateRegistrations` mislabels standalone activities** (2026-04-10 → fixed 2026-04-10): Standalone activities now always labelled `'(standalone)'`.
- [x] **Shared `BudgetTracker` race in `supervise` finally block** (2026-04-10 → fixed 2026-04-11): The finally block now only detaches the controller if `budget.signal === controller.signal`, preventing concurrent `supervise()` calls from overwriting each other's controllers.
