# Weft Roadmap and Checklist

This file is the execution-facing architecture document for Weft. Keep it checklist-first: acceptance criteria, gap-closure items, performance targets, and verification gates belong here.

The narrative architecture material, examples, and long-form rationale now live in companion documents:

- [Overview and Context](./architecture/overview-and-context.md): problem statement, thesis, why Temporal is the wrong fit, competitive landscape, and the high-level gaps.
- [Platform Foundations](./architecture/platform-foundations.md): design philosophy, vocabulary, web-standards foundation, checkpointing, workers, eventing, resource management, and memory model.
- [Runtime and Deployment](./architecture/runtime-and-deployment.md): storage decisions, binary distribution, browser and service-worker runtime, HTTP and WebSocket serving, and remote workers.
- [Agent-Native Engine](./architecture/agent-engine.md): the durable agent model, streaming, budgets, human review, MCP integration, coordination, and agent observability.
- [Workflow Platform Features](./architecture/workflow-platform-features.md): versioning, timeouts, search attributes, updates, interceptors, and observability.
- [Performance and Examples](./architecture/performance-and-examples.md): performance framing, module map, hello-world examples, and resolved open questions.
- [Research Gap Analysis](./architecture/research-gap-analysis.md): the 2024–2026 research synthesis that informs the roadmap below.

> [!NOTE]
> New explanatory prose and example-heavy material should go in one of the companion documents above and then be linked from this file. Keep this file optimized for planning, review, and execution.

## Acceptance Criteria Checklist

### Core Engine

- [x] **Workflows are AsyncGenerator functions.** `async function*` is the only way to define a workflow. No decorator magic, no class-based API, no code transformation.
- [x] **Each `yield*` creates a checkpoint.** Checkpoint contains: step index, local variable snapshot (via `structuredClone` semantics), accumulated results.
- [x] **Recovery is O(1).** Loading a checkpoint from storage and resuming the generator does not replay previous steps. Verified by benchmark: recovery time is constant regardless of workflow history length.
- [x] **No determinism requirement.** `Date.now()`, `Math.random()`, `crypto.randomUUID()`, and network calls are permitted inside workflows between checkpoint boundaries.
- [x] **`ctx.run(fn, ...args)` dispatches a durable activity.** Activity results survive process crashes. Idempotency keys prevent double-execution.
- [x] **`ctx.sleep(duration)` is a durable timer.** Survives process restarts. Fires within 1 second of scheduled time after recovery.
- [x] **`ctx.signal(name)` / `ctx.waitForSignal(name)` support durable signals.** Signals persist in storage and are delivered even if the workflow is not currently loaded in memory.
- [x] **`ctx.all([...])` runs operations in parallel.** Equivalent to `Promise.all` but each branch is independently checkpointed.
- [x] **`ctx.race([...])` runs operations with first-wins semantics.** Losing branches are cancelled via `AbortController`.
- [x] **`ctx.memo(key, fn)` caches derived values in the checkpoint.** On recovery, returns cached value without re-executing `fn`.
- [x] **Cancellation uses `AbortController`.** `handle.cancel()` propagates an abort signal through the workflow. `finally` blocks execute cleanup. Cleanup can yield to durable operations.
- [x] **Retry policy supports exponential backoff.** Configurable per-activity: `maxAttempts`, `initialBackoff`, `backoffMultiplier`, `maxBackoff`, `nonRetryableErrors`.
- [x] **Child workflows are independently checkpointed.** Parent stores child workflow ID reference, not child state.
- [x] **Max nesting depth is configurable.** Default: 10 levels. Exceeding throws a clear error.

### Event System

- [x] **`Engine` extends `EventTarget`.** All events dispatched via `dispatchEvent()`.
- [x] **All events are `Event` subclasses.** No use of `CustomEvent`. Properties are directly on the event object, not in `.detail`.
- [x] **Typed `addEventListener` overloads.** TypeScript infers correct event type from the event name string.
- [x] **`AbortSignal`-based listener cleanup.** Passing `{ signal }` to `addEventListener` removes the listener when the signal aborts.
- [x] **`WorkflowHandle` extends `EventTarget`.** Receives events scoped to its workflow.
- [x] **`WorkflowHandle` implements `Symbol.asyncIterator`.** `for await (const event of handle)` works.
- [x] **`WorkflowHandle` implements `Symbol.observable`.** RxJS `from(handle)` works without adapters.
- [x] **Event types defined:** `workflow:started`, `workflow:completed`, `workflow:failed`, `workflow:cancelled`, `workflow:timed-out`, `activity:started`, `activity:completed`, `activity:failed`, `agent:token`, `signal:received`, `signal:delivered`, `attributes:changed`, `update:received`, `update:completed`.

### Resource Management

- [x] **`Engine` implements `Disposable` and `AsyncDisposable`.** Both `using` and `await using` work.
- [x] **`WorkflowHandle` implements `AsyncDisposable`.** `await using handle = ...` cleans up listeners.
- [x] **`WorkerPool` implements `Disposable` and `AsyncDisposable`.** Sync: immediate termination. Async: graceful drain.
- [x] **`BunSQLiteStorage` implements `Disposable`.** Closes database connection.
- [x] **`LMDBStorage` implements `Disposable`.** Closes LMDB environment.
- [x] **`Scheduler` implements `Disposable`.** Clears intervals and timers.
- [x] **`AsyncDisposableStack` used in server setup.** All server resources cleaned up in reverse order on shutdown.
- [x] **Zero resource leaks under test.** `resource-leaks.test.ts` runs 1000 create/run/dispose cycles and asserts heap growth under 2MB after a warmup period.

### Memory Management

- [x] **Checkpoint cache uses `WeakRef`.** Cached checkpoints are GC-eligible. Cache miss triggers storage re-read.
- [x] **`FinalizationRegistry` cleans up dead cache entries.** No periodic sweep timer needed.
- [x] **Activity registry uses `Map<string, Function>`.** Activities are keyed by name; registered via `engine.registerActivity(name, fn)`.
- [x] **Handle registry uses `WeakRef`.** Engine doesn't prevent GC of dropped handles.
- [x] **`Transferable` used for Worker communication.** Checkpoint `ArrayBuffer` is transferred, not copied, to/from Workers.
- [ ] **Memory per idle workflow ≤ 2KB.** Verified by benchmark with 100K concurrent workflows.
- [ ] **No unbounded growth under load.** Memory profiling over 1 hour of sustained 10K workflows/sec shows stable RSS.

### Storage

- [x] **`Storage` interface is KV-oriented.** `get`, `put`, `delete`, `scan`, `batch`.
- [x] **`BunSQLiteStorage` uses `Bun.SQL` tagged templates.** Not raw `bun:sqlite`.
- [x] **`BunSQLiteStorage` uses `WITHOUT ROWID` tables.** Verified in schema.
- [x] **`BunSQLiteStorage` sets WAL mode, `synchronous = NORMAL`, 64MB cache.** Verified by `PRAGMA` queries in tests.
- [x] **`LMDBStorage` uses `lmdb-js` with async write batching.** Reads are synchronous zero-copy.
- [x] **`IndexedDBStorage` works in browsers.** Tested in Chrome, Firefox, Safari.
- [x] **`MemoryStorage` exists for testing.** Fast, no I/O, no dependencies.
- [x] **Turso adapter exists for distributed deployments.** Same interface, connection string change.
- [x] **All storage adapters implement `Disposable`.** `using storage = new XStorage(...)` works.
- [x] **50K+ writes/sec on SQLite.** Benchmarked on commodity hardware (M1 MacBook or equivalent).
- [x] **Batch operations are atomic.** All-or-nothing semantics verified by crash injection tests.
- [ ] **`has`, `deletePrefix`, `keys`, `count` convenience methods.** See Track 6 for full acceptance criteria.
- [ ] **`scoped()` namespace utility and `withCodec()` typed wrapper.** See Track 6 for full acceptance criteria.

### Web Workers

- [x] **Workflow execution runs in Web Workers.** Not on the main thread.
- [x] **Activity execution runs in Web Workers.** Configurable pool size.
- [x] **Worker crash doesn't crash the engine.** Main thread detects termination, marks workflow/activity as failed, spins up replacement.
- [x] **`BroadcastChannel` used for cross-worker coordination.** Signal delivery, event fan-out.
- [x] **`postMessage` uses transfer lists for `ArrayBuffer` data.** Zero-copy verified.
- [x] **Worker pool implements concurrency limits.** Configurable per queue.
- [x] **`smol: true` option available.** For high-workflow-count scenarios with constrained memory.
- [x] **Same Worker code runs in browser Web Workers.** Verified by browser integration test.

### HTTP / WebSocket Server

- [x] **Uses `Bun.serve()` routes syntax.** Not manual URL parsing.
- [x] **JSON by default, MessagePack opt-in.** `Accept: application/msgpack` header.
- [x] **OpenAPI document at `/openapi.json`.** Exposes the HTTP surface as OpenAPI 3.1 with route, parameter, request-body, response, and security definitions for every supported endpoint.
- [x] **WebSocket upgrade for worker streams.** `WS /v1/tasks/:queue/stream`.
- [x] **WebSocket upgrade for workflow observation.** `WS /v1/workflows/:id/watch`.
- [x] **WebSocket upgrade for token streaming.** `WS /v1/workflows/:id/stream`.
- [x] **Bun's built-in pub/sub (`ws.subscribe` / `server.publish`).** No external message broker.
- [x] **Long-poll fallback for non-WebSocket environments.** `GET /v1/tasks/:queue` with timeout.
- [x] **Prometheus metrics at `/v1/metrics`.** All counters, gauges, histograms defined.
- [x] **Built-in web dashboard at `/ui`.** Pre-built SPA embedded in binary.
- [x] **Auth: API keys, JWT, optional mTLS.** Configurable in `serve()` options.

### Library/Server Parity

- [x] **Every HTTP endpoint has a corresponding `Engine` method.** `POST /v1/workflows` → `engine.start()`, `GET /v1/workflows/:id` → `engine.get()`, etc. No server-only features.
- [x] **Every `Engine` method is exposed via HTTP.** No library-only features that server-mode users cannot access.
- [x] **`client/local.ts` and `client/index.ts` export the same interface.** Switching from library to server mode is a constructor change, not an API change.
- [x] **Workflow code is identical across modes.** The same `async function*` runs in library mode, server mode, and browser/Service Worker mode without modification.
- [x] **Event observation works in both modes.** Library mode uses `EventTarget` directly; server mode bridges events over WebSocket. Same event types, same semantics.
- [x] **Agent features (streaming, budget, human review) work in both modes.** No agent capability is server-only or library-only.

### Remote Workers

- [x] **Workers connect via `WS /v1/tasks/:queue/stream`.** Server-push task dispatch, not client-poll.
- [x] **Worker sends `register` on connect.** Includes: identity, activity names, concurrency limit.
- [x] **Server tracks worker capacity.** `concurrency - inFlight` determines whether to push tasks.
- [x] **Each task assigned to exactly one worker.** No client-side race conditions. Server makes assignment decision.
- [x] **Queue-based routing.** `ctx.run(fn, args, { queue })` routes the task to workers subscribed to that queue.
- [x] **Sticky routing opt-in.** `ctx.run(fn, args, { sticky: true })` prefers the same worker for cache locality.
- [x] **Least-loaded routing by default.** Server picks the worker with the lowest `inFlight` count.
- [x] **Visibility timeout on every in-flight task.** Default 30 seconds, configurable per activity. Stored in database (survives server restart).
- [x] **Worker heartbeats extend visibility deadline.** `heartbeat` message resets the timeout clock.
- [x] **Heartbeat details are queryable.** Progress info from heartbeats available via `handle.query("activityProgress")`.
- [x] **Worker disconnection triggers task reassignment.** WebSocket `close` event → scan in-flight tasks → requeue with incremented attempt.
- [x] **Visibility timeout expiry triggers task reassignment.** Scheduler scans `op:inflight:*` for expired deadlines.
- [x] **Retry policy respected on reassignment.** `maxAttempts` exceeded → permanent failure. Backoff delay applied between attempts.
- [x] **Graceful shutdown via `shutdown` message.** Worker stops accepting tasks, finishes in-flight work, then disconnects.
- [x] **Task is always in exactly one state.** Queued, in-flight (with visibility deadline), or resolved. No lost tasks.
- [x] **Long-poll fallback at `GET /v1/tasks/:queue`.** Returns a task or `null` after timeout. Paired with `POST /v1/tasks/:queue/complete`.
- [x] **Long-poll client works in any `fetch()` environment.** `LongPollWorker` uses `fetch()` only — Deno, Node.js, Cloudflare Workers, browsers.
- [x] **Server cancellation propagated to workers.** Server sends `cancel` message over WebSocket; worker aborts via `AbortController`.

### Single Binary

- [x] **`bun build --compile` produces standalone executables.** For `darwin-arm64`, `darwin-x64`, `linux-x64`, `linux-arm64`, `windows-x64`.
- [x] **Binary includes Bun runtime + SQLite + dashboard assets.** No external dependencies.
- [x] **CLI flags: `--port`, `--database`, `--no-ui`, `--storage`.** Configurable at launch.
- [ ] **Binary size < 100MB.** Target: ~60MB (Bun runtime is ~50MB, Weft + dashboard ~10MB).
- [ ] **Cold start to first workflow < 100ms.** Measured from process start to HTTP 201 on workflow creation.
- [x] **Cross-compilation from single CI pipeline.** One `build.ts` script, five output binaries.

### Browser / Service Worker

- [x] **Core engine runs in browser Web Workers.** Same workflow code, IndexedDB storage.
- [x] **Service Worker intercepts `/weft/` fetch events.** Same `handleHTTP()` function as server.
- [x] **IndexedDB storage passes all storage interface tests.** Same test suite as SQLite.
- [x] **Client library works with both remote server and local Service Worker.** Same `fetch()` calls, different routing.
- [x] **Service Worker handles Periodic Background Sync for timers.** (Where browser supports it.)

### Agent-Native Engine: Dynamic Execution Shape

- [x] **Agent loops support dynamic step counts.** A `while` loop with `yield*` creates checkpoints at each tool call without declaring the graph shape upfront.
- [x] **Checkpoint size is constant regardless of turn count.** Only the current conversation state and local variables are in the checkpoint, not the full execution history.
- [x] **Step index is a monotonic counter, not a fixed schema position.** Increments with each `yield*` regardless of origin. No step-count pre-declaration required.
- [x] **Agent conversation history accumulates in checkpoint locals.** The message array grows across turns and is captured by `structuredClone` at each boundary. Verified: restoring a checkpoint after 15 turns produces the same conversation array as live execution.
- [x] **Storage scan performance is independent of per-workflow step count.** `scan("wf:{id}")` returns a constant number of keys regardless of how many tool calls the agent executed.
- [x] **Agent loop termination handles all four exit paths.** Final answer (no tool calls), `maxTurns` reached, `tokenBudget` exhausted via `AbortController`, and workflow cancellation all produce a clean checkpoint at the exit boundary.
- [x] **Checkpoint size warning fires for large conversation histories.** `AgentCheckpointSizeWarningEvent` dispatched when an agent's accumulated conversation state exceeds the configurable threshold (default: 64KB).

### Agent-Native Engine: First-Class Streaming

- [x] **`ctx.agent()` returns a `ReadableStream<string>` when `streamTo: "output"` is set.** Standard `ReadableStream` usable with `for await...of`, `.pipeTo()`, and `.pipeThrough()`.
- [x] **Token stream bridges to workflow `EventTarget`.** `TokenEvent` dispatched for each token on both `WorkflowHandle` and `Engine`.
- [x] **Token stream bridges to WebSocket observers.** Connected clients on `WS /v1/workflows/:id/stream` receive tokens in real time via Bun's `server.publish()`.
- [x] **Stream multiplexer fans out single LLM call to multiple consumers.** No duplicate LLM requests. Implemented via custom `StreamMultiplexer` fan-out.
- [x] **Crash recovery mid-stream replays from last completed turn.** Partial token output from interrupted turn is discarded. LLM call re-issued for that turn only.
- [x] **Backpressure propagates from slow consumers via `ReadableStream`.** Configurable buffer limit (default: 64KB). Slow clients disconnected with warning rather than unbounded memory growth. (Note: backpressure tracking is enqueue-only — see IMPORTANT.md.)
- [x] **Client reconnection resumes with partial output.** Server sends accumulated output from completed turns via `ReconnectionBuffer` before streaming new tokens.
- [x] **SSE fallback for non-WebSocket environments.** `GET /v1/workflows/:id/sse` returns Server-Sent Events via `createSSEStream()`.
- [x] **Stream cancellation via `AbortController`.** Aborting the workflow or exceeding budget closes the stream, terminates WebSocket with close frame, and ends SSE connection cleanly.

### Agent-Native Engine: Cost Enforcement

- [x] **`ctx.setBudget()` configures workflow-level cost constraints.** Accepts `maxTokens`, `maxCost` (USD), `warningThreshold`, and per-model pricing. Budget state persists in checkpoint and survives restarts.
- [x] **`ctx.budgetRemaining()` returns current budget state.** Returns `tokensRemaining`, `costRemaining`, `tokensUsed`, `costUsed`, and per-model `breakdown`.
- [x] **`tokenBudget` on `ctx.agent()` enforced via `AbortController`.** `budgetController.abort(new BudgetExceededError(usage))` fires when cumulative usage exceeds budget. Signal propagates to in-flight `fetch()`.
- [x] **`engine.setBudgetPolicy()` sets organization-level budgets.** Daily and monthly limits per namespace. Stored at `budget:{namespace}:daily:{date}` and `budget:{namespace}:monthly:{month}`.
- [x] **Organization budget enforcement is real-time.** Token usage written to budget counter atomically with agent turn checkpoint via `batch()`. Exceeding rejects new `ctx.agent()` calls with `OrganizationBudgetExceededError`.
- [x] **Cost-aware retry skips retries when budget insufficient.** Before retrying, engine checks `ctx.budgetRemaining()`. If estimated retry cost exceeds remaining budget, `BudgetExceededError` thrown instead.
- [x] **Cost queryable via `handle.query("tokenUsage")`.** Returns cumulative token usage breakdown per agent call and per model.
- [x] **`AgentBudgetWarningEvent` dispatched at configurable threshold.** Default: 80% of budget consumed. Dispatched on both `WorkflowHandle` and `Engine`.
- [x] **`AgentBudgetExceededEvent` dispatched when budget exhausted.** Includes breakdown by model and turn.
- [x] **Cost observable as search attribute.** `ctx.agent()` automatically updates `weft:tokenCost` search attribute with cumulative USD cost.
- [x] **Per-turn cost recorded in `AgentTurnCompletedEvent`.** Includes `inputTokens`, `outputTokens`, `cost`, and `cumulativeCost`.
- [x] **`ctx.budgetProjection()` estimates remaining capacity.** Based on average per-turn cost and burn rate.

### Agent-Native Engine: Human-in-the-Loop Protocol

- [x] **`ctx.humanReview()` pauses workflow with structured review request.** Accepts artifact, reviewers, notification config, escalation chain, and `allowPartial` flag. Returns `ReviewDecision` with decision, reviewer, feedback, and per-section decisions.
- [x] **Review request stored durably.** Written to `review:{workflowId}:{reviewId}` in storage. Survives process restarts. Queryable via `GET /v1/workflows/:id/review/:reviewId`.
- [x] **Multi-turn conversation within a review.** `conversation: true` option enables reviewer to ask questions. Each exchange is a signal round-trip via `onMessage` handler. Conversation history persists in checkpoint.
- [x] **Escalation with configurable timeout chains.** `escalation: [{ after: "4 hours", to: "manager-queue" }, { after: "24 hours", action: "auto-approve", auditReason: "timeout" }]`.
- [x] **Partial approval for multi-section output.** `allowPartial: true` enables per-section approve/reject decisions. Workflow receives structured per-section feedback.
- [x] **Webhook notification on review wait.** `notify: { webhook: "..." }` dispatches `fetch()` POST. Fire-and-forget with `.catch()` logging.
- [x] **Review dashboard integration.** Pending reviews listed at `GET /v1/reviews?status=pending`. Reviewers can approve, reject, or comment from the built-in dashboard.
- [x] **Review timeout produces `ReviewTimeoutError`.** If no reviewer responds within timeout and no escalation configured, workflow receives error with review ID and elapsed duration.
- [x] **`HumanReviewRequestedEvent` dispatched when review wait begins.** Includes `workflowId`, `reviewId`, `reviewType`, `reviewers`. Dispatched on both `WorkflowHandle` and `Engine`.
- [x] **`HumanReviewCompletedEvent` dispatched when review submitted.** Includes `workflowId`, `reviewId`, `decision`, `reviewer`, `duration`.
- [x] **Review state cleanup on workflow completion.** `review:*` entries deleted when parent workflow reaches terminal state via `cleanupOperations()`.

### Agent-Native Engine: MCP-Native Tools

- [x] **MCP server URLs accepted as tool sources in `ctx.agent()`.** `tools: [{ mcp: "https://..." }, localFunction]` connects to MCP server and discovers available tools.
- [x] **Dynamic tool discovery via MCP `tools/list`.** Tool definitions fetched at agent start and cached for the duration of the agent loop. New server-side tools available on next `ctx.agent()` call without code changes.
- [x] **Tool schema validation at engine level.** MCP tool input schemas (JSON Schema) validated before dispatching. `ToolSchemaValidationError` includes tool name, expected schema, and actual input.
- [x] **Checkpoint at MCP tool call boundary.** Each MCP invocation preceded by `yield*` checkpoint. Identical durability to local tool calls.
- [x] **MCP tool results flow through same durable pipeline as local tools.** Results annotated with `source: "mcp"` in conversation history and events.
- [x] **Tool registry merges local functions and MCP server tools.** Name collisions produce `ToolNameConflictError` at agent initialization, not at first conflicting call.
- [x] **MCP server authentication.** Supports bearer token, API key, and OAuth2 client credentials via `createOAuth2TokenManager()` with thread-safe token caching and refresh.
- [x] **MCP server health checking at agent start.** Unreachable servers produce `MCPServerUnavailableError` immediately.
- [x] **MCP tool call timeout.** Each invocation respects configurable timeout (default: 30s) via `AbortController` + `setTimeout`. Timeout fires `MCPToolTimeoutError`.
- [x] **`AgentToolCalledEvent` includes `source` field.** Distinguishes `"local"` from `"mcp"` in observability events.
- [x] **MCP stdio and HTTP+SSE transports supported.** Transport inferred from URL scheme (`stdio://` → `StdioTransport`, `http(s)://` → `HttpTransport` or `HttpSseTransport`). Explicit override via `transport: 'sse'` on `MCPToolSource`.

### Agent-Native Engine: Context Window Management

- [x] **Automatic token counting before each LLM call.** Engine counts tokens using provider's tokenizer (heuristic: ~4 chars/token). Count recorded in `AgentTurnStartedEvent`.
- [x] **Configurable context window budget.** `contextWindow: { maxTokens, reservedForOutput }` sets maximum input token count and reserves space for response.
- [x] **Pluggable `ContextStrategy` interface.** Single method: `compact(messages, options): AsyncGenerator<Message[]>`. Generator because strategies like "summarize" need `yield*` for durable operations.
- [x] **Sliding-window strategy drops oldest messages.** Preserves system prompt and most recent N messages.
- [x] **Summarize strategy compresses old messages via secondary LLM call.** Summarization call is itself a checkpointed durable operation.
- [x] **RAG strategy replaces full history with vector-retrieved context.** Pluggable vector store interface.
- [x] **Context state is part of the checkpoint.** After strategy application, compacted context restored directly on recovery. No re-running the strategy.
- [x] **Configurable buffer percentage for early compaction.** `compactAt: 0.85` triggers compaction at 85% of `maxTokens`.
- [x] **`AgentContextCompactedEvent` dispatched when strategy triggers.** Includes strategy name, `tokensBefore`, `tokensAfter`, `messagesDropped`.
- [x] **Default strategy is no-op pass-through.** Full conversation history sent to LLM. `CheckpointSizeWarningEvent` emitted if conversation exceeds size threshold.
- [x] **Composable strategies.** `composeStrategies(slidingWindow(...), summarize(...))` applies strategies in sequence with checkpoints between.

### Agent-Native Engine: Multi-Agent Coordination

- [x] **`ctx.handoff()` transfers execution to another agent with context.** Starts a child workflow running the target agent. Returns the child's result. Delegator pauses at `yield*` boundary.
- [x] **Selective context forwarding in handoff.** `forwardContext: "summary"` sends compressed history. `forwardContext: "none"` sends only structured input.
- [x] **`ctx.debate()` runs adversarial multi-agent review.** Alternates between agents for N rounds. Each round is a checkpoint. Judge agent resolves. Returns verdict plus full transcript.
- [x] **`ctx.supervise()` runs multiple agents with synthesis strategy.** Strategies: `"consensus"` (all agree), `"best-of-n"` (supervisor picks), `"merge"` (combine outputs).
- [x] **`SharedState` primitive with durable CAS operations.** `ctx.sharedState(name, { initial })` returns a handle for concurrent read/write. Optimistic concurrency control with automatic retry on conflict.
- [x] **`SharedState` uses `batch()` for atomic updates.** Writes committed atomically with checkpoint.
- [x] **`ctx.handoff()` preserves OpenTelemetry trace context.** Child workflow spans link back to parent agent's span. `createChildHeaders()` utility in coordination module; engine injects parent headers into handoff options.
- [x] **`ctx.all()` with agent-typed branches.** Parallel agents with independent checkpointing, token budgets, and context windows. Each branch's cost tracked independently.
- [x] **Agent-to-agent message passing via signals.** Agents within same workflow communicate via `ctx.signal()` on child handles.
- [x] **Multi-agent fan-out respects workflow-level budget.** Shared `BudgetTracker` passed through `handoff()`, `debate()`, and `supervise()`. `supervise()` wires budget to `AbortController` for parallel branch enforcement.

### Agent-Native Engine: Observability

- [x] **`AgentTurnStartedEvent` dispatched at start of each turn.** Includes `workflowId`, `agentId`, `turnIndex`, `model`, `inputTokenEstimate`, `conversationLength`.
- [x] **`AgentTurnCompletedEvent` dispatched at end of each turn.** Includes `turnIndex`, `model`, `selectedModel`, `inputTokens`, `outputTokens`, `cost`, `cumulativeCost`, `duration`, `toolCallCount`, `fallbackAttempts`, `reasoningTrace`.
- [x] **`AgentToolCalledEvent` dispatched on tool invocation.** Includes `toolName`, `toolInput`, `source` (`"local"` | `"mcp"`), `operationId`.
- [x] **`AgentToolReturnedEvent` dispatched on tool completion.** Includes `toolName`, `duration`, `success`, `operationId`.
- [x] **`AgentBudgetWarningEvent` dispatched at configurable threshold.** Default: 80%. Includes `budgetUsedPercent`, `tokensRemaining`, `costRemaining`.
- [x] **`AgentBudgetExceededEvent` dispatched when budget exhausted.** Includes `tokensUsed`, `costUsed`, `tokenBudget`, `maxCost`.
- [x] **Reasoning trace captured per turn.** Model `thinking` blocks stored in checkpoint and included in `AgentTurnCompletedEvent`.
- [x] **Cost waterfall per turn queryable.** `handle.query("agentCostWaterfall")` returns per-turn array: `[{ turn, inputTokens, outputTokens, cost, model, tools }]`.
- [x] **Conversation history queryable.** `handle.query("agentConversation")` returns full message array including system prompt, user messages, assistant responses, and tool results.
- [x] **Cost projection based on burn rate.** `handle.query("agentCostProjection")` estimates total cost at completion based on average per-turn cost.
- [x] **Dashboard agent view.** Built-in dashboard includes: conversation timeline, tool calls with inputs/outputs, token usage per turn, cumulative cost curve, budget remaining gauge, reasoning trace accordion, real-time streaming output.
- [x] **`AgentContextCompactedEvent` dispatched on context strategy trigger.** Includes `strategy`, `tokensBefore`, `tokensAfter`, `messagesDropped`.
- [x] **`HumanReviewRequestedEvent` and `HumanReviewCompletedEvent` dispatched.** Includes `workflowId`, `reviewId`, `type`/`decision`, `reviewer`, `duration`.
- [x] **All agent events are typed `Event` subclasses in `WeftEventMap`.** Typed `addEventListener` works for all agent events.
- [x] **OTel span hierarchy includes agent turns.** `agent` span > `agent:turn:N` spans > `agent:tool:call` spans. Attributes: `weft.agent.model`, `weft.agent.turn_index`, `weft.agent.cost`.

### Agent-Native Engine: Model Routing

- [x] **Per-turn model selection via `modelRouter` option.** `ModelRouter` interface: `select(context: RoutingContext) → ModelSelection`. Receives turn index, budget remaining, conversation length.
- [x] **Static fallback chain.** `staticFallbackRouter(["gpt-4o", "claude-haiku-4-5-20251001"])` — next model tried on failure (rate limit, timeout, outage). Each fallback attempt dispatches `AgentModelFallbackEvent`.
- [x] **Dynamic model routing based on turn characteristics.** Routing function receives conversation state and returns model + reason.
- [x] **A/B testing via weighted model selection.** `abTestRouter()` uses FNV-1a hash for deterministic per-workflow-ID distribution. Results tagged with model attribution in `AgentTurnCompletedEvent.selectedModel`.
- [x] **Cost-tier routing based on budget remaining.** `costTierRouter()` declares tiers and thresholds. Engine switches to cheaper model when budget drops below threshold.
- [x] **Engine-level default model router.** Router passed as option to `executeAgentLoop()`. Per-call overrides available.
- [x] **Fallback attempts recorded in observability events.** `AgentTurnCompletedEvent` includes `fallbackAttempts`. `AgentModelFallbackEvent` dispatched on each fallback.
- [x] **Provider health tracking with circuit breaker.** `ProviderHealthTracker` implements sliding window error rate tracking with closed→open→half-open circuit breaker. `AgentProviderCircuitOpenEvent` dispatched.
- [x] **Model selection checkpointed for deterministic recovery.** `previousModels` array accumulated per turn for recovery.

### Agent-Native Engine: Agent-First Declaration

- [x] **`defineAgent()` top-level declaration API.** Declares a reusable agent definition passable to `engine.register()`, `ctx.agent()`, `ctx.handoff()`, and `ctx.debate()`.
- [x] **Durable hooks: `beforeTurn`.** Runs before each LLM call within checkpoint boundary. Can modify messages, inject context, or skip turn.
- [x] **Durable hooks: `afterToolCall`.** Runs after each tool call. Can modify tool result, trigger human review.
- [x] **Durable hooks: `onBudgetWarning`.** Invoked in the agent loop when budget usage crosses 80% threshold. Fires once per agent execution.
- [x] **Context strategy declared on agent definition.** Applies to all invocations. Per-call override via `ctx.agent({ contextStrategy })`.
- [x] **Model router declared on agent definition.** Applies to all invocations. Per-call override available.
- [x] **Engine optimizes for agent-shaped workflows.** When agent-typed workflow detected: priority tool call queuing, LLM connection pre-warming, checkpoint compression for conversation-heavy state.
- [x] **Type-safe agent definitions.** `defineAgent<InputType, OutputType>({ ... })` — compile-time type checking on `engine.start()` and `handle.result()`.
- [x] **Agent definitions compose with workflow registration.** `engine.register(researchAgent)` registers as standalone workflow. Same definition usable as embedded step via `ctx.agent(researchAgent, input)`.
- [x] **`defineAgent()` and `ctx.agent()` share implementation.** Top-level is standalone form; embedded form uses same underlying `executeAgentLoop()`.

### Workflow Versioning

- [x] **Workflow version stored in `wf:{id}` state blob.** Set at workflow start from the currently registered version.
- [x] **`engine.register()` accepts a version and optional migration function.** Shorthand `engine.register(name, fn)` defaults to version `"0.0.0"`.
- [x] **Version mismatch triggers migration on resume.** `migrate(checkpoint, fromVersion)` called when stored version differs from registered version.
- [x] **No migration function = resume as-is.** Backward-compatible checkpoint shapes work without explicit migration.
- [x] **Failed migration produces a `VersionMismatchError`.** Error includes both versions, workflow ID, and workflow type.
- [x] **Migrated checkpoint is persisted atomically.** Updated checkpoint and version written to storage in one `batch()` call.
- [x] **Version visible in API and dashboard.** `GET /v1/workflows/:id` returns the version field.
- [x] **Migration function receives structuredClone-compatible data.** The checkpoint passed to `migrate()` is the deserialized checkpoint state.

### Workflow-Level Timeouts

- [x] **`executionTimeout` on `engine.start()` caps total workflow wall-clock time.** Includes all sleeps, signal waits, and activity executions.
- [x] **Timeout stored as absolute deadline in storage.** Survives process restarts. Scheduler detects expired deadline on recovery.
- [x] **Timeout fires mid-activity via `AbortController`.** In-flight activities receive abort signal. No orphaned work.
- [x] **`WorkflowTimeoutError` thrown on timeout.** Includes `timeoutType` and elapsed duration.
- [x] **`WorkflowTimedOutEvent` dispatched on timeout.** Added to `WeftEventMap`. Listeners receive `timeoutType` and `elapsed`.
- [x] **`ctx.signal` exposes the combined cancellation + timeout signal.** Activities that accept `{ signal }` automatically respect workflow timeouts.
- [x] **`ctx.executionTimeRemaining` returns milliseconds.** Workflows can make decisions based on remaining budget.
- [x] **Deadline keys are cleaned up on workflow completion.** `wf-deadline:*` entries deleted when workflow reaches terminal state.
- [x] **HTTP API accepts `executionTimeout` parameter.** `POST /v1/workflows` body includes `executionTimeout`.
- [x] **Dashboard shows timeout configuration and remaining time.** `execution-deadline.svelte` displays deadline with real-time remaining countdown.

### Search Attributes

- [x] **`ctx.setAttribute(key, value)` sets a single search attribute.** Value persisted at next checkpoint boundary. Supported types: `string`, `number`, `boolean`, `Date`, `string[]`.
- [x] **`ctx.setAttributes(attrs)` sets multiple attributes in one call.** Merge semantics: existing attributes not mentioned are preserved.
- [x] **`ctx.getAttribute(key)` reads the current value.** Returns the in-memory value, even if not yet checkpointed.
- [x] **`ctx.getAttributes()` returns all attributes.** Returns a readonly copy.
- [x] **Attribute schema declared at registration time.** `engine.register("type", fn, { searchAttributes: { ... } })`. Unknown attribute keys rejected at set time.
- [x] **Index entries created atomically with checkpoint.** `idx:{attr}:{value}:{wfId}` keys written in the same `batch()` call as the checkpoint.
- [x] **Index entries diffed on update.** When an attribute value changes, old index entries deleted and new entries created in the same batch.
- [x] **Multi-value attributes (keyword_list) create one index entry per element.** Setting `tags: ["a", "b"]` creates two index keys.
- [x] **Numeric values sort correctly in index keys.** IEEE 754 float-to-sortable-string encoding ensures correct lexicographic order.
- [x] **Date values sort correctly in index keys.** ISO 8601 encoding preserves chronological order.
- [x] **`engine.list({ attributes: [...] })` filters by attributes.** Equality: `{ key, value }`. Range: `{ key, gte, lte }`.
- [x] **Multiple attribute filters are AND-combined.** All conditions must match.
- [x] **HTTP API supports `attr.*` query parameters.** `?attr.customerId=abc`, `?attr.priority.gte=8`.
- [x] **`PATCH /v1/workflows/:id/attributes` sets attributes externally.** Merge semantics. Index updated atomically.
- [x] **`GET /v1/workflows/:id/attributes` reads attributes.** Returns JSON object.
- [x] **`handle.setAttributes()` and `handle.getAttributes()` work from the client SDK.**
- [x] **`AttributesChangedEvent` dispatched on Engine and WorkflowHandle.** Includes workflow ID and changed keys.
- [x] **Attribute cleanup on workflow completion/deletion.** All `attr:` and `idx:` entries removed atomically.
- [x] **Works identically across storage backends.** `src/core/search-attributes-multibackend.test.ts` and `src/core/search-attributes-integration.test.ts` iterate `storageBackends` to verify consistent behavior.
- [ ] **Index scan performance: <1ms for single-attribute equality filter on 100K workflows.** Benchmarked on SQLite.

### Synchronous Updates

- [x] **`ctx.onUpdate(name, handler)` registers an update handler.** Handler is a function (not a generator). Receives payload, returns result.
- [x] **`ctx.waitForUpdate(name)` suspends until an update arrives.** Returns `{ payload, respond }`. `respond()` sends the result back.
- [x] **`engine.update(workflowId, name, payload, options)` sends an update and waits for the response.** Returns a promise that resolves with the handler's return value.
- [x] **`handle.update(name, payload, options)` is a convenience method.** Delegates to `engine.update()`.
- [x] **Timeout semantics.** Default 30 seconds, configurable via `options.timeout`. On timeout, rejects with `UpdateTimeoutError` containing `updateId` for later retrieval.
- [x] **HTTP endpoint: `POST /v1/workflows/:id/update/:name`.** Body: `{ payload, timeout?, idempotencyKey? }`. Returns result or 408 on timeout.
- [x] **HTTP endpoint: `GET /v1/updates/:updateId`.** Returns `{ status: "pending" }` (202) or `{ status: "completed", result }` (200).
- [x] **Update request persisted to storage before acknowledging caller.** Key: `upd:{workflowId}:{updateId}`. Survives server crash.
- [x] **Update response persisted atomically with checkpoint.** Key: `upr:{updateId}`. Written in same `batch()` as checkpoint.
- [x] **Update handler runs at checkpoint boundary.** Processed in the same phase as pending signals.
- [x] **Update handler cannot yield.** Attempting to use `yield*` inside an `onUpdate` handler throws a clear error.
- [x] **Paused workflows are woken for pending updates.** If waiting on a timer or signal, a pending update triggers a wake-up.
- [x] **Idempotency key prevents duplicate processing.** Same key returns existing response. Key stored at `upk:{workflowId}:{key}`.
- [x] **BroadcastChannel notification on response completion.** Caller's waiting promise resolves without polling.
- [x] **WebSocket observers receive `UpdateCompletedEvent`.** Published on the workflow's watch channel.
- [x] **`UpdateReceivedEvent` and `UpdateCompletedEvent` dispatched on Engine and WorkflowHandle.**
- [x] **Response cleanup after TTL.** `upr:*` entries deleted after 5 minutes (configurable).
- [x] **Durability: crash between request and response.** After recovery, workflow processes the pending update. Caller retrieves via `GET /v1/updates/:updateId`.
- [x] **Multiple concurrent updates to the same workflow.** Each processed independently at the next checkpoint boundary.
- [x] **Update to a completed/failed workflow returns an error.** 422 status with clear message.
- [x] **Works identically across storage backends.** The same test suite passes for every backend covered by `storageBackends`. (`src/core/updates-multibackend.test.ts` A7 suite: parametrizes inline `onUpdate`, `waitForUpdate`, timeout, FIFO, and post-cancel rejection over `storageBackends`.)

### Interceptors

- [x] **`WorkflowInterceptor` interface defined with typed hooks.** Hooks: `activity`, `sleep`, `waitForSignal`, `agent`, `workflowStart`, `signalReceived`, `query`.
- [x] **`ActivityInterceptor` interface defined.** Hook: `execute`.
- [x] **All interceptor hooks are optional.** An interceptor can implement only the hooks it cares about.
- [x] **`engine.addInterceptor(interceptor)` registers workflow interceptors.** Multiple registrations compose in order.
- [x] **`engine.addActivityInterceptor(interceptor)` registers activity interceptors for local workers.**
- [x] **Remote `Worker` accepts `interceptors` option.** Activity interceptors apply on the remote worker side.
- [x] **Interceptors compose via `next()` delegation.** First registered = outermost wrapper.
- [x] **Workflow interceptor hooks return generators.** Preserves `yield*` checkpoint semantics.
- [x] **Activity interceptor `execute` hook returns a Promise.**
- [x] **`headers` Map propagates across Worker boundaries.** Set in workflow interceptor, serialized into `postMessage`/WebSocket, read in activity interceptor.
- [x] **`headers` Map propagates across network boundaries (remote workers).** Serialized as part of the WebSocket `task` message.
- [x] **Interceptor errors propagate naturally.** An exception in an interceptor fails the operation as if the underlying operation failed.
- [x] **Zero overhead when no interceptors are registered.** Context operations call the underlying implementation directly.
- [x] **Workflow code does not need modification.** Interceptors are transparent to workflow definitions.
- [x] **Interceptor chain is constructed once per engine, not per operation.** Composition is cached.
- [x] **Interceptors cannot modify the checkpoint mechanism.** They wrap operations, not serialization.

### Observability

- [x] **`createObservabilityInterceptors()` returns both a `WorkflowInterceptor` and an `ActivityInterceptor`.**
- [x] **Uses `@opentelemetry/api` exclusively.** No custom tracing layer. No vendor-specific code. Uses `getOtelApi()` which provides a no-op fallback when SDK not installed.
- [x] **Zero overhead when no OpenTelemetry SDK is configured.** No-op implementations in `no-op-telemetry.ts` are empty functions the JIT can inline.
- [x] **Zero overhead when the observability interceptor is not imported.** No code loaded, no interception.
- [x] **Each workflow execution creates a root span.** Named `workflow:{workflowType}`. Attributes: `weft.workflow.id`, `weft.workflow.type`.
- [x] **Each `ctx.run()` creates a child span.** Named `activity:{activityName}`. Attributes: `weft.activity.operation_id`, `weft.activity.attempt`, `weft.activity.queue`.
- [x] **Each `ctx.sleep()` creates a child span.** Named `sleep`. Attributes: `weft.sleep.duration`.
- [x] **Each `ctx.waitForSignal()` creates a child span.** Named `signal:wait:{signalName}`.
- [x] **Each `ctx.agent()` creates a child span.** Named `agent`. Attributes: `weft.agent.model`, `weft.agent.token_budget`.
- [x] **Trace context propagates to local Activity Workers via `postMessage`.** W3C `traceparent` in the `headers` map.
- [x] **Trace context propagates to remote Activity Workers via WebSocket.** `headers` field in the `task` message. Validated by `remote-propagation.test.ts`.
- [x] **Activity-side interceptor extracts trace context and creates a child span.** Named `activity:execute:{activityName}`.
- [x] **Child workflow spans use OpenTelemetry span links, not parent-child.** Independent lifecycle.
- [x] **`recordPayloads` option records activity inputs/outputs as span attributes.** Off by default.
- [x] **`maxPayloadSize` truncates recorded payloads.** Prevents unbounded attribute sizes.
- [x] **`attributeExtractor` allows custom span attributes.** User-provided function receives interception context via `ObservabilityOptions`.
- [x] **Error spans record exception details.** `span.recordException()` called. `span.setStatus({ code: ERROR })` set.
- [x] **Span hierarchy is correct.** Workflow span > activity/sleep/signal/agent spans > user spans inside activities.
- [x] **OpenTelemetry metrics defined.** `weft.workflow.duration`, `weft.activity.duration`, `weft.activity.attempts`, `weft.workflow.active`.
- [ ] **Metrics exportable to Prometheus via standard OTel exporter.** `/v1/metrics` backed by OTel metrics.
- [x] **Remote worker example in documentation.** Shows `interceptors: [activity]` on remote worker constructor. (See `docs/guides/remote-workers.md`; search for `const { activity } = createObservabilityInterceptors()` and the nearby `new RemoteWorker({ … interceptors: [activity] })` example.)
- [x] **Composable with other interceptors.** Works correctly combined with auth, validation, encryption interceptors.

### DX

- [x] **Zero config to start.** `import { Engine } from "weft"; new Engine()` works with defaults (in-memory storage).
- [x] **`bun add weft` is the only install step.** No codegen, no proto files, no Docker.
- [x] **TypeScript types infer everything.** Event listeners, workflow context, activity return types — all inferred.
- [x] **`using` / `await using` works for all resources.** No manual cleanup ever required.
- [x] **Testing: `MemoryStorage` + `TestEngine.advanceTime()`.** No real timers in tests. `TestEngine` provides deterministic time control via `TimeControl`.
- [x] **Error messages reference the user's code, not Weft internals.** Stack traces are clean. All operation types capture `callerStack` and all engine error handlers enrich errors with the workflow call site.
- [ ] **Documentation: every public API has JSDoc with examples.** Visible in IDE hover. (Partially implemented — descriptions present but most lack code examples.)
- [x] **Dashboard shows real-time workflow state.** WebSocket-powered via `websocket-client.svelte.ts`, updates without refresh.

### Temporal Differentiation

- [x] **Development mode detects non-cloneable checkpoint values.** Serializes/deserializes at each boundary, reports exact field paths that fail with fix suggestions.
- [x] **Stack-trace-preserving errors.** Activity failure errors include the original workflow call site, not just the remote worker stack.
- [x] **`weft version:check` CLI command.** Analyzes registered workflows against existing database, reports checkpoint compatibility before deployment.
- [x] **Automatic checkpoint schema inference.** Actionable error messages on version mismatch naming exact fields that changed. `VersionMismatchError` accepts shape descriptors and includes field-level diffs (added, removed, type-changed). `inferShape()` and `diffCheckpointShapes()` are exported utilities.
- [x] **`ctx.step()` sugar for non-generator workflows.** Progressive disclosure — wraps checkpoint boundaries in a familiar async function.
- [x] **`ctx.explain()` development mode.** Logs what each context operation does and why at runtime via `#explainMode` flag.
- [x] **`weft doctor` diagnostic command.** Reports database health, workflow statistics, queue depths, performance metrics, and recommendations.
- [x] **Built-in alerting with zero external dependencies.** Alert rules as engine event listeners, webhook notifications via `fetch()`.
- [x] **Automatic checkpoint size warnings.** `CheckpointSizeWarningEvent` emitted when checkpoints exceed configurable threshold (default: 64KB).
- [x] **`ctx.offload()` stores large data separately.** Leaves only a lightweight reference in the checkpoint. `ctx.load()` retrieves on demand.
- [x] **Built-in profiling mode.** `MemoryProfiler` class provides interval-based memory profiling with stability analysis. Exported from index.
- [x] **Typed workflow registry.** `Engine<WorkflowRegistry>` provides compile-time type safety on `engine.start()`, `handle.result()`, `handle.signal()`.
- [x] **`weft/testing` module with `TestEngine`.** Real engine with `MemoryStorage`, deterministic time control, crash simulation via `engine.recover()`.
- [x] **`ctx.archive()` moves old state out of checkpoint.** Preserved at `archive:{workflowId}:{key}` for auditing, queryable via dashboard and API.
- [x] **`ctx.expose()` for live workflow inspection.** Accessor functions evaluated at each checkpoint, rendered on dashboard without pre-registered query handlers.
- [x] **Checkpoint history (last N).** Configurable number of retained checkpoints per workflow for time-travel debugging.
- [x] **`activity()` helper with colocated configuration.** Retry, timeout, queue, and idempotency declared on the activity definition.
- [x] **`ctx.runAll()` with named concurrent branches.** Per-branch error handling policies (`onError: "continue"`).
- [x] **`ctx.setBudget()` / `ctx.budgetRemaining()` for agent cost tracking.** Budget state stored in checkpoint, enforced via `AbortController`.
- [x] **Tool result caching across agent turns.** Cache keyed by tool name + serialized arguments via `buildCacheKey`, configurable TTL.
- [x] **`ctx.stream()` for large payloads.** Writes data to storage as chunks via `ReadableStream`, leaves lightweight reference in checkpoint.
- [x] **Automatic payload compression.** Transparent gzip/brotli compression above configurable threshold.
- [x] **Pluggable serialization.** `Serializer` interface in `src/core/types.ts` with `serialize`/`deserialize` methods, passable to Engine options.

### Competitive Parity & Gap Closure

The Temporal-derived pain points summarized in [Overview and Context](./architecture/overview-and-context.md) are architecturally solved. This section tracks the remaining gaps versus the newer AI-native alternatives documented in the companion architecture documents, especially [Overview and Context](./architecture/overview-and-context.md) and [Research Gap Analysis](./architecture/research-gap-analysis.md). Each item is a binary acceptance criterion, flipped to `[x]` when implemented and verified.

- [x] **Serverless suspension primitive.** `ctx.suspendUntil(resumeToken)` in `src/core/context.ts` yields to `waitForSignal(resumeToken)`, persisting a checkpoint so the engine can drop the in-memory workflow until the resume signal arrives. Resume is via the existing `POST /v1/workflows/:id/signal/:token` endpoint (or `engine.signal(workflowId, resumeToken, payload)`). See tests in `src/core/suspend.test.ts` for multi-suspension flows. **Caveat**: in `WorkerExecutionStrategy` the per-workflow worker is held in `#workersByWorkflowId` until the workflow completes, so the "worker is free to do other work while parked" benefit only applies to inline execution. Releasing the worker on suspend in worker mode is tracked under "Agent-loop suspension integration" below.
- [ ] **Agent-loop suspension integration.** `src/ai/agent.ts` and `src/ai/streaming-agent.ts` call `ctx.suspendUntil()` before LLM `fetch()` when the engine is configured with `suspendOnLlmWait: true` AND the provider exposes a resume hint. Opt-in because not every provider supports async resume. Deferred: requires a provider that actually supports async resume hints; the primitive above is in place for future opt-in.
- [x] **Multi-tenant context.** `TenantResolver` interface in `src/core/tenant.ts`; engine option `tenantResolver` populates `ctx.tenant: TenantContext | undefined` at workflow start and persists it on `WorkflowState.tenant` so it survives recovery. `tenantFromInputField(name)` is a convenience resolver for the common case.
- [x] **Per-tenant agent customization.** `defineAgent()` accepts `toolsForTenant?: (tenant) => AgentToolDefinition[]` and `validateInput?: (input, tenant) => void`. The engine's generated workflow handler calls `validateInput` before the agent loop and substitutes `toolsForTenant(ctx.tenant)` for the static tool set.
- [x] **Tenant context in worker-execution mode.** `WorkerInboundMessage.run` carries an optional `tenant` field across `postMessage`; `WorkerExecutionStrategy.startWorkflow` forwards the resolved tenant; and `src/workers/workflow-runner.ts` builds a worker-side `WorkerWorkflowContext` (`workflowId`, `tenant`, `signal`, `startedAt`) that is passed as the first argument to registered handlers. The constructor stop-gap is gone — `workerExecution` and `tenantResolver` can be combined. Engine-side fields like `executionTimeRemaining` are stub values inside the worker because the worker has no clock authority; user code that needs them should stay on inline mode. Regression test in `src/ai/agent-worker-tenant-isolation.test.ts` runs three workflows through a real `Worker` and asserts that `tenant-a` sees `toolA`, `tenant-b` sees `toolB`, and an unexpected tenant fails via `validateInput`.
- [x] **Routing policies.** `RoutingPolicy = 'least-loaded' | 'round-robin' | 'fair-share'` in `src/worker/registry.ts`. `WorkerRegistry` constructor accepts `{ policy }`; `findWorker(activity, { fairShareKey })` consults per-worker per-key counts. All three policies are plumbed end-to-end: `TaskDispatch.fairShareKey` is threaded through `dispatchTaskImpl` → `findWorker` → `assignTask` in `src/server/index.ts`, and a server-level integration test asserts fair-share distributes across keys when dispatched via `serve()`.
- [x] **Task queue scheduling policies.** `TaskQueueOptions.schedulingPolicy: 'priority' | 'fifo' | 'lifo'` in `src/server/task-queue.ts`, default `'priority'` (current behavior). Plumbed through `serve({ schedulingPolicy })`.
- [ ] **Virtual-Object-style session state.** `ctx.sessionState(key)` co-located with the sticky worker. Builds on existing `workerAffinity` in `src/server/index.ts`; session state survives worker restart via checkpoint.
- [x] **AI dashboard detail view (core).** `src/dashboard/views/workflow-detail-agent.svelte` composes `AgentTurn`, `AgentBudgetGauge`, `EventTimeline`, `JsonViewer`, and `ExecutionDeadline` into a dedicated agent workflow detail page. Reachable via `/ui/workflows/:id/agent` (router entry in `src/dashboard/router.svelte.ts`). Per-turn model, token counts, cost, and tool-call results are already rendered; live token streaming shows current output.
- [x] **AI dashboard detail view (enhancements).** Three new fragments now ship alongside the existing agent detail view: `src/dashboard/fragments/agent-cost-waterfall.svelte` renders a per-turn cost bar chart normalized against the max-cost turn; `src/dashboard/fragments/agent-conversation.svelte` renders the rolling conversation history grouped by turn with collapsible system/tool blocks and truncation badges; `src/dashboard/fragments/agent-reasoning-trace.svelte` renders an accordion of provider reasoning traces. Each fragment pairs with a pure `.ts` helper (`computeWaterfallBars`, `groupConversationMessages`, `buildReasoningEntries`) unit-tested via `bun:test`. Backing event plumbing: `AgentTurnCompletedEvent` carries a `messages` snapshot produced by `src/ai/event-message-snapshot.ts` (caps at 8KB per message, 4KB per tool result, 200 messages per snapshot) and the existing `reasoningTrace` field is now consumed by the dashboard.
- [x] **OTel standard Prometheus exporter.** `PrometheusExporter` interface in `src/observability/metrics.ts` with a default `createMetricsCollectorExporter(collector)` implementation. `/v1/metrics` handler delegates to `options.prometheusExporter` when provided, letting projects plug in `@opentelemetry/exporter-prometheus` (or any OTel reader) without forcing it as a runtime dependency. Server `ServeOptions` exposes the plug point.
- [x] **Index scan benchmark.** `src/benchmarks/search-attributes-scan.test.ts` seeds 100K workflows with a `customerId` attribute against `BunSQLiteStorage`; median latency measured at ~0.14ms (p95 ~0.2ms). Implementation fix: `engine.list()` now loads constrained IDs directly from storage instead of full-scanning `wf:*`, turning the operation from O(total workflows) into O(matches).
- [x] **JSDoc examples on public API.** The `weft` module entrypoint, `Engine`, `activity`, and `defineAgent` carry `@example` blocks covering the "hello world", "multi-tenant", "activity with retry", and "per-tenant tool customization" cases. Additional exports retain their existing descriptions and inherit the module-level examples. New exports surface the tenant, routing, scheduling, and Prometheus primitives added in this roadmap.
- [~] **Performance targets measured against spec.** Every benchmark in `src/benchmarks/` was re-run after Item 3 optimizations (2026-04-07). Five of eight targets meet spec outright (recovery, library cold start, **binary cold start**, event dispatch, search attribute scan). Three remain partially closed: workflow starts (~21K/sec vs 50K/sec), activity completions (~14K/sec vs 30K/sec), memory per workflow (~6.8-9.3KB vs 2KB). The remaining gaps are architectural — closing them requires pipelining the start batch, coalescing completion-path deletes, or evicting suspended generators between yields. Benchmark thresholds now enforce the post-optimization floor; no threshold was silently relaxed. Full numbers in `reference/IMPORTANT.md`.

### Performance Targets

- [ ] **Workflow starts: >50K/sec** (single node, SQLite) — measured ~21K/sec (post-optimization, up from ~13K/sec)
- [ ] **Activity completions: >30K/sec** (single node, SQLite) — measured ~14K/sec (post-optimization, up from ~9K/sec)
- [x] **Workflow recovery: <1ms** (O(1) checkpoint load) — measured ~0.08ms median
- [ ] **Memory per workflow: ≤2KB** (checkpoint blob) — measured ~6.8KB isolated, 7.7-9.3KB under full-suite pollution
- [x] **Cold start: <100ms** (binary mode), <50ms (library mode) — measured ~36ms binary (warm-cache median, 5 runs), ~0.14ms library
- [ ] **Token stream latency: <10ms** (engine to WebSocket client)
- [x] **Event dispatch: <100μs** (EventTarget overhead per event) — measured ~0.18μs per dispatch
- [ ] **Worker spawn: <5ms** (Web Worker creation in Bun)
- [ ] **10x faster than Temporal on workflow start** (benchmarked head-to-head)
- [x] **100x faster on workflow recovery** (O(1) vs O(n) replay) — recovery target met
- [ ] **5x lower memory per workflow** (~2KB vs ~50KB+) — current ~7KB still beats Temporal but misses spec target

---

## Research Companion

The research synthesis that informs the roadmap below lives in [Research Gap Analysis](./architecture/research-gap-analysis.md).

## Prioritized roadmap

If I were sequencing this, I would do it in five tracks that can partially parallelize once Track 1 lands.

**Track 1 — Foundations (blocking for everything else).** Effect logs at the tool-call boundary, a storage-backed event log with hash-chained writes, and compensation handlers on activities plus `ctx.saga()`. These three interlock; do them in one sprint or you'll do them twice.

**Track 2 — Testing and diagnosis (can start after Track 1 effect logs land).** Chaos primitives in `TestEngine`, a failure categorization enum, the `weft validate` design-time linter, and a constraint primitive with `onViolation` semantics.

**Track 3 — Runtime portability.** Separate the portable engine surface from Bun-only deployment conveniences. Shared modules should take Bun fast paths when running under Bun, use standard Web APIs when they exist, and fall back to Node primitives only when the platform requires them. The portable surface must import cleanly in Bun, Node, browsers, and edge runtimes without dragging in `bun:*`, `node:*`, filesystem, or process-spawn dependencies that those environments cannot load.

**Support matrix.** Bun keeps the full surface: `serve()`, the compiled binary, `BunSQLiteStorage`, and Bun-accelerated helpers. Node gets the portable engine, fetch-based clients, remote workers, and process-capable extras. Browsers get the core engine, Service Worker integration, IndexedDB storage, and fetch/WebSocket clients. Edge runtimes get the portable engine, `handleRequest()`, and fetch-based storage/transports—no local process spawning, no filesystem assumptions, and no Bun server wrapper.

**Track 4 — Latency and throughput.** Speculative execution with verifiers, prompt prefix caching, and closing the measured-vs-spec performance gaps.

**Track 5 — Multi-agent reliability.** Confidence-weighted voting in `supervise`, dynamic n-sizing, DPMO metrics in the collector, and tool, agent, and provider versioning.

**Track 6 — Storage ergonomics.** Extend the `Storage` interface with convenience methods (`has`, `deletePrefix`, `keys`, `count`) and ship composable utilities (`scoped()` for namespace isolation, `withCodec()` for typed serialization). These make `Storage` a viable foundation for consumers building higher-level abstractions (application state, caches, session stores) without reimplementing the same adapter boilerplate. All additions are optional on the interface so existing third-party adapters aren't broken.

**Track 7 — Platform completeness.** Scheduled/recurring workflows, delayed start, workflow composition operators, garbage collection with TTL, per-tenant resource quotas, lightweight tagging, bulk operations, workflow forking, event replay for time-travel debugging, and first-class streaming resumption tokens. These are the features that turn Weft from a durable execution engine into a complete platform — the things every serious deployment eventually needs and every consumer eventually builds themselves if the engine doesn't provide them.

Each track produces verifiable artifacts. Each item below is a checkbox a reviewer can tick without subjective judgment.

---

## Acceptance criteria (verifiable checklist)

### Track 1 — Foundations

- [x] `src/ai/tool-effect-log.ts` exists, exports `ToolEffectLog` with `record(semanticHash, toolName)`, `lookup(semanticHash)`, `commit(semanticHash, toolName, output)`, `abort(semanticHash, toolName, reason)`. (Note: file named for behavior, not paper acronym; `computeSemanticHash` and `ToolCallReplayConflictError` also exported.)
- [x] `AgentToolDefinition` in `src/ai/declaration.ts` has an optional `identity: (input) => { semanticHash: string; intentCriticalFields: string[] }` field.
- [x] `executeAgentLoop` in `src/ai/agent.ts` consults the effect log before every tool call and short-circuits on `committed` matches.
- [x] `bun test src/ai/tool-effect-log.test.ts` passes tests that crash mid-tool-call, restore, and assert the tool ran exactly once (mock call count verified).
- [x] `src/core/event-log.ts` exists, exports `EventLog` with `append(event)`, `scan(workflowId)`, `replay(workflowId, toStep)`.
- [x] Event log entries are written in the same `storage.batch()` call as the checkpoint they correspond to (assertable by reading the storage backend's write log).
- [x] Each event entry contains `prevHash: string` chained from the previous entry; `EventLog.verify(workflowId)` returns `{ valid: boolean; firstInvalidSequence?: number }` and detects tampered logs.
- [x] `bun test src/core/__tests__/event-log.test.ts` passes a test that reconstructs state by replaying events and asserts deep equality with the live checkpoint.
- [x] `src/core/activity.ts` supports `{ run, compensate, resourceScope, idempotencyKey }` activity definitions; `compensate` is optional but, if present, is registered.
- [x] `src/core/context.ts` exposes `ctx.saga(steps)` that runs activities in order and, on failure, runs `compensate` in reverse for every successfully-completed step.
- [x] `bun test src/core/__tests__/saga.test.ts` passes a 3-step saga test where step 3 fails and compensators for step 1 and step 2 run exactly once each, verified across an engine restart.
- [x] `bun typecheck` and `bun test` both exit 0 after Track 1 lands.

### Track 2 — Testing and diagnosis

- [x] `src/testing/chaos.ts` exists with `ChaosScenario` type and `withChaos(mock, scenario)` combinator.
- [x] `TestEngine.runN(workflow, input, { runs: N, chaos })` returns `{ passRate: number; consistency: number; categories: Record<FailureCategory, number> }`.
- [x] `bun test src/testing/__tests__/chaos.test.ts` passes a suite asserting `passRate < 1.0` on a known-flaky workflow under a documented scenario.
- [x] `WorkflowState.failureCategory: 'memory' | 'reflection' | 'planning' | 'action' | 'system' | null` is populated on all failed workflows.
- [x] Search attributes include `failureCategory` so `engine.list({ attributes: { failureCategory: { equals: 'planning' }}})` works.
- [x] `weft validate <entry.ts>` CLI command exists; exits 0 on a clean workflow registration and non-zero when it detects any of: non-serializable closure in a workflow, stateful activity without a compensator, unbounded retry policy.
- [ ] Linting enforces a maximum production file length optimized for maintainability and agent readability. Default rule: non-test source files under `src/**` error at `>500` physical lines, with generated files, fixtures, benchmarks, and tests explicitly exempted or put on a documented allowlist.
- [ ] The file-length rule is implemented as tooling, not advice. A contributor who adds a new oversized production file gets a failing lint result with a message telling them to split the file by responsibility rather than suppressing the rule.
- [x] `src/core/constraint.ts` exists and exports `constraint(name, { scope, check, onViolation })`.
- [x] `engine.register(workflow, { constraints: [...] })` attaches constraints; constraints are evaluated at every checkpoint commit; `ConstraintViolatedEvent` fires on violation.
- [x] `bun test src/core/__tests__/constraints.test.ts` passes a test that a violated constraint with `onViolation: 'compensate'` triggers the workflow's saga compensators.
- [ ] `tests/playwright/` exists with a dashboard-focused end-to-end suite that drives a real Weft server plus browser and verifies the built-in UI instead of asserting only API responses or component-unit behavior.
- [ ] The Playwright suite includes a state-matrix fixture library that can put Weft into representative UI states without manual setup. At minimum: empty workflow list; populated list; pending, running, completed, failed, cancelled, and timed-out workflows; waiting-for-signal and waiting-for-update workflows; workflows with exposed state; workflows with archived payloads; workflows with search attributes; workflows with update responses; pending and resolved human reviews; and agent workflows with turns, tool calls, streaming output, budget warnings, reasoning traces, and cost waterfalls.
- [ ] The Playwright suite covers the critical user flows end to end. At minimum: list filtering and navigation; workflow detail rendering; agent detail rendering; human review queue actions; attribute display; exposed-state display; archived-payload access; stream/live-update rendering; OpenAPI document access from the UI shell where linked; and empty, loading, not-found, and server-error states.
- [ ] Every Playwright scenario has a mechanically verifiable expectation tied to the visible UI: headings, badges, tables, charts, accordions, action buttons, toasts, URL changes, or streamed text. No scenario is considered complete if it only checks that the page loads without asserting the expected state-specific affordances.
- [ ] The Playwright suite includes at least one restart/reconnect scenario proving the dashboard recovers correctly after state changes that matter to durability: workflow completion after initial page load, human review resolution after page load, and token or event stream reconnection after a dropped connection or page refresh.
- [ ] `bunx playwright test` exits 0 locally and in CI, and the CI artifacts include trace capture, video on failure, and screenshots on failure so dashboard regressions are debuggable without rerunning interactively.

### Track 3 — Runtime portability

- [x] `src/runtime/portable.ts` exists and exports the shared runtime helpers used by cross-platform code: `sleep`, hash helpers for bytes/strings, random-byte generation, and compression/decompression hooks. Bun implementations must use Bun fast paths when available; non-Bun implementations must use standard Web APIs first and Node fallbacks only where the Web Platform has no equivalent.
- [x] The shared modules that currently assume Bun move behind that runtime layer. At minimum: `src/core/event-log.ts`, `src/ai/tool-effect-log.ts`, `src/ai/prompt-cache.ts`, `src/core/shared-state.ts`, `src/core/updates.ts`, `src/worker/long-poll.ts`, `src/worker/index.ts`, and `src/observability/propagation.ts` no longer reference `Bun.*` directly.
- [x] Compression becomes import-safe across runtimes. `src/core/compression.ts` and `src/storage/compressed-storage.ts` no longer force `node:zlib` into the portable entry graph. Bun keeps the fast path; Node uses `node:zlib`; browser and edge runtimes use `CompressionStream` / `DecompressionStream` when available or degrade cleanly to `none`.
- [x] The portable package surface is split from Bun-only and process-only features. The root `weft` entry point remains safe to import in Bun, Node, the browser, and edge runtimes; Bun-only `serve()` and process-only features such as `StdioTransport` move to explicit runtime-scoped subpaths instead of being re-exported from the portable root.
- [x] SQLite storage gets a runtime-scoped export family: `weft/storage/sqlite/bun`, `weft/storage/sqlite/node`, and `weft/storage/sqlite`. The Bun and Node entries export the same storage class shape. The shared `weft/storage/sqlite` entry is selected by conditional exports, not by a browser-unsafe module that imports both branches and switches at runtime.
- [x] The Node SQLite entry performs an explicit capability check for its required dependency or built-in module and throws a precise installation/runtime error when unavailable. The Bun entry assumes Bun and keeps the fast path. Browser and edge builds must fail import resolution cleanly for SQLite rather than bundling a broken fallback.
- [x] `package.json` exports define runtime-aware conditions for the portable surface and the runtime-specific subpaths. Browser and edge builds must not resolve Bun-only files; Bun builds must still resolve Bun-optimized implementations. At minimum this applies to the new SQLite family and any process-only transports.
- [x] `handleRequest()` remains the portable HTTP adapter. `serve()` is explicitly Bun-only. The roadmap is complete for this item only when the docs and export map make that split impossible to misunderstand.
- [x] OpenAPI generation is driven from the shared HTTP route model, not hand-maintained only in the Bun wrapper. `handleRequest()` and `serve()` expose the same `GET /openapi.json` document for the same registered routes, auth schemes, and payload shapes.
- [x] `RemoteWorker` and `LongPollWorker` run in non-Bun runtimes without Bun globals. A test suite proves they work in Node 22+ and in a browser-like / edge-like `fetch` environment using the same source files.
- [x] A runtime support matrix is documented and versioned with the code. It lists every public entry point and storage adapter, and for each one marks Bun, Node, browser, and edge support as `yes`, `no`, or `conditional`, with the condition named explicitly.
- [x] `scripts/verify-portability.ts` exists and fails the build when the portable entries pull in `bun:*`, `Bun.`, `node:zlib`, `node:crypto`, `Bun.spawn`, filesystem access, or other platform-locked imports that should be confined to runtime-specific subpaths.
- [x] `bun run verify:exports` is extended to cover portability, not just tree-shaking. It asserts that the portable root, `weft/client`, `weft/service-worker`, and `weft/storage/indexeddb` can be bundled for browser targets without unresolved Bun or Node built-ins.

### Track 4 — Latency and throughput

- [x] `Activity` and `AgentToolDefinition` support an optional `verify: (result) => Promise<boolean>` hook.
- [x] `ctx.speculate(fn)` runs a child generator against a copy-on-write checkpoint view; commits only after verifications drain.
- [x] On verification failure, the speculative branch is discarded and compensators (Track 1) run for any externalized effects.
- [x] `benchmarks/speculation.bench.ts` exists; asserts ≥30% end-to-end latency reduction on a 5-turn agent workflow with 500ms mock tool latency, across ≥100 runs, with zero incorrect results.
- [x] `src/ai/prompt-cache.ts` exists; implements a templated radix tree for prefix sharing; exposes hit/miss counters via the metrics collector.
- [x] `src/benchmarks/prompt-cache.test.ts` shows ≥49% hit rate on a realistic workload and <1ms per-call overhead.
- [ ] Activity completions benchmark: `benchmarks/throughput.bench.ts` reports ≥20K/sec (up from ~9K/sec; spec is >30K/sec).
- [ ] Memory per workflow: `benchmarks/memory.bench.ts` reports ≤5KB/workflow on a synthetic population of 10K workflows (down from ~7–15KB; spec is ≤2KB).
- [ ] `bun typecheck` and `bun test` both exit 0 after Track 4 lands.

### Track 5 — Multi-agent reliability

- [x] `AgentResult` includes an optional `confidence: number` field in [0, 1].
- [x] `supervise({ ..., voting: 'confidence-weighted' })` computes consensus using vote weights proportional to confidence scores.
- [x] `supervise({ ..., n: (task) => number })` supports dynamic n-sizing.
- [x] `src/observability/metrics.ts` exposes `weft.dpmo.defects` and `weft.dpmo.operations`, with a derived `weft_dpmo` gauge exported via the existing Prometheus path.
- [x] `bun test src/ai/__tests__/bft.test.ts` passes a test with 3 byzantine agents vs 2 honest agents where confidence-weighted voting produces the correct answer and naive voting does not.
- [x] `AgentDefinition` and `AgentToolDefinition` expose a `version: string` field.
- [x] Event log entries (Track 1) record `(workflowVersion, agentVersion, toolVersions[])` on every event.
- [x] Resuming a workflow whose recorded version tuple is incompatible with the currently-registered versions, with no migration hook provided, throws `VersionMismatchError` with a structured breakdown of which component mismatched.
- [x] `bun test src/core/__tests__/workflow-version-resume.test.ts` passes a test that resumes a mid-flight workflow across a tool-schema version bump, with and without a migration hook.

### Track 6 — Storage ergonomics

The `Storage` interface is the right primitive for Weft internals (binary KV with range scans and atomic batch). But consumers building higher-level abstractions on top — application state, caches, session stores, configuration — hit friction that should be smoothed out at the Weft level rather than reimplemented by every consumer.

- [ ] **`has(key)` method on `Storage`.** Returns `Promise<boolean>`. Adapters implement efficiently: SQLite uses `SELECT 1 … LIMIT 1`, LMDB checks key existence without value copy, Memory checks `Map.has()`. Avoids deserializing the full value just to check existence. Default implementation falls back to `get(key) !== null` so existing adapters aren't broken.
- [ ] **`deletePrefix(prefix)` method on `Storage`.** Returns `Promise<number>` (count of deleted keys). SQLite uses `DELETE FROM kv WHERE key >= ? AND key < ?` in one statement. LMDB uses range delete. Memory iterates and deletes. Avoids the `scan()` → collect all keys → `batch(deletes)` round-trip that forces holding all keys in memory.
- [ ] **`keys(prefix, options?)` method on `Storage`.** Returns `AsyncIterable<string>` (keys only, no values). Same signature as `scan()` minus the value in the tuple. SQLite uses `SELECT key FROM kv WHERE …` (no blob read). LMDB iterates keys without value materialization. Useful when consumers only need to list or count entries without reading payloads.
- [ ] **`count(prefix)` method on `Storage`.** Returns `Promise<number>`. SQLite uses `SELECT COUNT(*) FROM kv WHERE …`. Avoids streaming every entry through an async iterator just to count. Useful for dashboards, health checks, and queue depth monitoring.
- [ ] **`storage.scoped(prefix)` namespace utility.** Returns a `Storage` instance where all operations are transparently prefixed with `${prefix}:` and `scan()`/`keys()` results have the prefix stripped. Composes: `storage.scoped('a').scoped('b')` produces keys under `a:b:`. Shipped as a utility alongside `CompressedStorage`, not baked into the interface — adapters don't need to implement it.
- [ ] **`TypedStorage<T>` codec wrapper.** `withCodec(storage, codec)` returns a higher-level interface: `get(key): Promise<T | null>`, `put(key, value: T): Promise<void>`, with `scan`, `batch`, etc. forwarding through the codec. Ships with `jsonCodec` (JSON string round-trip) and `msgpackCodec` (MessagePack round-trip via the existing codec module). Eliminates `TextEncoder`/`TextDecoder` boilerplate for every consumer that stores structured data.
- [ ] **All new methods are optional on the `Storage` interface.** Marked with `?` so existing third-party adapters aren't broken. Weft's built-in adapters (BunSQLite, LMDB, Memory, IndexedDB, Turso) implement all of them. The `scoped()` and `withCodec()` utilities work with any `Storage` that implements the core five methods.
- [ ] **Tests cover all new methods across all built-in adapters.** The existing parametrized storage test factory (`src/testing/storage-backends.ts`) is extended with cases for `has`, `deletePrefix`, `keys`, and `count`. The `scoped()` and `withCodec()` utilities have dedicated test files.
- [ ] `bun typecheck` and `bun test` both exit 0 after Track 6 lands.

### Track 7 — Platform completeness

#### 7a. Scheduled and recurring workflows

Weft has durable `ctx.sleep()` for delays within a running workflow, but no way to express "run this workflow every hour" or "start this workflow at 3am on Tuesdays." Every durable execution platform eventually needs cron — Temporal has it, and consumers who don't get it from the engine build it themselves on top (usually badly).

- [ ] **`engine.schedule(type, input, cronExpression, options?)` registers a recurring workflow.** Accepts a standard cron expression (5-field or 6-field with seconds). Returns a `ScheduleHandle` with `pause()`, `resume()`, `cancel()`, `update(newCron)`, and `describe()`.
- [ ] **Schedules are durable.** Stored in storage under `schedule:{id}`. Survive process restarts. The scheduler scans for due schedules on startup and resumes ticking.
- [ ] **Overlap policy is configurable.** `{ overlap: 'skip' | 'queue' | 'cancel-running' | 'allow' }`. Default: `'skip'` (if the previous run is still executing, don't start another). `'queue'` waits for the previous run to complete before starting. `'cancel-running'` cancels the previous run. `'allow'` starts regardless.
- [ ] **Schedules support backfill.** If the engine was down and missed 3 ticks, `{ backfill: true }` runs them all on recovery. `{ backfill: false }` (default) skips missed ticks and resumes from the next future tick.
- [ ] **Schedules are listable and queryable.** `engine.listSchedules(filter?)` returns all active schedules with their next fire time, last fire time, and status.
- [ ] **`GET /v1/schedules` and `POST /v1/schedules` HTTP endpoints.** Full CRUD via REST. Dashboard shows schedule state, history, and next fire time.
- [ ] **`weft schedule` CLI subcommand.** `weft schedule list`, `weft schedule create`, `weft schedule pause <id>`, `weft schedule cancel <id>`.
- [ ] Tests cover: create/fire/cancel cycle, overlap policies, backfill after downtime, cron edge cases (Feb 29, DST transitions), multi-tenant schedule isolation.

#### 7b. Delayed start

- [ ] **`engine.start(type, input, { startAt: timestamp })` defers execution to a future time.** Workflow enters `'pending'` status immediately, transitions to `'running'` at the specified time. The pending workflow is visible via `engine.get()` and `engine.list()` before it starts.
- [ ] **`engine.start(type, input, { startAfter: duration })` accepts a relative delay.** Converted to absolute timestamp at submission time. Uses the same `Duration` type as `ctx.sleep()` (number or string like `'30m'`).
- [ ] **Delayed starts survive restarts.** Stored as `wf-delayed:{startAt}:{id}` in storage. Scheduler picks them up on recovery.
- [ ] **Delayed starts are cancellable before execution.** `handle.cancel()` on a pending-but-not-yet-started workflow cancels without ever running.

#### 7c. Workflow composition operators

Child workflows exist, but composing them into pipelines, fan-out/fan-in DAGs, or conditional branches requires manual boilerplate.

- [ ] **`ctx.pipe(stages)` runs a sequence of workflows where each stage's output is the next stage's input.** `stages` is an array of `{ type, options? }` or workflow functions. Returns the final stage's output. Each stage is independently checkpointed as a child workflow. If the pipeline fails at stage 3, recovery skips stages 1–2.
- [ ] **`ctx.map(items, workflowType, options?)` runs a workflow for each item in parallel.** Like `ctx.all()` but parameterized over a collection. Supports `{ concurrency: number }` to limit parallelism. Returns results in input order.
- [ ] **`ctx.reduce(items, workflowType, initialValue, options?)` sequentially folds items through a workflow.** Each invocation receives `{ accumulator, item, index }`. Returns the final accumulator. Checkpointed after each fold step.
- [ ] Tests cover: 3-stage pipeline, pipeline failure at middle stage with compensation, map with concurrency limit, reduce over empty array, nested composition (pipe inside map).

#### 7d. Workflow garbage collection and TTL

- [ ] **`EngineOptions.retention` configures automatic cleanup of terminal workflows.** Accepts `{ completed?: Duration, failed?: Duration, cancelled?: Duration, timedOut?: Duration }`. Default: no retention (keep forever). When set, a background sweep deletes workflows whose `updatedAt + TTL < now`.
- [ ] **Retention sweep runs on a configurable interval.** Default: every 5 minutes. Deletes in batches (default 1000 per sweep) to avoid blocking storage.
- [ ] **Retention is per-workflow-type overridable.** `engine.register(type, { handler, retention: { completed: '7d' } })` overrides the engine-level default for that type.
- [ ] **Retention deletes all associated data.** Workflow state, checkpoints, checkpoint history, events, search attribute indexes, offloaded data, archived data, and stream chunks. One `batch()` call per workflow.
- [ ] **`engine.purge(filter)` manually triggers cleanup.** For one-off housekeeping outside the automatic sweep.
- [ ] Dashboard shows retention policy per workflow type and next scheduled sweep.

#### 7e. Per-tenant resource quotas

- [ ] **`EngineOptions.quotas` configures per-tenant limits.** Accepts `{ maxConcurrentWorkflows?: number, maxWorkflowCreationRate?: { count: number, window: Duration }, maxStorageBytes?: number }`.
- [ ] **Quota violations throw `QuotaExceededError`.** Error includes: which quota was violated, current usage, and the limit. Callers can catch and decide whether to queue, reject, or wait.
- [ ] **Quotas are enforced at `engine.start()` time.** Concurrent workflow count checked atomically with workflow creation. Rate limit uses a sliding window counter stored at `quota:{tenant}:rate:{window}`.
- [ ] **Quotas are queryable.** `engine.getQuotaUsage(tenantId)` returns current usage vs. limits. Exposed via `GET /v1/tenants/:id/quota`.
- [ ] **Quota usage visible in dashboard.** Per-tenant usage gauges with warning thresholds.

#### 7f. Lightweight tagging

- [ ] **`StartOptions.tags` accepts `string[]`.** Tags are stored alongside workflow state and indexed for filtering. Unlike search attributes, tags require no schema declaration — they're free-form labels.
- [ ] **`handle.addTags(...tags)` and `handle.removeTags(...tags)` mutate tags on a running workflow.** Changes are durable (written in the next checkpoint batch).
- [ ] **`engine.list({ tags: ['nightly', 'v2'] })` filters by tag intersection.** A workflow matches if it has all specified tags.
- [ ] **Tags are distinct from search attributes.** Search attributes are typed, schema-declared, and support range queries. Tags are untyped, schema-free, and support only equality/intersection. Both are useful; neither replaces the other.
- [ ] Tags visible in dashboard workflow list as badges. Filterable via tag chips in the UI.

#### 7g. Bulk operations

- [ ] **`engine.cancelAll(filter)` cancels all workflows matching a filter.** Returns `{ cancelled: number, failed: number, errors: Array<{ id, error }> }`. Filter supports the same shape as `engine.list()` (type, status, attributes, tags).
- [ ] **`engine.signalAll(filter, name, payload?)` sends a signal to all matching workflows.** Returns `{ signalled: number, failed: number }`.
- [ ] **`engine.deleteAll(filter)` permanently removes all matching terminal workflows.** Only operates on terminal statuses (completed, failed, cancelled, timed-out). Returns `{ deleted: number }`. Rejects if filter would match running workflows.
- [ ] **`engine.tagAll(filter, tags)` and `engine.untagAll(filter, tags)` bulk-modify tags.** Returns `{ modified: number }`.
- [ ] **All bulk operations have HTTP equivalents.** `POST /v1/workflows/bulk/cancel`, `POST /v1/workflows/bulk/signal`, `DELETE /v1/workflows/bulk`, `PATCH /v1/workflows/bulk/tags`.
- [ ] **Bulk operations are batched internally.** Process in chunks of 1000 to avoid holding storage locks. Progress is observable via returned counts.

#### 7h. Workflow forking

- [ ] **`engine.fork(workflowId, options?)` creates a new workflow from an existing workflow's checkpoint.** The forked workflow starts from the same step with the same accumulated results, but gets a new ID and can diverge from that point. Original workflow is unaffected.
- [ ] **Fork options include `{ fromStep?: number }`.** Default: fork from the latest checkpoint. `fromStep` allows forking from a historical checkpoint (if checkpoint history is retained).
- [ ] **Fork records lineage.** Forked workflow state includes `forkedFrom: { workflowId, step }`. Queryable via search attribute `weft:forkedFrom`.
- [ ] **`POST /v1/workflows/:id/fork` HTTP endpoint.** Returns the new workflow handle.
- [ ] Tests cover: fork and diverge, fork from historical step, fork a completed workflow (starts from last checkpoint, re-runs terminal step), fork lineage chain (A → B → C).

#### 7i. Event replay and time-travel debugging

Weft already has a hash-chained event log — the data is there, but there's no query interface for inspecting or replaying it.

- [ ] **`engine.getTimeline(workflowId)` returns a structured timeline.** Each entry includes: step number, operation type, input summary, output summary, duration, timestamp, and version tuple. This is a high-level view — not raw events, but a human-readable execution trace.
- [ ] **`engine.replayTo(workflowId, step)` reconstructs workflow state at a historical step.** Returns the checkpoint, accumulated results, and event log up to that point. Read-only — does not modify the workflow.
- [ ] **Dashboard timeline view.** Visual execution trace showing each step as a node: what operation ran, what it returned, how long it took, and what the checkpoint looked like at that point. Clicking a step shows the full checkpoint state (locals, accumulated results, search attributes).
- [ ] **Dashboard diff view.** Select two steps and see what changed between them: new locals, changed search attributes, budget consumption delta, conversation growth.
- [ ] **`GET /v1/workflows/:id/timeline` HTTP endpoint.** Returns the structured timeline as JSON.
- [ ] **`weft timeline <workflowId>` CLI subcommand.** Prints the execution trace to stdout. `--step N` shows checkpoint state at step N. `--diff N M` shows the delta between two steps.

#### 7j. Streaming resumption tokens

Weft streams tokens over WebSocket with a reconnection buffer, but if the buffer has been flushed before the client reconnects, there's a gap.

- [ ] **Every streamed chunk includes a monotonic `sequence: number`.** The sequence is persisted alongside the chunk in storage (`blob:{workflowId}:{key}:chunk:{sequence}`).
- [ ] **Client reconnection accepts `{ resumeFrom: sequence }`.** Server replays all chunks with `sequence > resumeFrom` from storage, then switches to live streaming. No gaps, no duplicates.
- [ ] **`GET /v1/workflows/:id/streams/:key?after=N` HTTP endpoint.** Returns chunks after sequence N as a JSON array (for non-WebSocket clients) or SSE stream.
- [ ] **Resumption works across server restarts.** Since chunks are in storage, a client can reconnect to a different server instance and resume without loss.
- [ ] Tests cover: disconnect and resume mid-stream, resume after server restart, resume with sequence=0 (replay all), resume after stream completion (returns all chunks immediately).

#### Final

- [ ] `bun typecheck` and `bun test` both exit 0 after Track 7 lands.

### Final verification

- [ ] `bun test` passes across the whole repo.
- [ ] `bun typecheck` exits 0.
- [ ] `bun run lint` (oxlint) exits 0.
- [ ] `bun run build` succeeds.
- [ ] `bun build --compile src/cli-main.ts --outfile weft` produces a working binary.
- [ ] `bunx playwright test` exits 0 against the built-in dashboard and covers the documented workflow, review, and agent-state matrix.
- [ ] `curl http://127.0.0.1:$PORT/openapi.json` returns a valid OpenAPI 3.1 document whose paths include the documented REST endpoints and whose security schemes match the configured auth modes.
- [ ] `node --input-type=module -e "await import('./dist/index.js')"` exits 0 for the portable root entry after build.
- [ ] A browser-targeted bundle of `import { Engine, handleRequest } from 'weft'` succeeds without unresolved `bun:*` or `node:*` imports.
- [ ] A browser-targeted bundle of `import { createFetchHandler } from 'weft/service-worker'` and `import { IndexedDBStorage } from 'weft/storage/indexeddb'` succeeds without unresolved `bun:*` or `node:*` imports.
- [ ] `weft validate examples/**/*.ts` exits 0 on the bundled examples.
- [ ] Every new primitive from this document has a dedicated test file under `src/**/__tests__/` and every acceptance criterion above is covered by at least one `test(...)` call whose failure message names the criterion.

---

## Agent Bureau Integration Analysis

> This section documents what Agent Bureau (an AI agent orchestration monorepo) would need from Weft to replace its in-memory scheduling and add durable execution. The analysis identifies integration surfaces, mapping between the two systems' abstractions, gaps that must be closed, and a concrete adoption strategy.

### What Agent Bureau Is

Agent Bureau is a monorepo of composable packages for building AI agents:

| Package               | Role                                                                                |
| --------------------- | ----------------------------------------------------------------------------------- |
| **operative**         | Agent loop orchestration — `createRun()`, `createScheduler()`, `createSupervisor()` |
| **armorer**           | Tool declaration, execution, idempotency, caching                                   |
| **conversationalist** | Conversation management, message types, token counting                              |
| **lifecycle**         | `CompletableEventTarget`, async iterators, observables, hooks                       |
| **interoperability**  | Shared tool-call/tool-result types across packages                                  |
| **memory**            | SQLite-backed semantic memory with consolidation                                    |
| **gateway**           | Hono HTTP + WebSocket server for remote run management                              |
| **sentinel**          | Guardrails — input/output validators and detectors                                  |
| **herald**            | Notification and event routing                                                      |
| **storage**           | `KeyValueStore` interface with SQLite, memory, IndexedDB, and remote backends       |
| **vector-frankl**     | Embedded vector database for RAG                                                    |

Agent Bureau is currently **single-process, in-memory only**. Runs don't survive crashes, tasks aren't persisted, and cross-machine coordination doesn't exist.

### Abstraction Mapping

| Agent Bureau Concept                              | Weft Equivalent                                          | Notes                                                                                                                                                                                                       |
| ------------------------------------------------- | -------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `createRun(options)`                              | `engine.start(workflowType, input, options)`             | A run _is_ a workflow. The agent loop becomes an async generator.                                                                                                                                           |
| `RunOptions` (model, tools, system prompt, hooks) | `StartOptions` + registered workflow                     | RunOptions become the workflow input; hooks become interceptors.                                                                                                                                            |
| `ActiveRun` handle                                | `WorkflowHandle`                                         | Both extend EventTarget, support cancel, and expose result promises.                                                                                                                                        |
| `createScheduler()` with priority lanes           | `engine.start()` with search attributes + list filtering | Weft doesn't have built-in priority lanes, but `searchAttributes` + custom dispatch logic can replicate them.                                                                                               |
| `createSupervisor()` delegation                   | `ctx.handoff()` / `ctx.supervise()` / `ctx.debate()`     | Weft's multi-agent coordination primitives replace the supervisor pattern.                                                                                                                                  |
| `toolbox.execute(toolCalls)`                      | `ctx.run(activity, args)` per tool call                  | Each tool call becomes a durable activity with retry, timeout, and compensation.                                                                                                                            |
| `CompletableEventTarget`                          | `EventTarget` (Engine + WorkflowHandle)                  | Weft uses platform EventTarget. Agent Bureau's typed extensions map to Weft's typed addEventListener overloads.                                                                                             |
| `KeyValueStore`                                   | `Storage` interface                                      | Both are KV-oriented. Weft's is `Uint8Array`-valued with scan; Agent Bureau's is `unknown`-valued with namespace isolation.                                                                                 |
| `withCache()` generate wrapper                    | `ctx.memo()` or prompt cache                             | Weft's checkpoint-level memoization replaces the response cache.                                                                                                                                            |
| `withIdempotency()` tool wrapper                  | Activity `idempotencyKey`                                | Weft handles idempotency at the activity dispatch level.                                                                                                                                                    |
| `RetryOptions` with mutators                      | `RetryPolicy` on activities                              | Agent Bureau mutates context between retries (temperature escalation, tool removal); Weft retries at the activity level. Context mutation requires the workflow to implement retry-with-mutation as a loop. |
| `createSessionStore()`                            | Workflow checkpoint persistence                          | Sessions are workflows. Save/restore becomes start/resume.                                                                                                                                                  |
| Gateway HTTP + WebSocket                          | Weft server HTTP + WebSocket                             | Same shape, different route prefix. Could share a Bun.serve instance or proxy.                                                                                                                              |
| `BudgetThresholdEvent` / `BudgetExceededEvent`    | `AgentBudgetWarningEvent` / `AgentBudgetExceededEvent`   | Direct equivalents.                                                                                                                                                                                         |

### What Weft Already Provides That Agent Bureau Needs

These are capabilities Agent Bureau currently lacks that Weft delivers out of the box:

1. **Durable execution.** Runs survive crashes. The agent loop checkpoints at every tool call boundary. Recovery is O(1) — no replay, no re-execution of prior steps.

2. **Persistent task queue.** Tool calls and sub-agent dispatches are queued in storage with visibility timeouts, retry policies, and dead-letter semantics. No more in-memory-only scheduling.

3. **Distributed workers.** Activities can execute on remote machines connected via WebSocket. Agent Bureau's single-process constraint is eliminated.

4. **Multi-agent coordination primitives.** `ctx.handoff()`, `ctx.debate()`, `ctx.supervise()` replace the custom `createSupervisor()` with durable, crash-safe equivalents that support confidence-weighted voting and dynamic redundancy.

5. **Cost enforcement.** Per-workflow and organization-level budget tracking with real-time enforcement, projection, and abort-on-exceed. Agent Bureau has budget events but no enforcement mechanism.

6. **Human-in-the-loop review.** Structured review requests with escalation chains, partial approval, conversation threading, and webhook notifications. Agent Bureau has no equivalent.

7. **Search and query.** Indexed search attributes on workflows, queryable via list API with attribute filters. Agent Bureau has no way to find or filter past runs.

8. **Built-in observability.** Prometheus metrics, W3C trace propagation, event history with tamper-detection hashing. Agent Bureau emits events but doesn't aggregate or expose metrics.

9. **Context window strategies.** Sliding window, summarization, and RAG-based context management built into the agent loop. Agent Bureau's `conversationalist` handles message formatting but not compaction.

10. **Dashboard.** Svelte-based UI with workflow state, agent conversation display, reasoning traces, cost waterfall, and review management. Agent Bureau has no UI.

### What Weft Needs to Add or Expose for Agent Bureau

These are gaps or friction points that would block or complicate adoption:

#### 1. Priority-Aware Scheduling

**Agent Bureau has:** Four priority lanes (immediate, scheduled, background, ambient) with preemption.

**Weft has:** FIFO, LIFO, or priority-based scheduling in the task queue, but priority is a `number` on `TaskDispatch`, not a named lane system.

**What's needed:** Either Agent Bureau adapts to numeric priority (mapping lanes to numbers: immediate=100, scheduled=50, background=10, ambient=1), or Weft adds named-lane support. The numeric approach is simpler and sufficient — document the mapping convention.

#### 2. Retry Context Mutation

**Agent Bureau has:** `RetryMutator` functions that transform the generate context between retries (e.g., escalate temperature, remove the tool that caused a schema error, fix malformed JSON). This is a core pattern — retries aren't just "try again," they adapt.

**Weft has:** `RetryPolicy` with exponential backoff, but retries re-execute the same activity with the same input.

**What's needed:** Weft's workflow-level retry pattern already supports this — the workflow itself implements the retry loop with mutation between iterations. But this needs to be a documented pattern, not discovered by accident. Example:

```typescript
// Agent Bureau's retry-with-mutation as a Weft workflow pattern
for (let attempt = 0; attempt < maxAttempts; attempt++) {
  const result = yield * ctx.run(generate, mutatedContext);
  if (isSuccess(result)) return result;
  mutatedContext = mutate(mutatedContext, result.error);
}
```

#### 3. Hook System Compatibility

**Agent Bureau has:** A rich hook system — `beforeGenerate`, `afterGenerate`, `beforeToolExecution`, `afterToolExecution`, `onRunStart`, `onRunComplete`, `onError` with recovery actions.

**Weft has:** Interceptors that wrap context operations (tracing, validation, encryption) but not the same hook surface.

**What's needed:** Weft interceptors can implement most hooks. But `onError` with `ErrorRecoveryAction` ('continue', 'retry', 'abort', 'elicit') needs special handling — the workflow itself must implement the recovery logic using try/catch around `yield*` operations. Document the pattern for mapping Agent Bureau hooks to Weft interceptors + workflow error handling.

#### 4. Tool Execution Concurrency Control

**Agent Bureau has:** `toolbox.execute(toolCalls, { concurrency: 3, mode: 'parallel' })` — fine-grained control over how many tools run simultaneously within a single step.

**Weft has:** `ctx.all([...])` for parallel execution but no built-in concurrency limiter on parallel branches.

**What's needed:** Either implement concurrency-limited `ctx.all()` (a `ctx.pool(n, [...])` primitive), or Agent Bureau manages concurrency within a single activity that wraps multiple tool calls. The latter is simpler and keeps Weft's activity model clean.

#### 5. Guardrail Integration

**Agent Bureau has:** `sentinel` package with input/output validators and detectors that run in parallel via `Promise.allSettled`, with session tainting on violation.

**Weft has:** No guardrail concept. Interceptors could wrap operations but don't have the validator/detector taxonomy.

**What's needed:** Guardrails map to workflow-level logic. Before dispatching a generate activity, the workflow runs validator activities in parallel. After receiving the result, it runs detector activities. Session tainting becomes a search attribute (`weft:tainted: true`). This is a pattern, not a Weft feature — but it should be documented.

#### 6. Typed Event Parity

**Agent Bureau has:** ~30 strongly-typed event classes with typed `addEventListener` overloads via `CompletableEventTarget<EventMap>`.

**Weft has:** ~15 event types with typed overloads on Engine and WorkflowHandle.

**What's needed:** Agent Bureau's operative-specific events (StepStartedEvent, ToolsExecutingEvent, GenerateRetryEvent, GuardrailTriggeredEvent, BackpressureAppliedEvent, etc.) need to be emitted from within the workflow and bridged to Weft's event system. The workflow dispatches custom events via the context; Weft forwards them to observers. This works today via `WorkflowEvent` with arbitrary payload — but typed event registration at the workflow level would be cleaner.

#### 7. Backpressure Signal Passthrough

**Agent Bureau has:** `createAdaptiveBackoff()`, `createTokenBucket()`, `createSlidingWindow()` — rate limiters applied per-step within the agent loop.

**Weft has:** No backpressure concept at the workflow level. Activity-level retry backoff exists, but not step-level rate limiting.

**What's needed:** Backpressure is workflow-internal logic. The agent workflow calls `yield* ctx.sleep(backoff.delay)` between steps when the rate limiter fires. Weft's durable sleep makes this crash-safe (the backoff delay survives restarts). No Weft changes needed — just document the pattern.

#### 8. Storage Interface Bridging

**Agent Bureau has:** `KeyValueStore<T>` with `get(key): Promise<T | undefined>`, `set(key, value): Promise<void>`, `delete(key): Promise<void>`, `has(key): Promise<boolean>`, and namespace isolation.

**Weft has:** `Storage` with `get(key): Promise<Uint8Array | null>`, `put(key, value: Uint8Array): Promise<void>`, `delete(key): Promise<void>`, `scan(prefix): AsyncIterable`, and `batch()`.

**What's needed:** A thin adapter that wraps Weft's `Storage` as an Agent Bureau `KeyValueStore`:

```typescript
function createWeftKeyValueStore<T>(storage: WeftStorage, namespace: string): KeyValueStore<T> {
  const prefix = `kv:${namespace}:`;
  return {
    get: async (key) => {
      /* decode from Uint8Array */
    },
    set: async (key, value) => {
      /* encode to Uint8Array */
    },
    delete: async (key) => storage.delete(prefix + key),
    has: async (key) => (await storage.get(prefix + key)) !== null,
  };
}
```

This adapter lives in Agent Bureau, not Weft. Weft's storage is the lower-level primitive; Agent Bureau wraps it.

### Integration Strategy

#### Phase 1: Library Mode (In-Process)

Use Weft as a library inside Agent Bureau's `operative` package. No server, no remote workers, no binary.

1. **Wrap the agent loop as a Weft workflow.** `createRun()` becomes `engine.start('agent-run', runOptions)`. The workflow is an async generator that implements the operative loop (generate → tool calls → check stop condition → repeat).

2. **Wrap tool execution as Weft activities.** Each tool in the toolbox becomes a registered activity with retry policy, timeout, and idempotency key derived from tool name + input hash.

3. **Use Weft's event system.** Map operative events to Weft events. `ActiveRun` becomes a thin wrapper around `WorkflowHandle` that re-emits events with Agent Bureau's typed event classes.

4. **Use Weft's storage.** Replace Agent Bureau's `KeyValueStore` backends with the Weft storage adapter. One storage backend for everything — agent state, tool caches, session persistence, memory.

5. **Keep Agent Bureau's API surface.** `createRun()`, `ActiveRun`, `RunOptions`, tool declarations — all stay the same. Weft is an implementation detail, not a new user-facing API.

#### Phase 2: Server Mode (Distributed)

Deploy Weft as a standalone server. Agent Bureau becomes a client.

1. **Gateway delegates to Weft server.** Agent Bureau's gateway proxies to Weft's HTTP API, or Weft replaces the gateway entirely (same route shape, richer feature set).

2. **Remote tool workers.** Tools that call external APIs or run expensive computation execute on dedicated worker machines connected via WebSocket.

3. **Dashboard.** Weft's built-in dashboard replaces any custom Agent Bureau UI needs.

4. **Multi-agent workflows.** Supervisor patterns use Weft's `ctx.handoff()` / `ctx.supervise()` / `ctx.debate()` instead of Agent Bureau's `createSupervisor()`.

#### Phase 3: Full Platform

1. **Browser deployment.** Agent Bureau runs in the browser via Weft's Service Worker + IndexedDB backend. Same agent code, local-first execution.

2. **Human review workflows.** Agent runs that need approval pause via `ctx.humanReview()` and resume when a human responds through the dashboard or API.

3. **Organization-level budgets.** `engine.setBudgetPolicy()` enforces daily/monthly cost limits across all agent runs.

4. **Semantic memory as workflow.** Memory consolidation becomes a scheduled Weft workflow that periodically summarizes and compacts agent memories.

### Package Dependency Impact

```
Current Agent Bureau dependency graph:
  interoperability, lifecycle (foundation)
  → armorer, conversationalist (layer 1)
  → operative, memory (layer 2)
  → herald, sentinel (layer 3)
  → gateway (aggregator)

With Weft integration:
  interoperability, lifecycle (foundation)
  → armorer, conversationalist (layer 1)
  → operative + weft (layer 2) ← weft becomes a dependency of operative
  → memory (layer 2, uses weft storage adapter)
  → herald, sentinel (layer 3)
  → gateway (thinner — delegates to weft server, or removed entirely)
```

Weft is a dependency of `operative`, not a replacement for it. Operative keeps its API surface, hooks, retry mutators, guardrail orchestration, and event types. Weft provides the durable execution substrate underneath.

### Key Design Decisions

1. **Weft is an implementation detail.** Agent Bureau users never import from `weft` directly. `operative` wraps Weft's engine and exposes the same `createRun()` / `ActiveRun` API. This means Weft can be swapped out without breaking downstream code.

2. **One storage backend.** Weft's `Storage` interface becomes the single persistence layer. Agent Bureau's `KeyValueStore` is an adapter over it. No parallel storage systems.

3. **Events bridge, not replace.** Agent Bureau's typed event system stays. Weft events are forwarded into Agent Bureau's `CompletableEventTarget` with the expected types. Weft's event types are internal.

4. **Workflows own the control flow.** Retry mutation, backpressure, guardrails, and hook logic live in the workflow generator, not in Weft primitives. Weft provides the durable substrate (checkpoint, sleep, activity dispatch); Agent Bureau provides the agent-specific orchestration logic.

5. **Progressive adoption.** Start with library mode (zero infrastructure change), graduate to server mode when distributed execution or the dashboard is needed. No big-bang migration.
