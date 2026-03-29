# Code Review Findings

Last reviewed: 2026-03-29

## Architecture Doc Discrepancies

- [ ] **`engine.profile()` not implemented**: Architecture doc shows `engine.profile()` returning checkpoint/task timing metrics. No such method exists on the Engine class. Either implement or remove from doc.

- [ ] **`alerts` configuration not implemented**: Architecture doc shows alert rules and webhook hooks in Engine constructor options. No `alerts` property exists in `EngineOptions`. Either implement or remove from doc.

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

- [ ] **Sequence counter race condition** (`nextSequence` at lines 230–239): The read-modify-write pattern on `sequenceCounters` is not atomic. Two concurrent events for the same workflow can produce duplicate sequence numbers.

- [ ] **Uncleared `setTimeout` callbacks on shutdown** (lines 668, 804): Backoff-delayed re-dispatch timers via `setTimeout` are not tracked or cleared in `stop()`. If the server stops while these are pending, `dispatchTaskImpl()` fires against a dead engine.

- [ ] **No concurrency cap on worker registration** (lines 536–541): Workers self-report `concurrency` with no validation or cap. A misconfigured client could claim `Infinity`, monopolizing task dispatch.

- [ ] **Silent task loss on retry exhaustion** (lines 627–636, 771–776): When `nextAttempt > policy.maxAttempts`, the task is marked `'failed'` in storage via `transitionInflightToResolved` but no `ActivityFailedEvent` is emitted. The workflow that dispatched this activity hangs indefinitely.

- [ ] **No validation of `visibilityTimeout` in task dispatch** (line 825): `task.visibilityTimeout` is accepted as-is with no bounds checking. Negative values cause immediate expiry; `Infinity` prevents expiry entirely.

- [ ] **Fire-and-forget async operations lack retry** (lines 275–303, 577–585, 608–682, 714–737): Multiple critical async paths (event persistence, visibility extension, worker requeue, inflight restoration) use `void (async () => { ... })()` with only `console.error` on failure. No retry or alerting.

## Code Review: Task Queue (`src/server/task-queue.ts`)

- [ ] **Pending tasks without waiters accumulate indefinitely**: If a task is enqueued but no worker ever polls for it (no matching activities), the task stays in `#pending` forever. No expiration or cleanup mechanism exists.

- [ ] **Completion callbacks leak if task never dispatched**: Callbacks in `#completionCallbacks` are never invoked or removed if the task was enqueued but never actually polled by a worker.

## Code Review: Activity Worker (`src/workers/activity-worker-entry.ts`)

- [ ] **Blob URL never revoked** (line 81): `createActivityWorker` creates a Blob URL via `URL.createObjectURL()` but never calls `URL.revokeObjectURL()`. Each worker instantiation leaks a URL registration.

- [ ] **Function serialization via `toString()` is fragile** (line 69): `handler.toString()` only works for functions without closures. Arrow functions that capture outer scope, class methods, or functions referencing module-level variables silently produce broken worker scripts with no validation.

## Code Review: Activity Worker Dispatcher (`src/workers/activity-worker-dispatcher.ts`)

- [ ] **No timeout on worker response** (lines 33–58): The promise in `execute()` waits for `worker.onmessage` indefinitely. If the worker crashes without emitting an error event, or sends the wrong `operationId`, the promise hangs forever and the caller's context leaks.

## Code Review: Engine (`src/core/engine.ts`)

- [ ] **Sleep resolvers not cleaned up on workflow termination**: `#sleepResolvers` stores resolver functions per workflow, but `#cleanupWaiters` (line ~2088) only cleans signal/update waiters — not sleep resolvers. After many workflow cancellations, orphaned resolver references accumulate.

- [ ] **Agent operation double-charging on crash recovery** (lines ~1984–1989): Cost recording happens before checkpoint persistence. If a crash occurs between the budget record and the next checkpoint, a replayed agent operation charges the budget twice.

- [ ] **Duplicate workflow ID check is not atomic** (`start()` at line ~503–538): The check `#workflows.has(id)` is separate from the actual creation at line ~538. Two concurrent `start()` calls with the same ID could both pass the check.

## Code Review: Worker Registry (`src/worker/registry.ts`)

- [ ] **`checkExpiredTasks()` returns expired tasks but does not remove them** (lines 130–140): Expired tasks are returned from `#inFlightTasks` but never deleted by the method. Callers must handle removal. If a caller forgets, the map grows unbounded and the same expired tasks are returned on every poll.

- [ ] **`extendVisibility` overwrites deadline from `Date.now()`** (lines 143–145): `extendVisibility()` sets `deadline = Date.now() + extension`, which resets from current time rather than extending from the existing deadline. Rapid successive heartbeats effectively shorten the timeout window.

## Code Review: Long-Poll Worker (`src/worker/long-poll.ts`)

- [ ] **Stop race condition** (lines 55–63): `stop()` sets `#running = false` then aborts. The poll loop checks `#running` before the abort signal is processed, so one additional `fetch()` can be initiated between the flag set and the abort.

- [ ] **Unknown activity silently dropped** (lines 145–147): If the server sends a task for an activity the long-poll worker doesn't recognize, `#executeTask` returns without error. The server never learns the task was unprocessable — it eventually times out or retries indefinitely.

## Code Review: Authentication (`src/server/authentication.ts`)

- [ ] **Public path matching is exact** (line 362): `Set.has()` matches pathnames exactly. Paths with trailing slashes won't match (e.g., `/v1/health/` vs `/v1/health`). Consider normalizing trailing slashes on `url.pathname`.

- [ ] **Silent JWT fallthrough** (lines 375–385): Invalid JWTs are silently caught, falling through to the next auth method. An attacker could send a malformed JWT and still authenticate via API key without any indication of the JWT failure. Consider logging JWT validation failures.
