# Code Review Findings

Last reviewed: 2026-04-10

Action items surfaced by code review. Items here are also tracked in the **"Competitive Parity & Gap Closure"** section of `reference/architecture.md` where they correspond to acceptance criteria. When an item ships, flip the box here and update the architecture doc in the same commit.

## Open Action Items

- [~] **Performance targets measured against spec** (2026-04-07): Re-measured after Item 3 optimizations (prepared-statement caching in `BunSQLiteStorage`, auto-id dedup-skip on the start path, completion-state-merge dedup, nesting-depth-map allocation skip, and a benchmark methodology fix for cold start). Findings:
  - **Workflow recovery**: spec `<1ms`, measured `~0.08ms` median → **meets spec** (12x headroom).
  - **Cold start (library mode)**: spec `<50ms`, measured `~0.14ms` median → **meets spec**.
  - **Cold start (binary mode)**: spec `<100ms`, measured `~36ms` median (warm-cache, 5-run median on Apple Silicon) → **meets spec**.
  - **Event dispatch**: spec `<100μs`, measured `~0.18μs` per dispatch → **meets spec** (500x headroom).
  - **Search attribute scan (100K workflows)**: spec `<1ms`, measured `~0.14ms` median → **meets spec** (in-memory SQLite only).
  - **Workflow starts**: spec `>50K/sec`, measured `~21K/sec` → **partially closed**, still 2.4x short. Remaining gap is dominated by the single SQLite WAL fsync per `start()` and the inline strategy's generator drive on the main thread; closing it further requires pipelining the start batch or moving to a binary checkpoint format.
  - **Activity completions**: spec `>30K/sec`, measured `~14K/sec` → **partially closed**, still 2.1x short. Remaining gap is dominated by the per-workflow scheduler cancel and `#cleanupTerminalWorkflow` deletes; coalescing them into the completion batch is the next lever.
  - **Memory per workflow**: spec `≤2KB`, measured `~6.8KB` in isolation and `~7.7-9.3KB` under full-suite pollution → **partially closed**, still 3-4x over. Closing the gap to 2KB requires architectural changes — releasing suspended generators between yields, or adopting a binary checkpoint format that lets the engine evict in-memory state on suspension.

- [ ] **`MetricsCollector` histogram arrays grow without bound** (2026-04-10): `src/observability/metrics.ts:74-77` — each `record()` call pushes to an unbounded `number[]` per histogram name. Under sustained load (thousands of activity completions), these arrays grow indefinitely until `reset()` is called. The `snapshot()` method also copies and sorts the full array, doubling memory pressure. Fix: replace with a circular buffer or streaming percentile algorithm (t-digest) to cap memory. Severity: medium under sustained load without periodic resets.

- [ ] **`PromptCache.#evictOldest` creates quadratic intermediate arrays** (2026-04-10): `src/ai/prompt-cache.ts:353` — the DFS spreads `[...ancestors, node]` for every child pushed onto the stack, creating O(B^D × D) temporary arrays during a single eviction pass. For large `maxEntries` under write churn this is unnecessary allocation pressure. Fix: use a mutable path array with `push`/`pop` instead of spreading a new array per stack entry. Severity: medium performance concern.

- [ ] **`PromptCache` uses FIFO eviction instead of LRU** (2026-04-10): `src/ai/prompt-cache.ts:293` — re-inserting an existing terminal returns early without refreshing `node.sequence`, so frequently-used prefixes can be evicted before rarely-used newer ones. If LRU semantics are desired, update the sequence number on re-access. Severity: low, design choice to evaluate.

- [ ] **`validateRegistrations` mislabels standalone activities** (2026-04-10): `src/diagnostics/validate.ts:165` — standalone activities passed via the `activities` parameter are labelled with `workflowTypes[0]` instead of `'(standalone)'`. When multiple workflow types are registered, activities are misleadingly attributed to the first one. Fix: always use `'(standalone)'` for explicitly-passed activities.

- [ ] **Shared `BudgetTracker` race in `supervise` finally block** (2026-04-10): `src/ai/coordination.ts:505-507` — the `finally` block replaces the budget's abort controller with a fresh `new AbortController()`. If two concurrent `supervise` calls share the same budget tracker, the first to finish overwrites the controller the second is still using. Fix: only detach if the current controller matches the one this call installed, or scope the controller per-call rather than per-budget.
