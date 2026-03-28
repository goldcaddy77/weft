# Code Review Findings

Last reviewed: 2026-03-28

## Architecture Doc Discrepancies

- [ ] **`Weft.Context` vs `Context`**: Architecture doc uses `Weft.Context` as a type annotation in 18 examples. Actual implementation exports `Context` directly (not namespaced). Readers following examples need `import { Context } from 'weft'`.

- [ ] **`engine.profile()` not implemented**: Architecture doc shows `engine.profile()` returning checkpoint/task timing metrics. No such method exists on the Engine class. Either implement or remove from doc.

- [ ] **`alerts` configuration not implemented**: Architecture doc shows alert rules and webhook hooks in Engine constructor options. No `alerts` property exists in `EngineOptions`. Either implement or remove from doc.

- [ ] **`AsyncDisposableStack` not used in server setup**: Architecture doc states "AsyncDisposableStack used in server setup" but the server uses manual event listener cleanup and disposable patterns instead. Either implement or update the checklist item.

## Not Yet Implemented (Notable Gaps)

- [ ] **Single binary distribution** (`bun build --compile`). No build script for standalone executables.
- [ ] **MCP server integration** for agent tools. Full section is unimplemented.
- [ ] **Context window management strategies** (sliding-window, summarize, RAG). Full section is unimplemented.
- [ ] **Multi-agent coordination** (handoff, debate, supervise, SharedState). Full section is unimplemented.
- [ ] **Interceptor system**: Remote worker interceptors not supported. Types defined but runtime wiring incomplete.
- [ ] **OpenTelemetry integration** via interceptors. Full section is unimplemented.
- [ ] **Model routing and fallback chains** for agents. Full section is unimplemented.
- [ ] **Graceful shutdown via `shutdown` message**: No handler for worker-initiated graceful shutdown.
- [ ] **Server cancellation propagated to workers**: Server does not send `cancel` messages over WebSocket.

## Code Review: Server (`src/server/index.ts`)

- [ ] **Sequence counter race condition** (`nextSequence`): The `sequenceCounters` map is accessed without synchronization. Two concurrent events for the same workflow could read the same counter value, producing duplicate sequence numbers.

- [ ] **Uncleared `setTimeout` callbacks on shutdown**: Worker disconnection triggers `setTimeout` for backoff-delayed re-dispatch (line ~604). These timers are not tracked or cleared in `stop()`. If the server stops while backoff delays are pending, tasks are retried against a dead engine.

- [ ] **No concurrency cap on worker registration**: Workers register with a self-reported `concurrency` value (line 505, defaults to 10). No maximum is enforced — a malicious or misconfigured client could claim infinite concurrency, monopolizing task dispatch.

- [ ] **Silent task loss on retry exhaustion**: When `nextAttempt > policy.maxAttempts` (lines 588, 696), the task is silently dropped. No error event is emitted and no permanent failure is recorded — the workflow that dispatched the activity never learns the task failed.

- [ ] **`AbortController` in `wireEventBroadcasting` not aborted on stop**: The controller created at line ~178 is not explicitly aborted in `stop()`, leaving engine event listeners attached until GC.

## Code Review: Task Queue (`src/server/task-queue.ts`)

- [ ] **Pending tasks without waiters accumulate indefinitely**: If a task is enqueued but no worker ever polls for it (no matching activities), the task stays in `#pending` forever. No expiration or cleanup mechanism exists.

- [ ] **Completion callbacks leak if task never dispatched**: Callbacks in `#completionCallbacks` are never invoked or removed if the task was enqueued but never actually polled by a worker.

## Code Review: Activity Worker (`src/workers/activity-worker-entry.ts`)

- [ ] **Blob URL never revoked**: `createActivityWorker` (line ~81) creates a Blob URL via `URL.createObjectURL()` but never calls `URL.revokeObjectURL()`. Each worker instantiation leaks a URL registration.

- [ ] **Function serialization via `toString()` is fragile**: `handler.toString()` (line ~69) only works for functions without closures. Arrow functions that capture outer scope, class methods, or functions referencing module-level variables silently produce broken worker scripts with no validation.

## Code Review: Activity Worker Dispatcher (`src/workers/activity-worker-dispatcher.ts`)

- [ ] **No timeout on worker response**: The promise in `execute()` (line ~33) has no timeout. If the worker never responds (wrong `operationId`, crash without error event), the promise hangs indefinitely. The worker is released back to the pool in the `finally` block, but the caller's context leaks.

## Code Review: Engine (`src/core/engine.ts`)

- [ ] **Sleep resolvers not cleaned up on workflow termination**: `#sleepResolvers` stores resolver functions per workflow, but `#cleanupWaiters` (line ~2088) only cleans signal/update waiters — not sleep resolvers. After many workflow cancellations, orphaned resolver references accumulate.

- [ ] **Agent operation double-charging on crash recovery**: Lines ~1978-1988 record org budget costs without an idempotent marker. If a crash occurs between the budget record and the next checkpoint, a replayed agent operation charges the budget twice.

- [ ] **Duplicate workflow ID check is not atomic**: `start()` at line ~505 checks for an existing workflow then writes, but with a race window between check and write. Two concurrent `start()` calls with the same ID could both pass the check.

## Code Review: Worker Registry (`src/worker/registry.ts`)

- [ ] **`checkExpiredTasks()` returns expired tasks but does not remove them**: Expired tasks are returned from `#inFlightTasks` but never deleted by the method itself. Callers must handle removal. If a caller forgets, the map grows unbounded.

- [ ] **`extendVisibility` uses absolute deadline**: `extendVisibility()` sets `deadline = Date.now() + extension` (line ~146). This should be relative to the current deadline, not `Date.now()` — rapid successive heartbeats effectively shorten the actual timeout window.

## Code Review: Long-Poll Worker (`src/worker/long-poll.ts`)

- [ ] **Stop race condition**: `stop()` sets `#running = false` then aborts, but `#pollLoop` checks `#running` before the abort signal is processed. New fetch requests could still be initiated between the flag set and the abort.

- [ ] **Unknown activity silently dropped**: If the server sends a task for an activity the long-poll worker doesn't recognize (lines ~142-145), the method returns without error. The server never learns the task was unprocessable — it's effectively lost.

## Code Review: Authentication (`src/server/authentication.ts`)

- [ ] **Public path matching is exact**: `Set.has()` on line ~362 matches pathnames exactly. Paths with trailing slashes or query parameters (e.g., `/v1/health?foo=bar`) won't match `/v1/health`. Use `url.pathname` (without query string) and normalize trailing slashes.

- [ ] **Silent JWT fallthrough**: Invalid JWTs are silently caught (line ~381), falling through to the next auth method. An attacker could send a malformed JWT and still authenticate via API key without any indication of the JWT failure. Consider logging JWT validation failures.
