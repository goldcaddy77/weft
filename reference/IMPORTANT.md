# Code Review Findings

Last reviewed: 2026-04-09

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
