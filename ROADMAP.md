# Roadmap

A running list of issues, gaps, and follow-ups discovered while reading through the docs. Each item should carry enough context that we can pick it up cold later without re-doing the investigation.

> [!IMPORTANT]
> **AI Surface Shrinkage is the next thing we work on.** Every other item below assumes that surgery has happened — `src/ai/providers/`, `mcp/`, `streaming.ts`, `streaming-agent.ts`, `token-counting.ts`, `budget*.ts`, `context-window*`, `context-strategies/`, `model-router.ts`, `provider-health.ts`, `prompt-cache*`, `tool-cache.ts`, and `confidence-voting.ts` are gone; what remains is the durable agent loop, durable coordination, tool effect log, human review, hooks at checkpoint boundaries, and durability-shaped events. Items that would only have been polish on deleted code have been removed from this roadmap.

## 1. AI Surface Shrinkage 🚨

- [x] **Audit `src/ai/*` against the durability test. Cut everything that isn't durability-essential. Reframe Weft's agent pitch around the narrower surface.**

  **The test:** _Does this feature fundamentally require checkpoint-and-recovery semantics, or does it just happen to be useful in agent contexts?_ Requires durability → keep. Useful but not durability-shaped → delete (move upstream to `armorer` / `conversationalist` / Agent Bureau).

  **Keep (durability-essential):**
  - **Agent loop** (`agent.ts`, `executeAgentLoop`) — ReAct-style loop where each tool call is a checkpoint boundary; resumes after hibernation.
  - **Durable multi-agent coordination** (`coordination.ts`, `durable-coordination.ts`) — the state machines, not the opinionated patterns (debate, supervision, handoff move to Agent Bureau).
  - **Tool effect log** (`tool-effect-log.ts`).
  - **Human review** (`human-review.ts`) — collapses into a more general `ctx.waitForSignal` primitive eventually.
  - **Hooks** (`hooks.ts`) — only the ones that fire at checkpoint boundaries. Tool-call middleware moves to `armorer`.
  - **Events** (`events.ts`) — only durability-shaped events (workflow-started, checkpoint-committed, agent-resumed). Agent-shape events fire upstream.

  **Delete (move upstream or drop):** `providers/anthropic.ts`, `providers/openai.ts`, `providers/interface.ts`, `providers/types.ts`, `providers/stream-reader.ts`, `providers/suspending-provider.ts`; `token-counting.ts`; `budget.ts`, `budget-policy.ts`; `context-window.ts`, `context-strategies/`; `model-router.ts`; `provider-health.ts`; `mcp/` (entire directory — client moves to `armorer`); `streaming.ts`, `streaming-agent.ts`; `prompt-cache/`; `tool-cache.ts`; `confidence-voting.ts`. `declaration.ts` shrinks to a thin `agent({ provider, tools, loop options })` shape (overlaps with the `agent()` rename below).

  **The new agent loop interface:** `executeAgentLoop` accepts a structural-typed `LLMProvider` (no Weft-shipped provider classes), a list of structural-typed tools (anything matching a minimal `Tool` shape — `armorer` tools satisfy it, plain functions satisfy it), and minimal loop options (`maxTurns`, system prompt). Budget, model routing, context strategy become optional hooks delegating to upstream-supplied implementations.

  **What ships post-shrinkage:** one named export `executeAgentLoop`, the `agent()` helper (after the rename), the multi-agent coordination primitives, `humanReview`, `toolEffectLog`. Everything else is `import { ... } from 'armorer'` / `'conversationalist'` / `'agent-bureau'`.

  **Coordination before deletion:** for each "delete" entry, verify the upstream library has an equivalent or accepts the contribution. If upstream won't take it, decide: delete and let users pick a third-party, or keep as a documented exception. No re-export shims.

  **Doc and test pass paired with the surgery:**
  - Rewrite the README's agent section around the narrow pitch (_"Weft adds durability to your agent loop. Bring your provider; bring your tools. Weft drives the loop, checkpoints at every tool-call boundary, survives crashes mid-conversation."_).
  - Update `documentation/agents/*.md`: keep agent overview (rewritten), durable coordination, agent declaration (now thin), tool effect log, human review, observability of loop boundaries. Remove or move budget/cost docs, context window docs, model routing docs, provider health docs, prompt cache docs, streaming docs.
  - Add a "what Weft owns vs. what upstream libraries own" page.
  - Update Weft-vs-Temporal table — drop rows for deleted concerns; sharpen rows about the durable loop and coordination.
  - Delete tests for deleted modules; move tests for moved modules.

  **Pre-1.0; aggressive deletion, hard cut. No soft deprecation.** Lands before the README rewrite, the `agent()` rename, and the MCP server item.

## 2. Engine Semantics 🚨

- [ ] **Preserve sub-operation results across `ctx.all` partial failures.**

  **Severity: high.** Correctness foot-gun: today, when one branch of `ctx.all` rejects, successful branches' results are discarded and re-execute on retry. The README's checkout example (`sendConfirmation` + `scheduleShipping` in `ctx.all`) hits this — retry sends a duplicate confirmation email. Silent failure mode; tests pass; only signal is a customer support ticket.

  **Where:** `src/core/engine.ts:6965-6981` (`#processParallelOperation`), `src/core/context.ts:1163-1193` (`*all`), `src/core/engine.ts:6983` (`#processRaceOperation`), `src/core/engine.ts:7174` (`'run-all'`). Tests in `src/core/engine.test.ts`.

  **The fix:**
  1. Switch the inner dispatch from `Promise.all` to `Promise.allSettled` semantics. Parent `ctx.all` still fails when any branch fails — external contract unchanged. But every branch that settled gets persisted to its own slot before the parent rejects.
  2. Per-branch result table: each `'parallel'` operation gets stable per-branch identity (positional index + sub-operation `operationId`); `{ status, value }` keyed by that identity in the parent's checkpoint structure.
  3. Retry path: `fulfilled` → return cached value, don't dispatch; `rejected` → re-dispatch subject to the sub-op's retry policy; `missing` → dispatch as normal.
  4. Apply the same fix to `'run-all'` (sequential variant).
  5. **Don't apply to `'race'`** — race losers are intentionally cancelled; preserving a loser's partial result would be wrong. Document the asymmetry.
  6. Tests: `ctx.all` with two activities, one fails, retry succeeds — assert successful one is called once, not twice. Property test: random branch counts/failure positions/delays. Recovery across actual checkpoint round-trip.

  **Checkpoint format change:** `'parallel'` accumulated entry gains per-branch slots; bump format version, refuse to load older checkpoints (pre-release, no in-flight production workflows). `isParallelOperationCacheEntry` (`context.ts:1170`) extends to carry per-branch slots.

  **Out of scope:** activity-internal idempotency (separate per-activity contract); cancellation semantics for in-flight siblings (`ctx.allOrCancel` would be a separate variant). Independent of all other items; ship in isolation, before the docs item below.

- [ ] **Document `ctx.all` and `ctx.race` failure semantics.**

  **Where:** `README.md` lines 98-110 (checkout example), `documentation/guides/parallel-execution.md`, any tutorial using parallel composites.

  Lead the parallel-execution guide with the contract: _"When any branch of `ctx.all` fails, successful branches' results are persisted and not re-executed on retry. Only the failed branch retries."_ Spell out idempotency layering — internal activity retries still re-execute the activity per attempt. Document the asymmetry with `ctx.race`. Update README's checkout example with a one-line aside on durability. Ship after the engine fix; if the engine fix is delayed, ship the honest "this is current behavior, tracked under [issue]" version immediately.

## 3. Type System & Definition Vocabulary 🚨

This section unifies the public type surface, ergonomics, and definition helpers. Everything here is pre-1.0 hard rename — no aliases, no codemod, no changelog warnings.

- [x] **Eliminate the `(ctx as Context)` cast pattern: widen `WorkflowContext` to be the full handler surface.** 🚨

  **Where:** `src/core/types/workflow-context.ts` (the widened workflow authoring interface), `src/core/context/index.ts` (the `Context` class). Pervasive in JSDoc and `documentation/guides/workflows.md` and elsewhere.

  Today `WorkflowContext` exposes only identity and composition operators; it _excludes_ `run`, `sleep`, `waitForSignal`, `startChild`, `all`, `race`, `offload`, `archive`, `agent`, `setAttribute`, `stream`, `suspendUntil`, `humanReview`. So `ctx.run(...)` fails to typecheck in handler signatures, and the project's own JSDoc prescribes `(ctx as Context).run(...)` — directly contradicting the codebase's "treat `as` with suspicion" rule.

  Widen `WorkflowContext` to the full handler surface (mirror every public method on `Context`). Verify `Context implements WorkflowContext` still holds. Remove every `(ctx as Context)` cast from JSDoc, source, and docs. Replace the JSDoc header rationale with a one-liner. Add a lint rule flagging `as Context` casts inside handlers.

- [x] **Replace `input: unknown` + `as` casts with idiomatic inline parameter annotations across every payload-accepting API.**

  **The decision:** inline parameter annotations (Option B) are the everyday default; `Engine<TRegistry>` (Option C) is the opt-in upgrade for cross-call typing. Both coexist.

  **Surfaces:** `engine.register` (`src/core/engine.ts:2473-2483`), `engine.start` (`engine.ts:2693`), `engine.signal` / `engine.update` / `engine.query`, `ctx.waitForSignal` (already generic on receive — gap is on send), `engine.registerActivity` (`engine.ts:2681`), `WorkflowRegistration` update/query handlers.

  Verify TypeScript contextual typing flows when the user writes `async (ctx, input: { name: string }) => ...`; tighten overload signatures if it doesn't. Audit and rewrite every `as { ... }` cast in README, `documentation/getting-started/*`, `documentation/guides/*`, `documentation/agents/*`, JSDoc in `engine.ts` / `context.ts` / `types.ts`. Add a lint rule flagging `as <ObjectType>` directly inside `register` / `start` / `signal` / `update` / `query` callbacks.

- [ ] **Unify `activity()` to handle both bare-function and metadata forms; add a peer `workflow()` helper; tighten the activity calling convention to single-input.**

  **Where:** `src/core/types.ts:1943` (existing `activity()`), `types.ts:654` (`ActivityFunction<TInput, TOutput>`), `src/core/engine.ts:9180` (runtime args-spread), `engine.ts:2473-2483` (`register` overloads). New: `workflow()` helper.

  Three intertwined fixes:
  1. **Single-input activity convention.** `ctx.run(sendConfirmation, { email, receiptId })` — not `ctx.run(sendConfirmation, email, receiptId)`. `ActivityFunction<TInput, TOutput>` becomes a strict two-parameter contract; runtime no longer spreads. Aligns with `OperationDefinition`, MCP, codegen, and every RPC framework convention.
  2. **`activity()` overloads** — bare-function form (`activity(async (input) => ...)` infers name from `fn.name`) and metadata form (`activity({ name, retry, timeout, queue, execute })`). Both return the same callable + `ActivityDefinition`.
  3. **Peer `workflow()` helper** — same overload pattern. Bare generator (name inferred) or metadata (`{ name, version, handler, migrate, searchAttributes, retention }`). `engine.register(workflow)` becomes the canonical registration form (no name string).

  Update `documentation/guides/activities.md`, `documentation/guides/workflows.md`, README's checkout example. Lint rule: flag `ctx.run(fn, a, b, ...)` with more than two arguments. If `fn.name === ''` (anonymous arrow with no variable hoisting), throw at definition time.

  Lands _before_ the Unified Operation Catalog work — the catalog assumes single-input definitions with introspectable metadata.

- [ ] **Add `signal()`, `update()`, `query()` typed handles for the message-shaped surfaces.**

  **Where:** `src/core/types.ts` (new exports), `src/core/context.ts:1975` (`onUpdate` and the corresponding `onQuery`), `engine.ts` (`engine.signal` / `update` / `query` currently take `payload: unknown`).

  Each helper returns a small typed value carrying name + phantom input/output types:

  ```ts
  const approval = signal<{ approved: boolean }>('approval');
  const approveOrder = update<{ orderId: string }, { status: 'approved' | 'rejected' }>(
    'approveOrder',
  );
  const orderStatus = query<{ orderId: string }, { state: string; updatedAt: number }>(
    'orderStatus',
  );
  ```

  Overload `engine.signal` / `engine.update` / `engine.query`, `ctx.waitForSignal`, `ctx.onUpdate`, `ctx.onQuery` to accept either a string (legacy / dynamic) or a typed handle. Schema attachment via optional Zod is deferred to the Standard Schema item below. Lint rule flags `engine.signal(id, '<string-literal>', ...)` calls.

- [ ] **Complete the definition vocabulary: `searchAttribute()`, `interceptor()`, `constraint()`, `schedule()`, and rename `defineAgent` → `agent`.**

  Family pattern — every primary primitive defined via a function named after the primitive.
  - **`searchAttribute(name, type)`** — accepts three forms, all converging on JSON Schema internally:
    - Tier 1: bare primitive name (`'string' | 'number' | 'integer' | 'boolean' | 'array' | 'object'`) — sugar for `{ type: <name> }`.
    - Tier 2: JSON Schema fragment (`{ type: 'string', format: 'date-time' }`, `{ type: 'array', items: { type: 'string' } }`).
    - Tier 3: Standard Schema (Zod / Valibot / ArkType) — converted via `toJSONSchema(schema)`.
      Overload `ctx.setAttribute` and `engine.list({ attributes })` to accept either string keys (dynamic) or handles (typed). Replaces the legacy `'datetime'` / `'keyword_list'` tags.
  - **`interceptor(spec)`** — identity-with-inference. Optional `name` for observability.
  - **`constraint(spec)`** — identity helper; types narrow.
  - **`schedule(spec)`** — `{ workflow, cron, input, overlapPolicy }` producing a `ScheduleDefinition` ready for `engine.scheduleCreate`.
  - **Rename `defineAgent` → `agent`** at `src/ai/declaration.ts:222`. Hard rename across source, JSDoc, README, every `documentation/agents/*.md`. `agent()` accepts only the options form (no bare-function form — agents always need at least a model and prompt).

  Add `documentation/reference/api-definitions.md` showing every helper in one table. `import` ergonomics: lean toward flat exports from `weft` (matching Vue/Vite/Nitro). `ctx.onSignal` registration helper is deferred.

- [ ] **Thread Standard Schema through every definition helper.**

  **Where:** every helper above (`workflow`, `activity`, `agent`, `signal`, `update`, `query`, `searchAttribute`, `constraint`, `schedule`).

  One declaration drives three artifacts: TypeScript type (compile-time), validator (runtime at boundaries), JSON Schema (registry, codegen, polyglot SDKs). Use the project's existing `toJSONSchema()` adapter (Zod via `zod-to-json-schema`, Valibot via `valibot-to-json-schema`, etc.). Schemas are optional for purely-internal definitions; required for anything crossing a process boundary (HTTP, MCP, codegen). Document the heuristic.

- [ ] **Replace `SearchAttributeDefinition` with JSON Schema.**

  **Where:** `src/core/types.ts:404-406` (the hand-rolled tag enum `'string' | 'number' | 'boolean' | 'datetime' | 'keyword_list'`), the indexer, `engine.list` filter validation, every doc that mentions search-attribute types.

  Replace the tag enum with the JSON Schema fragments produced by `searchAttribute()`. `'datetime'` becomes `{ type: 'string', format: 'date-time' }`; `'keyword_list'` becomes `{ type: 'array', items: { type: 'string' } }`. Filter coercion logic in `engine.list` reads the schema fragment instead of the tag. Test that the existing search-attribute behavior (string indexing, date-range filters, array containment) is preserved across the cleanup.

- [ ] **Redesign `SharedState` from first principles: three named primitives with scope in the name.** 🚨

  **Severity: high.** The current class promises cross-workflow sharing (the name says so) but its tests demonstrate single-workflow private state — storage keys are `shared:${workflowId}:${stateKey}`. Two workflow runs each passing `ctx.workflowId` write to different keys and share nothing. Users get burned silently.

  **The redesign — three primitives, scope in the name:**
  - **`tenantState<T>(key, options?)`** — every workflow in a tenant shares this. Storage key: `state:tenant:${tenantId}:${key}`.
  - **`workflowTypeState<T>(workflowType, key, options?)`** — every execution of a given workflow type within a tenant shares this. Storage key: `state:type:${tenantId}:${workflowType}:${key}`.
  - **`ctx.runState<T>(key, options?)`** — between a workflow execution and its children/concurrent branches. Storage key: `state:run:${ctx.workflowId}:${key}`.

  Tenant ID resolves from the engine's tenant resolver (or `ctx.tenant`); throws clearly if no tenant context. The current `SharedState` class stays as the underlying primitive (rename to `AtomicState` — more accurate, atomicity via CAS is the actual guarantee) and as the escape hatch for custom scopes.

  **Other changes:**
  1. **`initial: T` at construction**, not on every call site. `.get()` returns `initial` if no value written; `undefined` if no `initial` and no value written.
  2. **Three observation surfaces, one event source.** Instances `extends EventTarget` (events: `change`, `conflict`, `exhausted`), implement `[Symbol.observable]()` (RxJS / Zen interop — use `Symbol.observable ?? Symbol.for('https://github.com/benlesh/symbol-observable')`), and `[Symbol.asyncIterator]()` (`for await`). All three project the same underlying event stream. Local-only; cross-process delivery is a follow-up.
  3. **Convenience methods over `.update()`** (no Proxy — hides asynchrony, breaks compound expressions). Always: `.get()`, `.update(fn)`, `.set(value)`, `.delete()`. For numeric `T`: `.increment(by?)`, `.decrement(by?)`. For object `T`: `.merge(partial)`. For array `T`: `.append(item)`, `.removeFirst()`, `.removeLast()`. CAS-on-delete is the safe form.
  4. **Tests** must prove tenant-wide sharing _and_ tenant isolation _and_ type-scoped sharing _and_ run-scoped sharing. Existing tests pass `'wf-1'` everywhere — single-namespace correctness only.

  Rewrite `documentation/guides/shared-state.md`. Audit `offload`, `archive`, anything else taking a `workflowId` parameter outside a workflow context for the same disease. Pre-release, hard cut.

  **Out of scope:** Proxy form, cross-process change notifications, automatic lifecycle binding, schema validation on writes (covered by Standard Schema item), Immer-style transactional draft.

## 4. Cross-Process Type Generation

- [x] **Add typed `ctx.run` and `engine.start` via a module-augmentation activity registry.**

  **Where:** `src/core/context/index.ts` (`ctx.run`), `src/core/engine/index.ts` (`start` / `registerActivity` typings), `src/core/types/workflow-registries.ts` (`WorkflowRegistry` and `ActivityTypes`).

  Mirror `WorkflowRegistry`. User declares once:

  ```ts
  declare module 'weft' {
    interface ActivityTypes {
      greet: (name: string) => Promise<string>;
      sendEmail: (to: string, subject: string) => Promise<{ id: string }>;
    }
  }
  ```

  `ctx.run` gets a string-name overload that consults the registry. Closure form (`ctx.run(greet, 'Steve')`) keeps working. Completion note: the activity augmentation target is `ActivityTypes` to avoid colliding with the public runtime `ActivityRegistry` class; string-name `ctx.run` now dispatches through registered activity names. Companion to the codegen item below — codegen produces the augmentation; typed `ctx.run` consumes it.

- [ ] **Expose JSON Schema registries from the server.**

  **Where:** new endpoint `GET /v1/registry` (or a JSON-RPC method); reuses the same `zod-to-json-schema` path the OpenRPC generator uses (`src/server/openrpc.ts:142-144`).

  Returns `{ workflows: { name: { input, output, ... } }, activities: { name: { input, output, queue, ... } } }`. Gated behind an authenticated scope (schemas leak internal data shapes). Worker-supplied activity schemas: extend the `RemoteWorker` registration message (`src/worker/index.ts:137`) to carry schemas; the server unions them into the registry document. Snapshot, not stream — codegen is a build step.

  Depends on the Unified Operation Catalog item (workflows/activities as catalog citizens with `inputSchema` / `outputSchema`).

- [ ] **Add `weft codegen` CLI.**

  **Where:** new `src/cli/codegen.ts` and `src/cli/codegen-emit.ts`. Add `'codegen'` to the `CliCommand` union (`src/cli.ts:25-91`); dispatch in `src/cli-main.ts`.

  ```bash
  bunx weft codegen --server https://weft.internal:7233 --token "$WEFT_TOKEN" --out src/weft.generated.d.ts
  ```

  Fetches the registry, validates against an expected Zod shape, emits a single `.d.ts` with module augmentation for `WorkflowRegistry` and `ActivityTypes`. Banner header (`// Generated by weft codegen — DO NOT EDIT. Source: <url> at <timestamp>`); deterministic byte-identical output for stable diffs; alphabetically-sorted keys; idempotent writes. JSON Schema → TypeScript via `json-schema-to-typescript`. Optional `tsc --noEmit` validation post-write — schema producing invalid TS is a server-side bug, fail fast.

  Auth via `--token`, env var `WEFT_TOKEN`, or `~/.weft/credentials`. `--config <path>` for JSON or TS config files (mirrors `prisma generate`, `drizzle-kit`, `openapi-typescript`). `--watch` polls for change; `--from <path>` reads from local file (offline / vendored). `--target` flag designed for future `python` / `go` emitters; v1 ships TypeScript only. Multi-server via running the command multiple times (v1 simplicity).

  Gated by the Unified Operation Catalog item and the JSON Schema registry endpoint above.

## 5. Unified Operation Catalog & Schema Discovery

The catalog (`src/server/operation-catalog.ts`) is already transport-neutral and well-shaped; `executeOperation` is the single dispatch entry. The items below extend it to workflows/activities and to the schema-discovery surfaces (OpenAPI, AsyncAPI, OpenRPC errors, well-known catalog).

- [ ] **Unify `WorkflowRegistration` and `ActivityRegistrationOptions` with the `OperationDefinition` shape.**

  Workflows and activities become catalog citizens carrying `inputSchema`, `outputSchema`, transport-availability flags, access policies, and an introspection surface. Schemas are opt-in in v1, ratchet to "required for MCP-exposed workflows" once the MCP server lands. Standard Schema for the validator interface (cross-validator interop). This is the foundation for codegen, MCP tool input schemas, AsyncAPI per-workflow payloads, and OpenAPI request body hydration.

- [ ] **Audit `executeOperation` coverage: every transport must route through it, or document why not.**

  **Trace these entry points:**
  - **SSE workflow stream** (`src/server/operations/stream-workflow-sse.ts`) — verify whether it goes through `executeOperation`.
  - **WebSocket subscriptions** (`weft.workflows.subscribe` / `unsubscribe` in `src/server/json-rpc-websocket.ts`) — bidirectional / long-lived; how do they participate?
  - **Engine-level event feed** (`src/server/engine-event-feed-backend.ts`) — internal but a transport surface if the dashboard or external clients consume it.
  - **`src/dashboard/`** anything that talks to the engine directly — bypassing the catalog means bypassing access policies and validation.

  For each bypass: route through `executeOperation`, or add a documented exemption with a justification + test. Add a coverage test that enumerates transport entry points and asserts each calls `executeOperation`.

  (MCP transports — `src/ai/mcp/transport-*.ts` — are deleted by the AI Surface Shrinkage item, so no audit needed there. The future MCP server exposes Weft workflows via `executeOperation` from day one.)

- [ ] **Add a first-class abstraction for streaming / subscription operations in the catalog.**

  Introduce `OperationKind: 'unary' | 'stream' | 'subscription'`. Stream/subscription operations declare `eventSchema` (message payload) in addition to `inputSchema` (subscribe request) and `outputSchema` (subscribe response). `executeOperation` stays unary; add `executeStream` / `executeSubscription` sharing the same access / validation / authorize / classify pipeline.

- [ ] **Hydrate OpenAPI request/response bodies with real schemas instead of stubs.**

  **Where:** `src/server/openapi.ts:90, 99, 125` — every body-accepting route currently emits `{ schema: { type: 'object' } }` and every response emits only `responses['200']: { description: 'Successful response' }`. The schemas already exist (the OpenRPC generator pulls them via `zod-to-json-schema`).

  In `emitBindings` / `emitRoutes`, look up the operation in the registry and reuse `inputSchema` / `outputSchema`. Promote shared schemas to `components.schemas` and `$ref` them. Document error responses from `src/server/fault-to-json-rpc.ts` (`400`, `401`, `403`, `404`, `409`, `429`, `500` with a shared `Error` schema). Add `examples` per operation.

- [ ] **Generate an AsyncAPI 3.0 document at `/asyncapi.json`.**

  **Where:** new `src/server/asyncapi.ts`, new route in `src/server/route-model.ts`. Catalogs WebSocket subscriptions and the SSE endpoint.

  `generateAsyncApiDocument()` driven from the same `OperationRegistry` the OpenRPC generator uses. Channels: one per WebSocket subscription topic, one per SSE event type. Document the WebSocket lifecycle (register, subscribe, heartbeat, unsubscribe, reconnect-with-cursor — `engine-event-feed-backend.ts` already has cursor semantics). Public path; add to `DEFAULT_PUBLIC_PATHS` in `src/server/authentication.ts:307`. Drift-prevention test mirroring `track8-discovery-parity.test.ts`.

- [ ] **Add `/.well-known/api-catalog` per RFC 9727 + OpenRPC error catalog + `info` polish.**

  Three small but symmetric items, group in one PR pass:
  1. **`/.well-known/api-catalog`** — static JSON document referencing every catalog the server exposes (`/openapi.json`, `/openrpc.json`, `/asyncapi.json`, MCP descriptor). RFC 9727 linkset format. Drift-prevention test.
  2. **OpenRPC `components.errors`** — audit `src/server/fault-to-json-rpc.ts` for the canonical fault-code list; capture each as `{ code, message, data: <schema> }`. Per-operation `errors: string[]` declares which errors the operation can produce. Test invariant: every error code thrown in the codebase must be declared and listed on its method.
  3. **OpenAPI / OpenRPC `info` polish** — `src/server/openapi.ts:174` and `src/server/openrpc.ts:88` currently have only `title` + `version`. Add `description`, `contact`, `license`, `externalDocs`. Per-operation `examples`. Configurable via `serve()` options.

**Sequencing for this section:** unified catalog (foundation) → executeOperation audit → streaming abstraction → OpenAPI bodies → AsyncAPI → group-PR for `api-catalog` / OpenRPC errors / `info` polish. MCP descriptor item is in section 6.

## 6. MCP Server Support

Per the AI Surface Shrinkage decision, Weft does not ship an MCP _client_ (`armorer` owns MCP-as-tool-source). Weft's _workflow_ surface is a separate concern: there's value in exposing Weft workflows as MCP tools/resources to external MCP clients (Claude Desktop, Cursor, Anthropic SDK).

- [ ] **Implement an MCP server exposing Weft as a first-class MCP service — remote HTTP and local stdio (`npx weft-mcp`).**

  **Two deployment shapes, both first-class:**
  1. **Remote MCP (HTTP)** — long-lived Weft server, MCP added to the existing transport surface. Uses **Streamable HTTP** (2025-03-26+ spec) — single endpoint accepting POST (client→server) and GET (server→client SSE), with session resumption via `Mcp-Session-Id` header. Multi-tenant, OAuth-authenticated.
  2. **Local stdio (`npx weft-mcp`)** — standalone npm package (`weft-mcp` or `@weft/mcp`). Two modes:
     - **Embedded** (`--db ./weft.db`): in-process engine against local SQLite. No auth; local user filesystem is the trust boundary.
     - **Proxy** (`--server https://... --token $WEFT_TOKEN`): forwards every MCP request to a remote Weft server. Local credential holder for hosted deployments.

  ```json
  {
    "mcpServers": { "weft": { "command": "npx", "args": ["-y", "weft-mcp", "--db", "./weft.db"] } }
  }
  ```

  **Concrete (per 2025-06-18 spec):**
  - **Lifecycle:** handle `initialize` with `protocolVersion`, `capabilities`, `serverInfo`; respond with negotiated capabilities; receive `notifications/initialized` to mark ready. Reject other methods until ready.
  - **Capabilities:** `tools` with `listChanged: true`, `resources` with `subscribe: true` and `listChanged: true`, `prompts` (optional v1), `logging`.
  - **Tools:** every registered workflow becomes an MCP tool; `inputSchema` is the workflow's `inputSchema`. Plus engine-control tools: `start_workflow`, `signal_workflow`, `update_workflow`, `query_workflow`, `cancel_workflow`, `list_workflows`, `get_workflow_state`. Per-workflow tools named `start_<workflow_name>` (lowercase, underscores).
  - **Resources:** read-only views — workflow state by ID, checkpoint history, event log, search-attribute query results. URIs like `weft://workflow/<id>/state`, `weft://workflow/<id>/checkpoints/<step>`, `weft://workflows?status=running`. Subscribable; uses the existing event-feed backend.
  - **Methods to handle:** `initialize`, `notifications/initialized`, `notifications/cancelled`, `tools/list`, `tools/call`, `resources/list`, `resources/read`, `resources/subscribe`, `resources/unsubscribe`, `resources/templates/list`, `prompts/list`, `prompts/get`, `logging/setLevel`, `ping`, `completion/complete`. Outbound notifications: `tools/list_changed`, `resources/list_changed`, `resources/updated`, `progress`, `message`.
  - **Auth:** Remote uses OAuth 2.1 with PKCE per MCP spec. Reuse `src/server/authentication.ts` and `src/server/authorization-scope.ts`. (The client-side OAuth helper at `src/ai/mcp/oauth2-token-manager.ts` is deleted by the shrinkage; the server reimplements the authorization-server half against existing infrastructure.) Local stdio: no auth on the wire.

  **Implementation must follow:**
  - Tool input schemas are JSON Schema (convert via `zod-to-json-schema`).
  - Tool names: lowercase + underscores (`start_checkout_workflow`, not `startCheckoutWorkflow`).
  - Tool descriptions are user-facing — sourced from workflow registration metadata (add `description?: string` to `WorkflowRegistration`).
  - `tools/call` errors return `isError: true` with a `content` block, **not** a JSON-RPC error.
  - Long-running calls: cancellation via `notifications/cancelled` (maps to `engine.cancel(id)`); progress via `notifications/progress`.
  - Pagination from day one. Every MCP-exposed workflow must have an `inputSchema` — reject otherwise.
  - Tenant scoping: remote resolves via session auth token's OAuth scope claim; local embedded is single-tenant; local proxy forwards configured token's tenant.
  - Activities are **never** exposed as standalone MCP tools — workflows are the durable unit. Document the rationale.
  - Conformance test: stand up the MCP reference test client (or use Claude Desktop in CI) against both transports.

  Binary distribution: separate `weft-mcp` package built via `bun build --compile`. Lands after the AI Surface Shrinkage and the unified-catalog foundation.

- [ ] **MCP server catalog endpoint.**

  Once the server exists, add an `x-weft-mcp` extension on the OpenRPC document plus a `/.well-known/mcp.json` route. Native MCP `tools/list` is the canonical answer for live introspection; the static catalog is for build-time consumers. Lean minimal — extension on OpenRPC + live `tools/list` is enough; separate static catalog is nice-to-have. Gated by the MCP server item.

## 7. API Ergonomics

- [ ] **Rename `Otel*` identifiers to `OpenTelemetry*` throughout the observability module.**

  **Where:** pervasive in `src/observability/metrics.ts`, `src/observability/no-op-telemetry.ts`, `src/observability/index.ts`, every test, `src/index.ts` re-exports, `documentation/agents/agent-observability.md`, `documentation/guides/observability.md`, README.

  Type renames: `OtelMetrics` → `OpenTelemetryMetrics`, `OtelApi` → `OpenTelemetryApi`, `OtelSpan` → `OpenTelemetrySpan`, `OtelMeter` → `OpenTelemetryMeter`. Function renames: `createOtelMetrics` → `createOpenTelemetryMetrics`, `getOtelApi` → `getOpenTelemetryApi`. Field rename: `ObservabilityOptions.otelApi` → `openTelemetryApi`. Hard rename, single PR.

- [ ] **Collapse `workflowInterceptors` and `activityInterceptors` into a single `interceptors` list.**

  **Where:** `src/core/engine.ts` (constructor options + the two `#interceptors` fields + every method routing through them), `src/core/interceptor.ts` (types + composition helpers, lines 491-791), `src/observability/index.ts:862` (`createObservabilityInterceptors` returns `{ workflow, activity, metrics }` today — should return one object).

  One `Interceptor` type with all hooks optional (workflow-side: `activity`, `sleep`, `signal`, etc.; activity-side: `execute`). `Engine` accepts `interceptors?: Interceptor[]`; internally splits the unified list into the existing dual pipelines by filtering for present hooks. An interceptor's position in the list determines wrapping order for both pipelines simultaneously. Mechanical rewrites in consuming code: `[interceptors.workflow]` + `[interceptors.activity]` → `[interceptors]` (the factory now returns one object).

- [ ] **Move `TestEngine`, `TimeControl`, `ActivityMockRegistry`, and chaos helpers to a `weft/testing` subpath export.**

  **Where:** add `"./testing"` to `package.json` `exports`; remove the testing re-exports from `src/index.ts:323-330`; create `src/testing/index.ts` as the new barrel.

  Update `documentation/guides/testing.md`, README's `TestEngine` example, every doc example becomes `import { TestEngine } from 'weft/testing'`. Add a tree-shaking verification entry to `scripts/verify-tree-shaking.ts` proving production imports don't pull testing primitives into the bundle.

- [ ] **Default `Engine` to a runtime-appropriate storage backend when `storage` is omitted.**

  **Where:** `src/core/engine.ts` (`Engine` constructor), `src/core/types.ts` (`EngineOptions.storage` becomes optional). Pairs with `resolveStorage()` from section 8.

  If `storage` is omitted, the constructor invokes `resolveStorage({ type: 'auto' })`. Detection order: `typeof Bun !== 'undefined'` → `BunSQLiteStorage`; `process.versions?.node` → `NodeSQLiteStorage`; `chrome.storage` (or `browser.storage`) → `WebExtensionStorage`; `typeof indexedDB !== 'undefined'` → `IndexedDBStorage`; otherwise throw with a clear message. Lazy-load adapters; conservative defaults (`./weft.db`, `weft`); one-time info log on first auto-detection (`"[weft] Auto-detected runtime: bun. Using BunSQLiteStorage at ./weft.db. Pass `storage` explicitly for production."`).

  Hello World becomes `new Engine()`. Tests for each runtime (IndexedDB / WebExtension cases need browser-test or extension-test harnesses).

- [ ] **Add a `setupServiceWorker()` helper.**

  **Where:** new `src/service-worker/setup.ts`, exported from `weft/service-worker`. Existing per-handler functions (`createFetchHandler`, `createPeriodicSyncHandler`, `createLifecycleHandlers`, `ServiceWorkerScheduler`) stay as the lower-level escape hatch.

  ```ts
  /// <reference lib="webworker" />
  import { setupServiceWorker } from 'weft/service-worker';
  const { engine } = setupServiceWorker({ pathPrefix: '/weft/' });
  engine.register('checkout', async function* (ctx, input) {
    /* ... */
  });
  ```

  Internally creates `IndexedDBStorage` (`databaseName?` default `'weft'`), an `Engine`, a `ServiceWorkerScheduler` wired to `processTimer`, and registers `install`/`activate`/`fetch`/`periodicsync` listeners on `self`. Returns `{ engine, storage, scheduler }`. Options: `pathPrefix`, `databaseName`, `engine` (escape hatch), `storage` (escape hatch), `periodicSyncTag` (default `'weft-timers'`), `register` (pre-register workflows before listeners attach). Pairs with the auto-storage item — together, Service Worker setup drops to ~6 lines.

## 8. Storage

- [x] **Consolidate SQLite imports under `weft/storage/sqlite`; delete the legacy `weft/storage/bun-sqlite` alias.**

  Auto-detect path already exists (`./storage/sqlite` resolves to Bun or Node module via export conditions); the legacy `./storage/bun-sqlite` parallel name is what every doc currently imports. Cleanup:
  1. Delete `./storage/bun-sqlite` from `package.json` `exports`.
  2. Update README (lines 38, 190, 206, 310), `documentation/getting-started/hello-world.md:158`, `documentation/getting-started/installation.md:31`, `documentation/guides/storage.md:71`, `documentation/guides/resource-management.md:10`, `documentation/reference/api-storage.md:170`, plus a final grep.
  3. Add a runtime-neutral re-export `SQLiteStorage` to each backend module so cross-runtime code typechecks against the same name.
  4. Document `weft/storage/sqlite/bun` and `weft/storage/sqlite/node` as the explicit-override escape hatches.
  5. Verify Bun and Node conditions actually work end-to-end via a build-output integration test (build a tiny consumer, run under each, assert the right constructor name).

- [x] **Add `WebExtensionStorage` for WebExtension contexts.**

  **Where:** new `src/storage/web-extension.ts`; new `weft/storage/web-extension` subpath in `package.json` `exports`.

  Implement the `Storage` interface against `chrome.storage.local` / `browser.storage.local`. Detect both namespaces (`globalThis.browser ?? globalThis.chrome`). Map five required methods (`get`, `put`, `delete`, `scan`, `batch`). Storage values are `Uint8Array`; base64-encode for WebExtension storage (which only accepts JSON-serializable values), or use the chunking pattern for large blobs. Constructor option: `area: 'local' | 'sync' | 'session' | 'managed'` (default `local`, `managed` is read-only). Honor `chrome.storage.sync` quotas (100KB total, per-item limits) — fail fast with a clear error rather than silent chunking. Lazy-load WebExtension storage access; throw clearly if absent. Test harness: Playwright + a tiny test extension. Manifest example: `"permissions": ["storage"]`.

- [x] **Add `HTTPStorage` adapter for remote storage over HTTP.**

  **Where:** new `src/storage/http.ts`; new `weft/storage/http` subpath in `package.json` `exports`. Server-side route handler in `src/server/operations/storage-*.ts`.

  Plain `fetch()` calls. `get` → `GET /v1/storage/{key}`, `put` → `PUT /v1/storage/{key}`, `delete` → `DELETE /v1/storage/{key}`. Auth: `Authorization: Bearer ...` (same as the rest of Weft's HTTP surface). Streaming for `scan` via NDJSON or chunked transfer; client consumes as `AsyncIterable`. `conditionalBatch` (CAS) translates to a structured POST applied atomically server-side — required for `SharedState`-style CAS to work over remote storage. Server-side route is authorization-scoped per tenant. Required before the Agent Bureau storage migration.

  **Out of scope:** pub/sub for `'change'` notifications across remote clients (separate, larger concern paired with `SharedState` observable interface).

- [x] **Add `resolveStorage(config)` helper for runtime-driven backend selection.**

  ```ts
  type StorageConfiguration =
    | { type: 'memory' }
    | { type: 'sqlite'; path: string }
    | { type: 'lmdb'; path: string }
    | { type: 'turso'; url: string; authToken?: string }
    | { type: 'indexeddb'; databaseName?: string }
    | { type: 'web-extension'; area?: 'local' | 'sync' | 'session' | 'managed' }
    | { type: 'http'; baseUrl: string; headers?: Record<string, string> }
    | { type: 'auto' };
  ```

  `'auto'` mode picks based on runtime detection (matches the auto-storage item in section 7). Each adapter is lazy-imported only when its config type is selected. Pure programmatic helper; no env-var or config-file parsing.

## 9. Polyglot Activity Workers (Path A)

**Architectural decision:** workflows are TypeScript-only by design (generators don't serialize across processes); activities are polyglot via the `RemoteWorker` wire protocol.

- [ ] **Formally specify the `RemoteWorker` wire protocol so SDKs in other languages can implement it.**

  **Where:** new `documentation/specifications/remote-worker-protocol.md`. Driven from existing `src/worker/index.ts` (registration, dispatch, heartbeat) and `src/server/json-rpc-websocket.ts` (server side).

  Document:
  1. **Message envelope and types.** Worker → Server: `register`, `heartbeat`, `task_complete`, `task_failed`, `task_progress`. Server → Worker: `task`, `cancel`, `disconnect`. Full payload shape, required vs. optional fields, semantics of empty vs. omitted fields.
  2. **Lifecycle state machine.** Connect → register → idle → claim → execute → report → idle. Disconnect-mid-task behavior. Heartbeat lapse. `disconnectTimeoutMs` semantics. Reconnection: does the server reissue in-flight tasks?
  3. **Framing.** WebSocket text frames carrying JSON. `Uint8Array` payloads base64-encoded (or MessagePack content-negotiation if available — verify which). No transparent binary support assumed.
  4. **Auth and authz.** Worker auth on connect (`bearerAuth` / `apiKeyAuth` from `src/server/openapi.ts`). Required scopes. Tenant-scoped vs. tenant-agnostic workers.
  5. **Activity contract.** Input/output validation. Error shape (`OperationFault` taxonomy from `fault-to-json-rpc.ts`). Heartbeat semantics for long-running tasks. `AbortSignal` cancellation propagation.
  6. **JSON Schema for every message type.** Drift-prevention test mirroring `track8-discovery-parity.test.ts`.
  7. **Conformance test suite** any candidate SDK can run against — lifecycle, error cases, edge cases (reconnect with in-flight task, heartbeat lapse, cancellation race). Ship as separate package or `weft conformance` CLI subcommand.
  8. **Versioning.** `protocolVersion` in `register` message; server accepts a range and rejects out-of-range workers with a clear error.

  Stable on-the-wire field names (TS-side renames don't affect wire format). Forward-compatible — additions only, never renames or repurposings. Pick `snake_case` _or_ `camelCase` consistently (audit current).

- [ ] **Document "workflows are TypeScript-only by design" via an ADR + README + architecture pages.**

  **Where:**
  - `documentation/contributing/architecture-decisions/0001-workflows-typescript-only.md` — full ADR recording Status, Context (checkpoint-not-replay model), the constraint (generators not serializable across processes), the implication (engine drives the generator end-to-end in one process), why this makes workflows TS-only (Python `async def` and JS `async function*` have different state machines; cross-language serialization of in-flight execution state cannot be done because no language runtime exposes execution state as a serializable artifact), the three theoretical paths considered (Path B replay-determinism rejected — abandons the defining design choice; Path C separate state-store rejected — collapses back to Path B; Path A chosen — workflows in engine, polyglot activities), Decision, Consequences, Forces, What Stays Open.
  - `documentation/architecture/checkpoint-versus-replay.md` — call out the consequence; readers should see the model and the constraint together.
  - **README** — Design Constraints callout: _"Workflows run in TypeScript on the engine; activities can run in any language via the RemoteWorker protocol. This split is intentional — the checkpoint model requires single-process generator state, so workflow code is TypeScript-only by design."_
  - **Weft vs. Temporal table:** add a row — Workflow language: Temporal _"Any (Go, Java, TS, Python, .NET, Ruby, PHP)"_ / Weft _"TypeScript only (activities can be any language)"_.
  - **Positioning paragraph** for the docs index: _"Weft is for teams whose primary backend language is TypeScript. If you need workflows in multiple languages, Temporal is the right answer."_

  Without a documented ADR, a future contributor proposes a Python workflow runtime, no one remembers why we said no, and the codebase fragments. The ADR is the durable answer.

## 10. Agent Bureau Compatibility 🚨

**Architectural commitment:** Agent Bureau (`/Users/stevekinney/Developer/agent-bureau`) consumes Weft, never the reverse. **Dependency arrow: Agent Bureau → Weft. Hard structural constraint.** Weft cannot import from `armorer`, `conversationalist`, or `interoperability` — `devDependencies` only, for type-compat tests. The two items below scope the Weft-side design that lets Agent Bureau extend Weft's narrow contracts as structural supersets.

- [ ] **Design Weft's tool-and-conversation surface as a minimal durable-execution contract Agent Bureau can compose on top of.** 🚨

  **Where:** new or revised `src/ai/types.ts` (the surviving file after AI Surface Shrinkage), `src/ai/agent.ts` (agent loop), `src/ai/declaration.ts` (becoming `agent()`).

  **Decision: Option C** — Weft owns a minimal durable-execution contract; Agent Bureau extends it with richer semantics via structural superset. (Option B — hoist `interoperability` to a neutral package — remains viable longer-term but is Agent Bureau's call.)

  **Weft's minimal surface:**
  - `JSONValue` — recursive JSON-safe type matching `interoperability`'s shape.
  - `ToolCall { id: string; name: string; arguments: JSONValue }` — minimal for tool calls dispatched at checkpoint boundaries.
  - `ToolResult { id: string; value: JSONValue } | { id: string; error: ToolErrorShape }`.
  - `ToolErrorShape { message: string; code?: string }` — Agent Bureau's `ToolError` extends with `category`, `retry`.
  - `ToolDefinition { name: string; description?: string; inputSchema: JSONValue; execute: (input, ctx?) => Promise<JSONValue> }`.
  - `ConversationHistory` — minimal JSON-safe shape that's a structural _subset_ of `conversationalist.ConversationHistory` so Agent Bureau code can wrap Weft's persisted history in `new Conversation(history)` without translation.

  **The key constraint:** every field must match `interoperability`'s field name and shape exactly, or be absent. No renames, no incompatible shapes. Agent Bureau's types become structural supersets — `interoperability.ToolCall` automatically satisfies `weft.ToolCall`. Audit Weft's surviving types against `interoperability`'s field names during implementation; rename Weft's where they diverge (Pre-release, hard cut on Weft's side).

  **Type-compat test under `test/agent-bureau-compat/`:** import `interoperability` types as `devDependency`-only. Assert at the type level that `interoperability.ToolCall extends weft.ToolCall`, `interoperability.ToolResult extends weft.ToolResult`, `interoperability.ConversationHistory extends weft.ConversationHistory`. Pass `interoperability`-shaped values through Weft's APIs and assert they work without translation.

  Document the structural-superset contract in agent docs. New `documentation/integrations/agent-bureau.md`: _"Weft is the durability layer; Agent Bureau is the agent framework that consumes it."_ Show the canonical setup; link from README.

  **Out of scope:** importing Agent Bureau in Weft source; forking Agent Bureau types into Weft; re-implementing `armorer` middleware or `conversationalist` undo/redo. Provider transport restructuring and MCP integration alignment are subsumed by the AI Surface Shrinkage and MCP Server items respectively — not listed separately here.

- [ ] **Make Weft's `Storage` interface a structural superset of Agent Bureau's `KeyValueStore`.** 🚨

  **Where:** `src/storage/interface.ts`, `src/storage/scoped-storage.ts`, every adapter under `src/storage/`.

  Goal: Agent Bureau drops its own `KeyValueStore` abstraction and consumes Weft's `Storage` directly.

  **Diff today:**

  | Concept           | Weft `Storage`                                            | Agent Bureau `KeyValueStore`        |
  | ----------------- | --------------------------------------------------------- | ----------------------------------- |
  | Value type        | `Uint8Array`                                              | `string`                            |
  | Read              | `get(key): Promise<Uint8Array \| null>`                   | `get(key): Promise<string \| null>` |
  | Write             | `put(key, value)`                                         | `set(key, value)`                   |
  | List              | `scan(prefix, opts): AsyncIterable<[string, Uint8Array]>` | `list(prefix): Promise<string[]>`   |
  | Atomic batch      | `batch(ops)`                                              | (none)                              |
  | Conditional batch | `conditionalBatch?` (CAS)                                 | (none)                              |
  | Namespace         | `ScopedStorage` wrapper                                   | `withNamespace()` helper            |
  | Close             | Via `Disposable`                                          | `close?()`                          |

  **What to change:**
  1. **Value type story:** keep `Uint8Array` canonical; add a `withTextValues()` wrapper (analogous to `ScopedStorage`) that handles `Uint8Array` ⇄ `string` encoding via `TextEncoder` / `TextDecoder`. The contract stays narrow; ergonomic concern solved by a wrapper.
  2. **Add `keys(prefix): Promise<string[]>` convenience** as an optional method (matches Agent Bureau's `list`; saves call sites from collecting `scan`'s `AsyncIterable<[k,v]>`).
  3. **Verify namespacing parity** — `ScopedStorage` covers Agent Bureau's `withNamespace()`; verify it composes cleanly when stacked (e.g., `ScopedStorage(ScopedStorage(s, 'tenant-acme'), 'skills')`).
  4. **Ensure all six Agent Bureau adapter shapes are reachable:**
     - Memory → `MemoryStorage` ✓
     - SQLite → `BunSQLiteStorage` / `NodeSQLiteStorage` ✓
     - IndexedDB → `IndexedDBStorage` ✓
     - Chrome → `WebExtensionStorage` (section 8 item) — must ship before AB migrates.
     - Remote HTTP → `HTTPStorage` (section 8 item) — must ship before AB migrates.
     - `auto` → `resolveStorage()` (section 8 item).
  5. **Type-compat test:** import `KeyValueStore` from `agent-bureau/storage` as `devDependency`-only; assert any Weft `Storage` (suitably wrapped) satisfies `KeyValueStore`.
  6. Document the migration path in `documentation/integrations/agent-bureau.md`.

  Lands with or before the tool-types compat item. Both are pre-1.0; this locks in Weft's storage interface as the canonical shape for the agent ecosystem.

## 11. Documentation

- [ ] **Fix the Hello World example in `README.md` to tell the truth about recovery.**

  **Where:** `README.md` lines 36-60, almost certainly duplicated at `documentation/getting-started/hello-world.md`.

  **The bug:** the example does `engine.start('welcome', { name: 'Steve' })` then `await handle.result()` in the same script and claims that "if the process crashes after `greet` finishes but before the sleep expires, restarting the engine resumes from exactly that point." That's misleading — re-running the script does _not_ resume the previous workflow. Each `start()` without explicit `options.id` mints a fresh `crypto.randomUUID()` (`src/core/engine.ts:2709-2713`), so a second run starts a brand-new workflow and the original is orphaned.

  **What's actually required:**
  - A long-lived process owns the engine and calls `engine.recoverAll()` on boot (`engine.ts:5178`), or
  - The caller passes a stable `options.id` / `idempotencyKey` so re-runs can `getHandle(id)` / `resume(id)`.

  Rewrite Hello World as either a server-shaped example with `recoverAll()` on boot, or pass a stable `options.id` and demonstrate the re-attach-vs-start branch. Audit `documentation/getting-started/key-concepts.md`, the README's "Step API" section, and any dashboard quickstart for the same shortcut.

- [ ] **Hello World implies activities are closures; reality is they're named, registered units.**

  Same files as above. Today's example writes `async function greet(name)` inline and passes it to `ctx.run(greet, user.name)`. That works only because everything's in one process. `ctx.run` captures `fn.name` and yields an operation keyed by that name (`src/core/context.ts:974-982`); the engine resolves it via `#activityRegistry.resolve(operation.activityName)` (`engine.ts:6686`). On the remote path, only the name + serialized args travel over the WebSocket — the closure-captured `fn` never runs.

  Fix: in Hello World, either call `engine.registerActivity('greet', ...)` and reference by name, or keep the closure form with a one-line note pointing at Remote Workers. In `documentation/guides/activities.md`, lead with "activities are registered by name; `ctx.run` dispatches by name." Show the paired engine + worker shape end-to-end in the Remote Workers section.

- [ ] **Write `documentation/guides/multi-tenancy.md` and link it from the README.**

  **The gap:** the README has 12 lines on multi-tenancy (lines 237-250) showing `tenantFromInputField` and `tenantQuotas`, with no deeper guide. Tenant references are scattered across `documentation/guides/remote-workers.md` and `interceptors.md`.

  **What the guide must cover:** conceptual model (logical isolation boundary); tenant resolution (`tenantFromInputField`, custom `tenantResolver`, default-tenant behavior, resolution failures); per-tenant quotas (`maxRunningWorkflows`, `workflowCreationRateLimit`, storage quotas — what's enforced where, what error surfaces, how to monitor); tenant scoping in agents (cross-link `documentation/agents/agent-declaration.md`'s `toolsForTenant`); tenant context in workflows (`ctx.tenant`, propagation to activities, interceptor visibility); storage isolation (`ScopedStorage`); deployment patterns (single-engine multi-tenant, per-tenant engines, hybrid); observability and auditing (tenant-tagged events / traces / metrics); security boundaries (what tenants cannot vs. can see across each other); common pitfalls (resolver returning wrong tenant, quotas hitting before user expects, cross-tenant signal injection, debugging "wrong tenant" incidents).

  Cross-link to `agent-declaration.md`, `api-context.md`, `api-engine.md`, `configuration.md`, `remote-workers.md`, `interceptors.md`. Add a `[Multi-Tenancy](documentation/guides/multi-tenancy.md)` link to the README's Documentation/Guides bullet list and a one-line pointer at the end of the README's Multi-Tenancy section. Ship the guide and the README link in the same PR.

- [ ] **Write `documentation/guides/service-worker.md`.**

  **Where:** new file. Cross-link from `documentation/architecture/browser-runtime.md` (currently the only walkthrough), `documentation/guides/server.md` (mentions in passing at line 206), README.

  **What the guide must cover:** conceptual model (Service Worker as durable persistence backbone over IndexedDB; background timer wakeup via Periodic Background Sync; intercepts `fetch` for the engine's HTTP surface); quickstart using `setupServiceWorker()` (after section 7's helper lands); registration (`navigator.serviceWorker.register('/sw.js')`, registering workflows inside the worker, communicating from page code via the engine's HTTP surface); Periodic Background Sync (Chrome / Edge / Opera; not Firefox / Safari at time of writing — verify; fallback when unavailable is `setTimeout` polling that only works while a tab is open); limitations and gotchas (~30s idle termination, IndexedDB quota, first-install lifecycle race, HTTPS requirement except localhost, scope considerations); path prefix and the engine's HTTP surface (`pathPrefix` default `/weft/`); browser support matrix; debugging (Application tab, Update on reload, clearing storage); pairing with PWAs; common pitfalls (Periodic Background Sync not registered/supported being the most common, hot-reload causing reload loops, cross-tab state coordination via `BroadcastChannel`).

  **Out of scope:** general Service Worker tutorials (link to MDN); PWA build tooling (Workbox, vite-plugin-pwa) — different concern, mention in passing; Web Workers (non-Service-Worker) — separate doc.
