# Roadmap

A running list of remaining issues, gaps, and follow-ups discovered while reading through the docs and code. Each item should carry enough context that we can pick it up cold later without re-doing the investigation.

This file tracks remaining work only. Completed roadmap items belong in git history and pull request records, not in the active queue.

## 1. Cross-Process Type Generation

- [ ] **Add `weft codegen` CLI.**

  **Where:** new `src/cli/codegen.ts` and `src/cli/codegen-emit.ts`. Add `codegen` to the CLI command union and dispatch path in `src/cli.ts` / `src/cli-main.ts`.

  ```bash
  bunx weft codegen --server https://weft.internal:7233 --token "$WEFT_TOKEN" --out src/weft.generated.d.ts
  ```

  The command fetches the existing `GET /v1/registry` snapshot, validates `registryVersion: 1` and the workflow/activity dictionaries against a Zod schema, and emits a single `.d.ts` with module augmentation for `WorkflowRegistry` and `ActivityTypes`. Output must be deterministic: alphabetically sorted keys, stable formatting, byte-identical output for unchanged registry responses, and idempotent writes.

  Support authentication via `--token`, `WEFT_TOKEN`, or `~/.weft/credentials`. Include `--from <path>` for offline or vendored registry JSON. Leave non-TypeScript targets out of v1, but keep the emitter structured so future targets can be added without changing the registry contract.

  **Acceptance criteria:**
  - The CLI emits valid TypeScript declaration output from a registry fixture.
  - Running the command twice with the same input does not rewrite the output file.
  - Invalid registry JSON fails with a clear diagnostic and no partial output.
  - Generated declarations typecheck in a package-root fixture.
  - Verification passes with `bun run lint`, `bun run typecheck`, `bun run typecheck:tests`, targeted CLI tests, and `bun run verify:documentation`.

## 2. Architecture Gap Closure

These items are still present in `reference/architecture.md` and are not completed in the current implementation.

- [ ] **Release workflow workers during agent LLM suspension.**

  **Where:** `src/core/worker-execution-strategy.ts`, `src/workers/workflow-runner.ts`, `src/core/engine/operations-agent-suspension.ts`, and worker-execution tests.

  Inline agent turns can already park on provider resume hints when `suspendOnLlmWait` is enabled. Worker-execution mode still falls back to in-memory waiting because `WorkerExecutionStrategy` keeps the per-workflow worker in `#workersByWorkflowId` until the workflow completes. Close that architecture caveat without adding a second suspension system: persist the same pending agent execution state, release the workflow worker while parked, and resume through the existing signal path.

  **Acceptance criteria:**
  - A worker-execution workflow that parks on an LLM resume hint releases its worker back to the pool before the provider resumes.
  - With worker concurrency `1`, a second workflow can start and complete while the first workflow is parked on an LLM resume signal.
  - Delivering the matching resume signal reacquires a worker, restores the pending agent loop state, and completes the original workflow exactly once.
  - Cancellation and engine disposal clean up parked worker-mode agent state without leaking workers, signal waiters, or pending agent-execution keys.
  - Verification passes with `bun run lint`, `bun run typecheck`, `bun test src/core/engine/operations-agent-suspension.test.ts src/core/worker-execution-strategy.test.ts`, and `bun run verify:documentation`.

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

- [ ] **Add filterable human-review listing.**

  **Where:** `src/core/engine/reviews.ts`, `src/core/engine/index.ts`, `src/server/operations/list-reviews.ts`, `src/server/handler.test.ts`, and `documentation/reference/api-server.md`.

  The architecture route sketch notes that `listReviews()` does not yet accept a filter argument and that status filtering is planned. The current engine method and `GET /v1/reviews` operation list pending review entries only and accept no filters.

  **Acceptance criteria:**
  - `engine.listReviews(filter?)` accepts a typed filter with at least `status`, `workflowId`, and `reviewType` fields.
  - `GET /v1/reviews` and the JSON-RPC `weft.reviews.list` operation accept the same filter shape through validated transport inputs.
  - Pending and completed review entries are distinguishable by status without changing existing pending-review behavior.
  - Tests cover empty results, pending status filtering, completed status filtering, workflow-id filtering, review-type filtering, and invalid filter diagnostics.
  - Verification passes with `bun run lint`, `bun run typecheck`, `bun test src/server/operations/list-reviews.test.ts src/server/handler.test.ts src/core/engine.test.ts`, and `bun run verify:documentation`.

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

## 4. Agent Bureau Compatibility

**Architectural commitment:** [Agent Bureau](https://github.com/stevekinney/agent-bureau) consumes Weft, never the reverse. Weft cannot import from [`armorer`](https://github.com/stevekinney/agent-bureau/tree/main/packages/armorer), [`conversationalist`](https://github.com/stevekinney/agent-bureau/tree/main/packages/conversationalist), or [`interoperability`](https://github.com/stevekinney/agent-bureau/tree/main/packages/interoperability) in runtime source.

- [x] **Design Weft's tool-and-conversation surface as a minimal durable-execution contract Agent Bureau can compose on top of.**

  **Where:** `src/ai/types.ts` or the surviving post-shrinkage agent type home, `src/ai/agent.ts`, `src/ai/declaration.ts`, and new documentation under `documentation/integrations/agent-bureau.md`.

  Weft owns only the minimal durable-execution contract. Agent Bureau can extend that contract structurally with richer semantics.

  **Target surface:**
  - `JSONValue`: recursive JSON-safe type matching Agent Bureau's shape.
  - `ToolCall`: `{ id: string; name: string; arguments: JSONValue }`.
  - `ToolResult`: `{ callId: string; outcome: 'success' | 'error' | 'action_required'; content: JSONValue; error?; action?; inputDigest?; outputDigest? }`.
  - `ToolErrorShape`: `{ code: string; category: ToolErrorCategory; retryable: boolean; message: string; details?: JSONValue }`.
  - `ToolDefinition`: `{ name: string; description?: string; input: unknown; execute: (input, ctx?) => Promise<unknown>; verify?; identity?; version? }`.
  - `ConversationHistory`: `Message[]` for Weft's built-in provider transcript, or a structural Agent Bureau conversation history object from `conversationalist`.

  Every field name and shape must either match Agent Bureau's structural type exactly or be absent. Do not import Agent Bureau packages from runtime source. Keep any compatibility assertions in tests or development-only type fixtures.

  **Acceptance criteria:**
  - Type-level tests prove Agent Bureau-shaped tool calls, tool results, tool definitions, and conversation history values satisfy the Weft contract without translation.
  - Runtime agent execution still accepts existing Weft-local tools after the type cleanup.
  - Documentation explains that Weft is the durability layer and Agent Bureau is the agent framework layered above it.
  - Verification passes with `bun run lint`, `bun run typecheck`, `bun run typecheck:tests`, targeted agent tests, and `bun run verify:documentation`.

- [ ] **Make Weft's `Storage` interface a structural superset of Agent Bureau's `KeyValueStore`.**

  **Where:** `src/storage/interface.ts`, `src/storage/scoped-storage.ts`, `src/storage/typed-storage.ts`, built-in adapters under `src/storage/`, and `documentation/integrations/agent-bureau.md`.

  Keep `Uint8Array` as the canonical Weft storage value type. Solve string-oriented compatibility with explicit wrappers rather than changing the core interface.

  **Remaining work:**
  - Add a text-value wrapper that maps Weft `Uint8Array` storage to `get(key): Promise<string | null>` and `set(key, value): Promise<void>`.
  - Add a compatibility helper that maps Weft's async-iterable key surface to `list(prefix): Promise<string[]>`.
  - Add type-level tests showing wrapped Weft storage satisfies Agent Bureau's `KeyValueStore` shape.
  - Document the migration path from Agent Bureau storage to Weft storage without adding runtime dependencies on Agent Bureau.

  **Acceptance criteria:**
  - The wrapper round-trips UTF-8 text values across Memory, SQLite, IndexedDB, WebExtension, HTTP, and auto-resolved storage where those backends are available in tests.
  - `list(prefix)` returns stable string arrays from the existing key iteration surface.
  - Type-level compatibility tests use development-only imports and do not affect runtime package exports.
  - Verification passes with `bun run lint`, `bun run typecheck`, `bun run typecheck:tests`, targeted storage tests, and `bun run verify:documentation`.
