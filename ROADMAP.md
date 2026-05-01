# Roadmap

A running list of issues, gaps, and follow-ups discovered while reading through the docs. Each item should carry enough context that we can pick it up cold later without re-doing the investigation.

> [!IMPORTANT]
> The first section below — **AI Surface Shrinkage** — is the architectural decision the rest of the AI-related items now depend on. Read it first; it sets the value-add boundary every other AI/agent item assumes. Pre-release means we delete dead items rather than tombstoning them; if you remember a "rewrite the MCP client" or "restructure the AI providers" item being here, it's gone — that work moved to `armorer` / `conversationalist`.

## AI Surface Shrinkage

- [ ] **🚨 Audit `src/ai/*` against the durability test. Cut everything that isn't durability-essential. Reframe Weft's agent pitch around the narrower surface.**

  **Severity: high. Pre-1.0 commitment.** Today, Weft's `src/ai/` directory contains roughly 20 modules covering every agent-shaped concern: provider abstraction, token counting, budget tracking, cost enforcement, context window management, model routing, provider health, MCP client, prompt cache, tool cache, streaming, confidence voting, multi-agent coordination, human review, hooks, events, plus the agent loop itself. Most of these features either _don't require durability_ (they're pure functions or stateless transforms) or _are already solved_ by `armorer` / `conversationalist` / a future agent-orchestration library. **Weft is doing too much. The pitch is diluted; the surface is bloated; the maintenance burden is misallocated; the value-add boundary the rest of the roadmap carefully drew has been ignored in this corner of the codebase.**

  **The test that separates "Weft's job" from "not Weft's job":**

  > _Does this feature fundamentally require checkpoint-and-recovery semantics, or does it just happen to be useful in agent contexts?_
  - Requires durability → Weft.
  - Useful but not durability-shaped → not Weft's job. Belongs in `armorer`, `conversationalist`, or a dedicated upstream library.

  **The inventory, run through the test:**

  **Genuinely Weft's job (durability-essential — keep):**
  - **The agent loop** (`agent.ts`, `executeAgentLoop`). A ReAct-style loop where each tool call is a checkpoint boundary, where partial progress survives crashes, where the loop can resume after hibernation. _This_ is the feature that distinguishes Weft from "just import an SDK and write a `while` loop." It's durable execution applied to LLM-driven control flow.
  - **Durable multi-agent coordination** (`coordination.ts`, `durable-coordination.ts`). Handoff, supervision, debate — when these need to survive crashes mid-coordination, that's checkpoint semantics applied to multi-agent state machines.
  - **Tool effect log** (`tool-effect-log.ts`). A persisted record of what tool calls produced what results, scoped to a workflow run, durable across crashes. Specialized checkpoint-aware activity logging.
  - **Human review** (`human-review.ts`). A workflow yields to human input, sleeps in storage, resumes when the human responds. Probably collapses into a more general `ctx.waitForSignal` primitive — but the durability dimension is real.
  - **Hooks** (`hooks.ts`). Only if they fire at _checkpoint boundaries_. Hooks that wrap general function execution belong in `armorer` (which already has middleware).
  - **Events** (`events.ts`). Only the durability-shaped events (workflow-started, checkpoint-committed, agent-resumed). Agent-shape events (tool-called, model-responded) fire in upstream libraries.

  **Not Weft's job (move to upstream or delete):**
  - **Provider abstraction** (`providers/anthropic.ts`, `providers/openai.ts`, `providers/interface.ts`, `providers/types.ts`, `providers/stream-reader.ts`). A TS app calling LLMs needs this with or without durable execution. Belongs in `armorer` (tool-call shape) and `conversationalist` (message shape). Weft's agent loop accepts an `LLMProvider`-_shaped_ object (structural type) and calls it — providers themselves live upstream.
  - **Token counting** (`token-counting.ts`). Pure function over messages and a tokenizer. `conversationalist/context` already has `estimateConversationTokens`. Delete Weft's.
  - **Budget tracking and policy** (`budget.ts`, `budget-policy.ts`). Enforcement is "check before each turn." Tracking state is `SharedState` plus arithmetic — no agent-specific durability. `armorer` already has middleware shape (caching, rate limiting, timeouts); budget enforcement is the same pattern. Move there with optional `SharedState` integration when running inside Weft.
  - **Context window management** (`context-window.ts`, `context-strategies/`). Sliding window, summarization, message reordering — stateless transforms over message arrays. `conversationalist` already has compaction. Move there or delete.
  - **Model routing** (`model-router.ts`). Pure function from context to provider+model. Stateless. Belongs in `armorer` or a dedicated routing library.
  - **Provider health** (`provider-health.ts`). Circuit breaker, retry, fallback — useful, not durability-shaped. Belongs at the SDK/provider layer.
  - **MCP client** (`mcp/`). Already separately tracked as needing rewrite — but the right answer isn't "rewrite," it's "delete." `armorer` has MCP integration; that's the right home. Weft's agent loop accepts tools from anywhere, including `armorer`-sourced MCP tools.
  - **Streaming** (`streaming.ts`, `streaming-agent.ts`). Streams themselves don't survive crashes; the _checkpoints between them_ do. `conversationalist` has streaming-message helpers; `armorer` has stream output for tools. Weft just needs to checkpoint at the right boundaries.
  - **Prompt cache** (`prompt-cache.ts`). "Save a result, return it later if matched." `armorer` has caching middleware. Move there.
  - **Tool cache** (`tool-cache.ts`). Same shape as prompt cache. Move to `armorer`.
  - **Confidence voting** (`confidence-voting.ts`). A specific multi-agent pattern. Useful, opinionated. Belongs in an agent-framework layer (Agent Bureau), not a primitive runtime.
  - **Agent declaration** (`declaration.ts`, `defineAgent`). Becomes very thin once the surface shrinks — just `agent({ provider, tools, loop options })`. Already tracked under the unified-vocabulary `agent()` rename; this item informs what `agent()` actually accepts.

  **What to change:**
  1. **For each module in the "not Weft's job" list above, decide its fate:** move to upstream library (and coordinate the upstream addition), or delete entirely. Pre-release, no migration cost. Track each as a sub-task; do them all in one PR-window so the surface shrinks coherently rather than being half-cut.

  2. **Rework the agent loop's interfaces.** `executeAgentLoop` takes:
     - A _structural-typed_ `LLMProvider` (no Weft-shipped provider classes — bring your own).
     - A list of _structural-typed_ tools (anything that conforms to a minimal `Tool` shape — `armorer` tools satisfy it; plain functions wrapped at the call site satisfy it).
     - Loop options (max turns, system prompt — minimal). Budget, model routing, context strategy are all _optional_ hooks that delegate to upstream-supplied implementations if present.
       The loop itself does the durability work: yields tool-call boundaries, the engine checkpoints, the loop resumes with results.

  3. **Delete `src/ai/providers/` entirely** (or shrink it to interface types only). Provider transport belongs upstream — `armorer` for tool-call shape, `conversationalist` for message shape, possibly a new `providers` package if neither's quite right. Weft's agent loop accepts any structurally compatible provider; it doesn't ship one.

  4. **Rewrite the README's agent section** around the narrow pitch:

     > _Weft adds durability to your agent loop. Bring your provider (Anthropic SDK, `armorer`, whatever). Bring your tools (`armorer`, MCP server, plain functions). Weft drives the loop, checkpoints at every tool-call boundary, and survives crashes mid-conversation. Multi-agent coordination, handoffs, debates — all crash-resilient. Token counting, context strategies, budget enforcement, prompt caching are not Weft's concern; use the library that fits._

     Replace the current feature-list pitch (which competes with three categories of library at once) with the narrow positioning. The story becomes "what Weft uniquely does" rather than "every agent feature, also durably."

  5. **Update agent docs (`documentation/agents/*.md`)** to reflect the narrower scope:
     - Keep: agent overview (rewritten), durable coordination, agent declaration (now thin), tool effect log, human review, observability of the loop boundaries.
     - Remove or move: budget and cost docs (point at upstream), context window docs (point at `conversationalist`), model routing docs (point at upstream), provider health docs (point at upstream), prompt cache docs (point at `armorer`), streaming docs (point at upstream).
     - Add: a "what Weft owns vs. what upstream libraries own" page. Same instinct as the structural-compat item; explicit boundaries help users pick the right tool.

  6. **Update the Weft vs. Temporal table in the README.** Rows about agent features that are no longer Weft's concern get removed; rows about the durable agent loop and durable coordination get sharper.

  7. **Audit tests.** Tests for the deleted modules go away. Tests for the moved modules either move with them (if upstream library accepts the contribution) or get deleted (if the upstream owns its own tests). Tests for the kept modules stay.

  8. **Coordinate with upstream libraries** before deletion. If `armorer` doesn't yet have budget middleware, deleting Weft's budget code leaves users stranded. The cuts only happen _after_ upstream homes are confirmed (or the user can adopt a third-party library). For each "move" entry above:
     - Verify the upstream library has (or will have) the equivalent feature before Weft deletes it.
     - If upstream doesn't yet, file an issue / PR upstream first; let it land; then delete from Weft.
     - If upstream won't take it, decide: delete and let users handle it themselves, or keep in Weft as a documented exception.

  **Best practices the surgery must follow:**
  - **No "Weft re-exports the upstream library" shims.** Either Weft has a feature, or users import it from upstream directly. Re-export shims look free; they aren't. They obligate Weft to track upstream releases, mediate bugs, and preserve API compatibility for code that should just import upstream directly.
  - **Structural typing at the integration boundaries.** Weft's agent loop accepts a `LLMProvider`-shaped object, a `Tool`-shaped object, a `BudgetTracker`-shaped object — never specific upstream classes. Same pattern as the structural-compat work for `interoperability` types. Weft doesn't depend on `armorer`; it just accepts things that look like `armorer` outputs.
  - **No silent ergonomic regression.** A user who today writes `agent({ budget: { ... } })` and gets budget enforcement should still be able to. The replacement is `agent({ middleware: [armorerBudgetMiddleware({ ... })] })` — same outcome, different ownership. Document the migration explicitly in changelog and docs.
  - **Aggressive deletion, not soft deprecation.** Pre-release. Hard cut. If a feature moves upstream, the Weft version goes away in the same release.

  **Open design questions:**
  - **Where does each "moved" feature live?** Some have obvious homes (`token-counting` → `conversationalist`; `prompt-cache` → `armorer`). Some are genuinely uncertain (`model-router` could be standalone, could live in `armorer`, could live in a new `providers` package). Decide per-feature; don't force a single home for all of them.
  - **What about hooks that fire on durability boundaries?** If a hook is "before agent loop turn N starts," that's durability-shaped (the engine knows what turn it's on because it's checkpointing). If a hook is "before tool call X," that's `armorer`'s middleware territory. Draw the line carefully — and document where each hook fires.
  - **Multi-agent coordination's complexity boundary.** Handoff, supervision, debate are all "checkpoint-aware multi-agent state machines." But they're _also_ opinionated patterns — there's a real argument that `coordination` is closer to Agent Bureau's territory than Weft's. Split the difference: keep the durable primitive in Weft (the state machine, the checkpoint shape); move the _patterns_ (the specific debate / supervision / handoff implementations) upstream. Weft ships the framework; Agent Bureau ships the choreography.
  - **What does Weft actually ship for the agent loop?** Probably one named export — `executeAgentLoop` — that takes an options object with provider, tools, system prompt, max turns, optional middleware, optional `BudgetTracker`-shaped thing. Plus `agent()` (the unified-vocabulary helper, after the rename). Plus the multi-agent coordination primitives. That's it. The rest is `import { ... } from 'armorer'`, `import { ... } from 'conversationalist'`, or `import { ... } from 'agent-bureau'`.

  **Why this matters:**
  - **The current pitch is diluted.** Today's agent section reads like a feature checklist — every shape of agent concern listed, each with a one-line example. Compares poorly to focused libraries that own one concern each. After surgery, the pitch becomes "the durable agent loop, and only that." Stronger position.
  - **Maintenance burden gets right-sized.** Token counting tracks tokenizer changes; provider classes track SDK changes; context strategies track new compaction techniques. None of those are Weft's reason to exist; all of those drag Weft into release coordination it shouldn't be in.
  - **The architectural decisions you've already made line up.** Path A (Weft owns durable execution; richer semantics live upstream). The structural-compat type story (Weft owns narrow contracts; Agent Bureau extends). The Storage interface superset (Weft is the canonical contract; upstream consumes). The "library, not framework" placement of `armorer` and `conversationalist`. _Every_ prior decision pointed at this narrowing; we just hadn't applied it inside `src/ai/` yet.
  - **Users get a more honest tool.** A team evaluating Weft today reads the agent section and thinks "great, comprehensive agent runtime." Then they hit `armorer` and `conversationalist` and wonder why everything is duplicated three times. After surgery: "Weft for durable workflows and durable agent loops; `armorer` for tools; `conversationalist` for conversation state; Agent Bureau curates them together." Clear, predictable, no overlap.

  **Pairs with:**
  - **Agent Bureau Compatibility item** — same instinct (Weft narrow, upstream rich), applied internally to `src/ai/` instead of just at the type contracts.
  - **AI Providers section** — most of that section moves out of Weft. Mark as superseded.
  - **MCP Client rewrite** — superseded; the work moves to `armorer`.
  - **`agent()` helper rename** — accepts the narrower surface this item locks in.
  - **The README cleanup items** — same audit pass.

  **Out of scope:**
  - Performing the upstream contributions to `armorer` / `conversationalist`. That's upstream work; this item is the Weft-side surgery. The upstream additions are tracked as separate items (or filed against those projects directly, per the dependency-direction rule).
  - Re-implementing Agent Bureau's curation patterns (debate orchestration, supervision graphs) inside Weft. Those belong in Agent Bureau by the same logic that pulls budget/cache/routing out of Weft.
  - Removing durability primitives that _happen_ to be useful for agents. `SharedState`, `ctx.waitForSignal`, `ctx.run`, the workflow generator semantics — all stay. The line being drawn is "agent-shape features that don't need durability" not "anything an agent might use."

  **Sequencing:** Pre-1.0. Should land _before_:
  - The README rewrite (so the new pitch lands once, in its narrow form).
  - The unified-vocabulary `agent()` rename (so the renamed helper accepts the narrower surface from day one).
  - The MCP server item (so the server exposes only Weft's narrow workflow-as-tool shape, not the deleted client's bespoke shape).

  Should land _with_:
  - The Agent Bureau Compatibility item (same architectural instinct; both crystallize Weft's narrow boundary).
  - Upstream library coordination — as cuts in Weft, additions in `armorer` / `conversationalist`. Done as paired releases.

  Pre-1.0; this is the cut that makes Weft's agent story coherent.

## Documentation

- [ ] **Fix the Hello World example in `README.md` to tell the truth about recovery.**

  **Where:** `README.md` lines 36–60 (the "Hello, World" section), and almost certainly the same example duplicated at `documentation/getting-started/hello-world.md`.

  **The problem:** The current example does `engine.start('welcome', { name: 'Steve' })` followed immediately by `await handle.result()` in the same script, with prose underneath claiming that "if the process crashes after `greet` finishes but before the sleep expires, restarting the engine resumes from exactly that point." That claim is misleading as written — re-running the script does _not_ resume the previous workflow. Each `start()` call without an explicit `options.id` mints a fresh `crypto.randomUUID()` (see `src/core/engine.ts:2709-2713`), so a second run starts a brand-new workflow and the original is left orphaned in `weft.db` with nothing driving it.

  **What's actually required for recovery:**
  - A long-lived process owns the engine and calls `engine.recoverAll()` on boot (`src/core/engine.ts:5178`), which scans storage for `status === 'running'` workflows and calls `resume(id)` on each.
  - OR the caller passes a stable `options.id` (or `idempotencyKey`) so a re-run can `getHandle(id)` / `resume(id)` instead of starting fresh. A duplicate `start` with the same id throws `WorkflowAlreadyExistsError`.

  **What to change:**
  1. Rewrite Hello World so it either (a) shows a server-shaped example with `recoverAll()` on boot, or (b) passes a stable `options.id` and demonstrates the "re-attach vs. start" branch explicitly.
  2. Make the prose under the example honest: "the _engine_ can recover what it started; re-running this script with no stable id starts a new workflow." Don't let the reader infer that `engine.start(...)` magically knows it's the same workflow as last time.
  3. Audit adjacent docs that likely repeat the same shortcut: `documentation/getting-started/hello-world.md`, `documentation/getting-started/key-concepts.md`, the "Step API for async/await users" section in the README, and any quickstart in the dashboard.

  **Why this matters:** This is the first code most readers run. If the very first example sets a wrong mental model of how durability is achieved, every later concept (checkpoints, signals, recovery) lands on a shaky foundation. The whole pitch of Weft over Temporal hinges on the checkpoint model being legible — the intro example needs to model the real recovery contract, not gloss it.

  **Out of scope for this fix:** changing the engine API, changing default behavior of `start()`, adding new helpers. This is a docs-only change unless we discover the docs are papering over an actual UX gap (e.g., that `recoverAll()` should run automatically in some constructor mode) — in which case file a separate item.

- [ ] **Hello World implies activities are closures; reality is they're named, registered units.**

  **Where:** `README.md` lines 36–60 (Hello, World) and the parallel section at `documentation/getting-started/hello-world.md`. Likely repeated in `documentation/guides/activities.md` and the agent docs.

  **The problem:** The example writes `async function greet(name: string) {}` in the same module as the engine and passes it directly to `ctx.run(greet, user.name)`. That works only because everything is inline in one process. Under the hood (`src/core/context.ts:974-982`), `ctx.run` captures `fn.name` ("greet") and yields an operation keyed by that name. The engine resolves it via `#activityRegistry.resolve(operation.activityName)` (`src/core/engine.ts:6686`); on the remote path, only the _name_ + serialized args travel over the WebSocket, and a `RemoteWorker` registered with `activities: { greet: ... }` (`src/worker/index.ts:31`) executes the implementation. The closure-captured `fn` never runs in server/remote mode.

  So the introductory example trains the wrong mental model: it presents activities as "just functions you happen to call through a generator" when they're really _named_, _registered_ units that get dispatched by name. The "Remote Workers" section later in the README quietly contradicts this without flagging the contradiction, and a reader who scales from the quickstart to a real deployment hits a confusing surface.

  **What to change:**
  1. In Hello World, either (a) call `engine.registerActivity('greet', ...)` and have the workflow reference it by name, or (b) keep the closure form but add a one-line note: "this works because the workflow runs inline in this process; in server mode, activities are registered on a `RemoteWorker` and looked up by name — see [Remote Workers]." Option (a) is more honest; option (b) is less disruptive to the quickstart.
  2. In the Remote Workers section, show the _paired_ engine + worker shape end-to-end (engine file registers the workflow only; worker file registers the activity implementations) so the lookup-by-name story is visible.
  3. In `documentation/guides/activities.md`, lead with "activities are registered by name; `ctx.run` dispatches by name" before showing closure-style ergonomics. The closure form is a convenience, not the model.

  **Why this matters:** Same reason as the recovery item — first impressions set the mental model. If readers internalize "activity = local function I capture in a closure," every later concept (queues, remote workers, retries, interceptors) feels like a foreign overlay instead of a natural consequence of the registration model.

  **Out of scope:** changing `ctx.run`'s signature, deprecating closure-style invocation, or any engine-level work. Docs-only fix unless we decide the closure ergonomics are themselves a footgun worth removing — that's a separate, larger discussion.

- [ ] **Write a dedicated Service Worker guide.**

  **Where:** New file `documentation/guides/service-worker.md`. Cross-link from `documentation/architecture/browser-runtime.md` (which currently carries the only walkthrough), `documentation/guides/server.md` (which mentions the module in passing at line 206), and the README.

  **The problem:** Weft's Service Worker support is a load-bearing differentiator — _"Runs in the browser"_ and _"Runs in Web Workers as its persistence backbone"_ are explicit pitches in the README. But there is no dedicated guide. The existing coverage is fragments scattered across `documentation/architecture/browser-runtime.md` and `documentation/guides/server.md`, neither of which is the canonical "how do I use Weft in a Service Worker" page. A reader wanting to ship Weft inside an offline-first PWA has to piece the story together from architectural docs and adjacent guides.

  **What the guide must cover:**
  1. **Conceptual model.** Why a Service Worker is a natural home for Weft (durable persistence backbone over IndexedDB, background timer wakeup via Periodic Background Sync, intercepts `fetch` for the engine's HTTP surface). Lead with the mental model — what's running where, why, and what the lifecycle is.
  2. **Quickstart.** The new `setupServiceWorker()` helper (after the API Ergonomics item lands) as the recommended path — six lines. The lower-level helpers as the escape hatch.
  3. **Registration.** How to register the Service Worker file from the main thread (`navigator.serviceWorker.register('/sw.js')`), how to register workflows inside the worker, how to communicate with the engine from page code via the engine's HTTP surface.
  4. **Periodic Background Sync.** What it is (Chrome, Edge, Opera; not Firefox, not Safari at time of writing — verify), how to register the sync tag, why it's the foundation of background timer wakeup. Document the fallback story: when Periodic Background Sync is unavailable, the scheduler falls back to `setTimeout`-based polling that only works while a tab is open.
  5. **Limitations and gotchas.**
     - Service Workers can be terminated at any time after ~30s idle (per the spec). Workflows must tolerate this — fortunately, Weft's checkpoint model already does.
     - IndexedDB quota considerations.
     - The "first install" lifecycle race — what happens when the SW updates while workflows are running.
     - HTTPS requirement (Service Workers require secure contexts; localhost is exempt).
     - Cross-origin / scope considerations — the Service Worker's scope determines which fetches it can intercept.
  6. **Path prefix and the engine's HTTP surface.** How `pathPrefix` (default `/weft/`) routes browser-page requests through the engine. The browser app's HTTP client talks to `fetch('/weft/v1/workflows/start', ...)` — same JSON-RPC / REST API the server exposes, intercepted client-side by the SW.
  7. **Browser support matrix.** Which browsers support what (Service Workers, IndexedDB, Periodic Background Sync, BroadcastChannel for cross-tab coordination). What degrades gracefully and what doesn't.
  8. **Debugging.** How to inspect IndexedDB via DevTools (Application tab → IndexedDB), how to force a Service Worker update (Application → Service Workers → Update on reload), how to clear the storage to start fresh.
  9. **Pairing with PWAs.** How Weft fits into a Progressive Web App story — durable workflows that survive offline + tab close + browser restart, syncing back when the app comes online.
  10. **Common pitfalls.** First Service Worker install vs. activation timing, the "but my workflow isn't resuming!" debug story (almost always Periodic Background Sync not registered or not supported), the "Service Worker keeps reloading" failure mode (usually a hot-reload tooling issue), cross-tab state coordination via `BroadcastChannel`.

  **Cross-references the guide should establish:**
  - `documentation/architecture/browser-runtime.md` — the architectural overview. Keep the architectural framing there; move the _how-to_ content to the new guide.
  - `documentation/architecture/web-workers.md` — for the Web Worker (non-Service-Worker) story.
  - `documentation/guides/server.md` — for the Bun/Node server-side story. Cross-reference shows the parallel.
  - `documentation/getting-started/installation.md` — add a "for Service Worker setups" link.

  **Why this matters:**
  - **Service Worker support is a _unique_ feature** in the durable-execution space. Temporal can't run in a Service Worker. Inngest can't. The fact that Weft can is genuinely differentiated, and the docs should make that easy to discover and adopt.
  - **PWAs are an underserved use case** for durable execution. A team building an offline-first app today either hand-rolls IndexedDB-backed workflow state or does without. Weft's Service Worker support is the answer; a dedicated guide is how prospective users find it.
  - **First-class doc placement signals first-class support.** The current "scattered fragments" placement reads as "Weft sort of works in Service Workers if you piece it together." A dedicated guide reads as "Weft is built for this."

  **Pairs with:**
  - **`setupServiceWorker()` helper item** in API Ergonomics — same audience, same setup story; the doc leads with the new helper.
  - **Auto-detected storage item** — together they collapse Service Worker setup to its irreducible minimum.
  - **The Hello World docs cleanup items** — same audit pass; same "first-impression matters" instinct.

  **Out of scope:**
  - General Service Worker tutorials (caching strategies, push notifications, background fetch). Link to MDN; don't reimplement.
  - PWA build tooling (Workbox, vite-plugin-pwa, etc.). Different concern; mention in passing as the integration point.
  - The Web Workers (non-Service-Worker) story — separate doc.

## Type Generation

- [ ] **Expose JSON Schema registries from the server, then ship a static-generation tool that emits a `.d.ts` for IntelliSense on workflow + activity names.**

  **The vision:** A client developer points a CLI at a running Weft server (or a config file referencing one), the tool pulls down JSON Schema for every registered workflow and activity, and writes a `.d.ts` that augments the `weft` module so `ctx.run('...')` and `engine.start('...')` autocomplete the _real_ names available on that server, with input/output types checked at compile time. Same shape as `openapi-typescript`, `drizzle-kit`, `prisma generate`, or tRPC's inferred client — codegen sidesteps the cross-process inference problem entirely.

  **What already exists (the foundation is partly there):**
  - The JSON-RPC server already emits an OpenRPC document with JSON Schema for _server operations_ (`startWorkflow`, etc.) — see `src/server/openrpc.ts` (uses `zod-to-json-schema`).
  - `Engine<TRegistry>` and `WorkflowRegistry` exist for in-process typing (`src/core/types.ts:1321-1355`). That's the type that codegen should produce for an external consumer.
  - There's an OpenAPI generator alongside the OpenRPC one (`src/server/openapi.ts`).

  **What's missing — three layers:**
  1. **Per-workflow + per-activity input/output schemas at registration time.** Tracked separately under the **Unified Operation Catalog** section ("Unify `WorkflowRegistration` and `ActivityRegistrationOptions` with the `OperationDefinition` shape"). The right architecture is to make workflows and activities catalog citizens with the same shape as server operations — that gives schemas, transport availability, access policies, and a uniform introspection API in one move.
  2. **A discovery endpoint on the server.** Something like `GET /v1/registry` (or a JSON-RPC method) that returns `{ workflows: { name: { input, output, ... } }, activities: { name: { input, output, queue, ... } } }` as JSON Schema. Reuse the same Zod-to-JSON-Schema path the OpenRPC generator already uses. Decide whether this is on by default, gated behind a config flag, or only exposed under an authenticated scope (probably gated — schemas leak internal data shapes).
  3. **A codegen CLI** (`bunx weft codegen --server https://... --out src/weft.generated.d.ts`) that fetches the registry document and emits a `.d.ts`. The generated file uses module augmentation to extend `WorkflowRegistry` and adds an `ActivityRegistry` interface (or whatever shape ends up in the typed-`ctx.run` companion item below). Auth is via the same token mechanism the JSON-RPC client uses.

  **Why this is the right shape:**
  - **Decouples build-time types from runtime topology.** The workflow author's repo doesn't need to import the worker's repo or vice versa; both consume the generated `.d.ts`.
  - **Survives polyglot clients.** Same registry document can drive a Python or Go client SDK, not just TypeScript. JSON Schema is the lingua franca.
  - **Composable with the OpenRPC work already in flight.** This is _additive_ — `x-weft-workflowRegistry` and `x-weft-activityRegistry` extensions on the existing OpenRPC doc would let one endpoint serve both purposes.
  - **Pairs naturally with the activities-are-named-units docs item.** Once readers internalize the registration model, "you can codegen types from the registry" becomes the obvious next step rather than an esoteric add-on.

  **Open questions to resolve before implementation:**
  - Schema validation library: stick with Zod (project already uses it heavily) or accept any standard-schema-compliant validator? Probably the latter — Standard Schema is becoming the cross-validator interop format.
  - Do schemas opt-in (`registerActivity('foo', fn, { input: ZodSchema })`) or get inferred from TypeScript types via a separate `defineActivity()` helper? Opt-in is simpler; inference is nicer ergonomics but couples codegen to the TS compiler API.
  - Should the registry endpoint stream changes (workflows registered/unregistered at runtime) or be a snapshot? Snapshot is fine for v1 — codegen is a build step, not a live reflection.
  - How do remote workers contribute their activity schemas? The worker-registration message (`src/worker/index.ts:137`) already sends activity _names_ on connect; extend it to send schemas, and have the server union them into the registry document.

  **Out of scope for v1:**
  - Live type updates / hot-reloading. Codegen runs at build time, period.
  - Generating client _implementations_ (a la tRPC's typed proxy). Just types, then `engine.start(name, ...)` / `ctx.run(name, ...)` get IntelliSense via the existing API.
  - Cross-language client SDKs. JSON Schema makes them possible, but shipping them is a separate effort.

  **Sequencing:** This is gated by the typed-`ctx.run` companion item (whichever of options 2/3 we pick from the previous discussion) — without a way to _consume_ an activity registry type, generating one has nowhere to plug in. Sequence: (a) decide on the typed-`ctx.run` shape, (b) add `inputSchema`/`outputSchema` to registration options, (c) ship the discovery endpoint, (d) ship the codegen CLI.

- [ ] **Add typed `ctx.run` and `engine.start` via a module-augmentation activity registry.**

  **Where:** `src/core/context.ts:942` (`ctx.run`), `src/core/engine.ts` (`start`/`registerActivity` typings), and `src/core/types.ts` (where `WorkflowRegistry` already lives).

  **The problem:** `ctx.run<TResult>(fn, ...rest)` accepts `(...args: unknown[]) => Promise<TResult>` and infers nothing about the activity name or argument types. There's no way for IntelliSense to know which activities are registered or whether the args match the implementation. `Engine<TRegistry>` solves the same problem for `engine.start` already (workflows are typed via the registry generic) — activities deserve parity.

  **Approach (preferred): module-augmentation registry, mirroring `WorkflowRegistry`.**

  ```ts
  // user code, declared once per project
  declare module 'weft' {
    interface ActivityRegistry {
      greet: (name: string) => Promise<string>;
      sendEmail: (to: string, subject: string) => Promise<{ id: string }>;
    }
  }

  // ctx.run gets a string-name overload that consults the registry
  yield * ctx.run('greet', 'Steve'); // ✓ args + return typed
  yield * ctx.run('greet', 42); // ✗ type error
  yield * ctx.run('sned', 'Steve'); // ✗ no such activity
  yield * ctx.run(greet, 'Steve'); // ✓ closure form still works (existing API)
  ```

  Pros: zero runtime change, additive at the type level, drop-in for existing closure-style code, matches the pattern users already know from Hono / tRPC / Drizzle. Cons: requires a global `declare module` block, which is awkward for libraries that ship activities for consumers to register.

  **Alternative considered:** a `defineActivity()` builder that returns a typed handle (`activities.greet`) instead of relying on `fn.name`. Cleaner inference, but a bigger calling-convention shift — defer to the broader API-v2 conversation.

  **Why this matters:** Activity names are the contract between workflow authors and worker authors. Today the contract is enforced only at runtime ("no activity registered with name 'greet'" — boom, in production). Lifting it to compile time eliminates a whole class of typo/rename bugs and makes refactoring across worker boundaries safe.

  **Companion to:** the JSON Schema registry / codegen item above. Codegen _produces_ the `ActivityRegistry` augmentation; a typed `ctx.run` _consumes_ it. Each is useful alone — both together close the loop.

  **Out of scope:** removing the closure-style overload, deprecating `fn.name`-based dispatch, or any change to how `RemoteWorker` registers activities at runtime.

## Unified Operation Catalog (Architectural Foundation)

**Context:** Weft already has a transport-neutral operation catalog (`src/server/operation-catalog.ts`) — `OperationDefinition<Input, Output>` carries name + summary + `inputSchema` (Zod) + `outputSchema` (Zod) + `access` policy + `transports: { http, jsonRpcHttp, jsonRpcWebSocket, jsonRpcStdio }` + `unknownKeyPolicy` + `authorize` hook + `invoke`. **`executeOperation`** (line 313 of that file) is the single dispatch entry point for every transport: REST, JSON-RPC HTTP, JSON-RPC WebSocket, and stdio JSON-RPC. The module's own doc says _"drift between transports is impossible because there is only one path."_ OpenAPI and OpenRPC documents both derive from this registry; a `track8-discovery-parity.test.ts` enforces no drift.

This is the architecture you'd want. The roadmap items in this section make it _complete_: extending coverage to the transports and operation kinds that don't fully participate yet, and unifying workflow/activity registration onto the same shape so codegen, MCP tools, AsyncAPI, and OpenAPI bodies all derive from one source of truth.

- [ ] **Unify `WorkflowRegistration` and `ActivityRegistrationOptions` with the `OperationDefinition` shape.**

  **Where:** `src/core/types.ts:1321` (`WorkflowRegistration`), `src/core/activity-registry.ts:62` (`ActivityRegistrationOptions`), `src/server/operation-catalog.ts:113` (`OperationDefinition`), `src/server/operation-registry.ts` (`defineOperation` builder).

  **The problem:** Server operations (`weft.workflows.start`, `weft.workflows.signal`, etc.) live in a beautiful catalog with schemas, transport availability, access policies, and a single dispatch pipeline. Workflows and activities — the _business_ logic the engine runs — register through `engine.register()` / `engine.registerActivity()` with a separate, less-structured shape. They have no `inputSchema` / `outputSchema`, no transport-availability flags, no introspection surface. This is the root cause of the codegen gap, the MCP-tool gap, the AsyncAPI per-workflow-payload gap, and the OpenAPI request-body stubs. One missing abstraction is creating downstream gaps in five different places.

  **What to change:**
  1. Promote workflows and activities to first-class catalog citizens. Either (a) make them `OperationDefinition`s in the same registry, or (b) introduce a sibling catalog with the same shape (`WorkflowDefinition`, `ActivityDefinition`) and a shared base type. Lean toward (b) — they're conceptually different (operations are stateless RPCs; workflows are stateful long-running) and forcing them into one type creates a too-wide union. Common base: name, summary, schemas, access policy, introspection surface.
  2. Add `defineWorkflow` / `defineActivity` builders that mirror `defineOperation`'s ergonomics.
  3. Replace `engine.register()` / `engine.registerActivity()` with handlers that take the new definition shape. No closure-style fallback — pre-release, hard rename.
  4. Surface a uniform introspection API: `engine.describeWorkflow(name)`, `engine.describeActivity(name)`, `engine.listWorkflows()`, `engine.listActivities()` — returns the definition with `inputSchema`/`outputSchema` as JSON Schema (via `zod-to-json-schema` if Zod, via Standard Schema otherwise).
  5. Validate on dispatch: workflow input on `engine.start()`, activity input/output at `ctx.run` boundaries. Validation is on by default — schemas are mandatory once the catalog citizens land.

  **Open questions:** Standard Schema (cross-validator interop) vs. Zod-only (matches existing codebase). Probably Standard Schema — keeps the door open for users who don't want Zod. Opt-in schemas in v1, then ratchet to "schemas required for MCP-exposed workflows" once the MCP server lands.

  **Why this matters:** Single change unlocks five downstream items:
  - **Codegen** has something to read.
  - **MCP server** can expose typed tools.
  - **AsyncAPI** can describe per-workflow event payloads.
  - **OpenAPI** can fill in workflow-start request body schemas (today they're `type: object` stubs).
  - **Type-safe `ctx.run` and `engine.start`** have a runtime catalog matching the type-level `WorkflowRegistry` / `ActivityRegistry`.

  **Out of scope:** changing how the engine actually executes workflows/activities — the registration shape changes, the runtime doesn't.

- [ ] **Audit `executeOperation` coverage: every transport must route through it, or document why not.**

  **Where:** Trace every public-facing entry point that accepts a request and produces a response.

  **The problem:** The catalog claims "drift between transports is impossible because there is only one path." That's true for the four transports the catalog currently knows about (REST, JSON-RPC HTTP, JSON-RPC WebSocket, stdio JSON-RPC). It's _not_ true for transports that bypass the catalog — and a few do. We need to enumerate them, and either route them through `executeOperation` or document the exemption explicitly.

  **What to audit:**
  1. **MCP transports** (`src/ai/mcp/transport-*.ts`) — currently bypass the catalog entirely. The MCP-server item in the next section needs to land via `executeOperation` (or via a thin MCP-specific shim that calls into it), not via a parallel pipeline.
  2. **SSE workflow stream** (`src/server/operations/stream-workflow-sse.ts`) — verify whether it goes through `executeOperation` or has its own path. Streaming responses don't fit the unary input → output shape the catalog assumes; if it bypasses, that's an architecture gap (see next item).
  3. **WebSocket subscriptions** (`weft.workflows.subscribe`, `unsubscribe` in `src/server/json-rpc-websocket.ts`) — same question. Subscriptions are bidirectional / long-lived; how do they participate in the catalog's request/response pipeline?
  4. **Engine-level event feed** (`src/server/engine-event-feed-backend.ts`) — internal, but if the dashboard or any external client reads it, it's a transport surface.
  5. **Anything in `src/dashboard/`** that talks to the engine directly — bypassing the catalog means bypassing access policies and validation. Dashboard requests should look like every other request to the operation pipeline.

  **What to change after the audit:**
  - For each transport that bypasses: route through `executeOperation`, or add a documented exemption with a justification (and a test that says "this is intentionally outside the catalog").
  - Add a coverage test: enumerate transport entry points (e.g., via a registry of `TransportAdapter` implementations) and assert each one calls `executeOperation`.

  **Why this matters:** The catalog's safety property — single access check, single validation, single error classifier — only holds if every transport actually uses it. Bypasses are silent invariant violations: a request that comes in through a side door doesn't get the same authorization checks. This audit is also a prerequisite for trusting that the AsyncAPI / MCP / future-transport work doesn't reintroduce drift.

  **Out of scope:** rewriting the transports themselves. This is a coverage audit and (where needed) a routing fix — it's not a redesign.

- [ ] **Add a first-class abstraction for streaming / subscription operations in the catalog.**

  **Where:** `src/server/operation-catalog.ts` — `OperationDefinition` is unary (`invoke: (ctx) => Promise<Output>`). New: a sibling shape for stream/subscription operations.

  **The problem:** WebSocket subscriptions and SSE streams are first-class transport surfaces, but the catalog's `OperationDefinition` is built for unary request/response. Streams either bypass the catalog (bad — see audit item above) or shoehorn into it (worse — `invoke` returning a long-lived async iterator misuses the abstraction). AsyncAPI, MCP `resources/subscribe`, and any future server-push transport all need a real abstraction here.

  **What to change:**
  1. Introduce `OperationKind: 'unary' | 'stream' | 'subscription'` (or three sibling builders: `defineOperation`, `defineStreamOperation`, `defineSubscription`).
  2. Stream/subscription operations declare an `eventSchema` (the message payload) in addition to `inputSchema` (the subscribe request) and `outputSchema` (the subscribe response).
  3. `executeOperation` stays unary; add `executeStream` / `executeSubscription` that share the same access / validation / authorize / classify pipeline but produce an async iterator or subscription handle.
  4. AsyncAPI generator (separate item) reads stream/subscription operations and produces channel descriptions.
  5. MCP server (separate item) maps `subscription` operations to MCP `resources/subscribe` semantics.

  **Why this matters:** Without this, the AsyncAPI, MCP-resources, and any future server-push work either reintroduce parallel pipelines or fight the abstraction. Defining the shape now means every streaming-capable transport derives from one source of truth.

  **Out of scope:** rewriting existing subscription/SSE implementations — this is the abstraction they should _eventually_ migrate to. Migration is a follow-up.

## Transport Schemas and Discovery

The OpenAPI 3.1 document at `GET /openapi.json` and OpenRPC 1.3.2 document at `GET /openrpc.json` (plus the `rpc.discover` method) are good bones — single source of truth in `src/server/route-model.ts`, transport-aware filtering, drift-prevention tests in `track8-discovery-parity.test.ts`. The items below extend this story to per-workflow / per-activity payloads, streaming transports (AsyncAPI), error catalogs, and well-known discovery. They depend on the **Unified Operation Catalog** items above — once workflows and activities are catalog citizens with schemas, every generator below derives from them mechanically.

- [ ] **Hydrate OpenAPI request/response bodies with real schemas instead of stubs.**

  **Where:** `src/server/openapi.ts:90, 99, 125` — every body-accepting route emits `requestBody: { content: { 'application/json': { schema: { type: 'object' } } } }` and every response emits `responses: { '200': { description: 'Successful response' } }`. The actual operation schemas are already known to the system (the OpenRPC generator pulls them via `zod-to-json-schema` from `operation.inputSchema` / `operation.outputSchema` — see `src/server/openrpc.ts:142-144`).

  **The problem:** The OpenAPI document is a directory, not a contract. Code generators (`openapi-typescript`, `openapi-generator-cli`) emit useless `Record<string, unknown>` types from it. Hosted doc tools (Stoplight, Redoc, Swagger UI) can't show example payloads. Error responses (4xx, 5xx) aren't documented at all — only `200`.

  **What to change:**
  1. In `emitBindings` and `emitRoutes`, look up the operation in the `OperationRegistry` and reuse its `inputSchema` / `outputSchema` to populate `requestBody.content['application/json'].schema` and `responses['200'].content['application/json'].schema`.
  2. Promote shared schemas to `components.schemas` and `$ref` them from path items so the document deduplicates.
  3. Document error responses from the fault-code catalog (`src/server/fault-to-json-rpc.ts`) — at minimum `400`, `401`, `403`, `404`, `409`, `429`, `500` with a shared `Error` schema.
  4. Add `examples` per operation (one valid request, one error) — pulled from the same fixtures the OpenRPC generator could use.

  **Why this matters:** This is the _cheapest_ unlock in the set — the schemas already exist and are already serialized for OpenRPC. Plumbing them into OpenAPI is mechanical work with high payoff for client codegen.

  **Out of scope:** changing the route model, restructuring how operations register schemas. Pure consumption of what's already there.

- [ ] **Generate an AsyncAPI 3.0 document at `/asyncapi.json` for WebSocket and SSE traffic.**

  **Where:** New file (`src/server/asyncapi.ts`), new route in `src/server/route-model.ts`. Catalogs the WebSocket subscription methods (`weft.workflows.subscribe` / `unsubscribe` — see `src/server/json-rpc-websocket.ts:100`) and the SSE endpoint (`src/server/operations/stream-workflow-sse.ts`).

  **The problem:** Subscription-shaped traffic is invisible to schema consumers. There's no machine-readable description of what events `weft.workflows.subscribe` emits, what shape an SSE event has, or what the WebSocket reconnect/replay protocol looks like. AsyncAPI 3.0 is the industry standard for this; without it, codegen tools can't produce typed event handlers and hosted doc tools can't render the streaming surface.

  **What to change:**
  1. New `generateAsyncApiDocument()` driven from the same `OperationRegistry` the OpenRPC generator consumes, plus a small "channels" model alongside `ROUTES`.
  2. Channels: one per WebSocket subscription topic, one per SSE event type. Each channel declares its message payload as JSON Schema (sourced from the per-workflow `outputSchema` once the foundation item lands).
  3. Document the WebSocket lifecycle: register, subscribe, heartbeat, unsubscribe, reconnect-with-cursor (the engine-event-feed already has cursor semantics — see `engine-event-feed-backend.ts`).
  4. Public path by default, same as `/openapi.json` and `/openrpc.json`. Add to `DEFAULT_PUBLIC_PATHS` in `src/server/authentication.ts:307`.
  5. Drift-prevention test mirroring `track8-discovery-parity.test.ts` — every WebSocket method that exists at runtime must appear in AsyncAPI.

  **Why this matters:** A "real-time durable execution engine" without an AsyncAPI doc is selling a streaming product without a streaming contract. This is the single biggest catalog gap.

  **Out of scope:** changing the WebSocket protocol itself, redesigning subscription semantics. Documentation-of-existing-behavior only.

- [ ] **Add `/.well-known/api-catalog` per RFC 9727 to advertise all schema documents from one entry point.**

  **Where:** New route in `src/server/route-model.ts`, served as a static JSON document referencing every catalog the server exposes (`/openapi.json`, `/openrpc.json`, `/asyncapi.json`, MCP descriptor).

  **The problem:** A client today has to _know_ the well-known paths to fetch each document. There's no single discovery URL that says "here's everything this server publishes." RFC 9727 (api-catalog) is the standard answer.

  **What to change:**
  1. Add `GET /.well-known/api-catalog` returning a `linkset` document per the RFC, with `service-desc` links to each schema document and appropriate media types.
  2. Public path by default.
  3. Add a corresponding test that the catalog references every schema document the server actually exposes (drift prevention, same shape as `track8-discovery-parity.test.ts`).

  **Why this matters:** Cheap, additive, and it makes the catalog story symmetric with how clients discover documents in standards-compliant APIs (OAuth, OpenID Connect, RFC 9727 itself). No code generator should ever have to guess paths.

  **Out of scope:** any redesign of the existing catalog endpoints — this _links_ to them, doesn't replace them.

- [ ] **Document JSON-RPC error codes via OpenRPC `components.errors`.**

  **Where:** `src/server/openrpc.ts` (the document generator) and `src/server/fault-to-json-rpc.ts` (the existing fault taxonomy).

  **The problem:** OpenRPC supports a top-level `components.errors` map declaring `{ code, message, data }` schemas, plus per-method `errors` arrays referencing them. The codebase clearly _has_ a fault-code taxonomy (the assertion `assertIdenticalFaultCode` in `track8-parity-invariants.ts:57` proves it), but the OpenRPC document doesn't surface it. Clients can't discover what errors a method might return — they have to read source code or hit them in production.

  **What to change:**
  1. Audit `fault-to-json-rpc.ts` for the canonical fault-code list. Capture each as `{ code, message, data: <schema> }` in `components.errors` of the OpenRPC document.
  2. Per-operation, declare which errors that operation can produce (via `operation.errors: string[]` in the `OperationRegistry` or by reusing existing fault declarations).
  3. Test invariant: every error code thrown in the codebase must be declared in `components.errors`, and every method that throws a code must list it in its `errors` array.

  **Why this matters:** This is the difference between an OpenRPC document that lists endpoints and one that's a complete contract. Clients (especially in strongly-typed languages like Go and Rust) can't generate exhaustive error matching without it. It also forces fault-code hygiene — adding a new code without declaring it becomes a test failure.

  **Out of scope:** redesigning the fault-code taxonomy; changing how errors propagate at runtime. Pure documentation extraction.

- [ ] **Fill in `info.description`, `info.contact`, `info.license`, `externalDocs`, and per-operation `examples` for OpenAPI and OpenRPC.**

  **Where:** `src/server/openapi.ts:174` and `src/server/openrpc.ts:88` — the `info` blocks today have only `title` and `version`.

  **The problem:** Cosmetic but real. SDK generators and hosted doc tools (Redoc, Stoplight, Mintlify) lean on these fields for landing pages, terms-of-service links, contact info, and "try it out" examples. The current documents render as bare skeletons in those tools.

  **What to change:**
  1. Add `info.description`, `info.contact: { name, url, email }`, `info.license: { name: 'MIT', url }`, and `externalDocs: { url: '<link to documentation/>' }`.
  2. Per-operation, add at least one `examples` entry (request + response). Source from existing test fixtures where possible.
  3. Make these configurable via `serve()` options so operators can override them for their deployment.

  **Why this matters:** Lowest-priority item in this set, but trivially cheap and immediately visible to anyone who points a doc tool at the server. Ship after the substantive items above.

  **Out of scope:** anything beyond filling in standard metadata fields.

**Sequencing for this section:**

Foundation items (Unified Operation Catalog section) come first — every item below derives from them.

1. Hydrate OpenAPI bodies (cheap unlock; depends on workflows being catalog citizens)
2. AsyncAPI 3.0 (biggest catalog gap; depends on the streaming-operation abstraction)
3. Error catalog in OpenRPC (forces fault-code hygiene; independent of foundation work)
4. `/.well-known/api-catalog` (additive, makes everything discoverable; independent)
5. MCP descriptor (deferred — see MCP Server Support section; can't catalog what doesn't exist)
6. `info` polish (cosmetic, last)

## MCP Server Support

Per the AI Surface Shrinkage decision, Weft does **not** ship an MCP client — `armorer` owns MCP-as-tool-source. But Weft's _workflow_ surface is a separate concern: there's value in exposing Weft workflows themselves as MCP tools/resources to external MCP clients (Claude Desktop, Cursor, the Anthropic SDK, etc.). That's the server side — distinct from the client side, and genuinely Weft's job since it requires Weft's durability and registry awareness.

A durable execution engine that _runs_ AI agents but can't _be consumed by_ AI agents leaves a major integration story on the table — every Claude Desktop user, every Cursor user, every MCP-aware client would need a custom integration to drive Weft workflows.

- [ ] **Implement an MCP server that exposes Weft as a first-class MCP service — usable both as a remote HTTP server and as a local stdio server installable via `npx`.**

  **Where:** New module `src/ai/mcp/server/` (alongside the client; share the spec types and lifecycle state machine that come out of the client rewrite). Two entry points:
  - `weft serve --mcp` (or `serve({ mcp: true })`) — exposes MCP alongside HTTP / WebSocket / JSON-RPC on the same long-lived server process.
  - A standalone `weft-mcp` binary published to npm so users (and Claude Desktop, Cursor, etc.) can run it as `npx weft-mcp` over stdio without installing Weft globally.

  **Two deployment shapes — both are first-class:**
  1. **Remote MCP server (HTTP).** A long-lived Weft server adds an MCP endpoint to its existing transport surface. Uses **Streamable HTTP** (2025-03-26+ spec) as the primary transport — single endpoint accepting both POST (client→server requests) and GET (server→client SSE stream), with session resumption via the `Mcp-Session-Id` header. This is the production deployment: Weft is already running as a server, MCP is just another protocol it speaks. Multi-tenant, OAuth-authenticated, scaled the same way the rest of the server scales. Connection URL goes in Claude Desktop / Cursor config like any other remote MCP server.

  2. **Local stdio server via `npx weft-mcp`.** A standalone binary, published as its own npm package (`weft-mcp` or `@weft/mcp` — pick one), that users add to their MCP client config:

     ```json
     {
       "mcpServers": {
         "weft": {
           "command": "npx",
           "args": ["-y", "weft-mcp", "--db", "./weft.db"]
         }
       }
     }
     ```

     The binary spawns, opens a local SQLite-backed engine (or connects to a remote Weft server via `--server` flag — see below), speaks MCP over stdin/stdout per spec, and exits cleanly when the parent closes stdin. This is the Claude Desktop / Cursor / local-dev shape — zero install friction, no server to run, just `npx`.

     The stdio binary supports two modes:
     - **Embedded mode** (`--db ./weft.db`): runs an in-process engine against a local SQLite file. Good for "personal workflows" and dev. No auth — the local user's filesystem permissions are the trust boundary.
     - **Proxy mode** (`--server https://weft.internal:7233 --token $WEFT_TOKEN`): forwards every MCP request to a remote Weft server's MCP endpoint. Lets users put a Weft server behind their MCP client without exposing the server URL or token in the client config — `npx weft-mcp` becomes the local credential holder. Good for hosted Weft deployments where the actual engine runs elsewhere.

  **What "MCP server" means concretely (per the 2025-06-18 spec):**
  1. **Lifecycle:** handle `initialize` request with `protocolVersion`, `capabilities`, and `serverInfo`; respond with negotiated capabilities; receive `notifications/initialized` to mark ready. Reject all other methods until ready.
  2. **Capabilities to declare:**
     - `tools` with `listChanged: true` (tool set is dynamic — users register workflows at runtime).
     - `resources` with `subscribe: true` and `listChanged: true` (workflow state changes; consumers want to subscribe).
     - `prompts` (optional v1 — canned workflow-launching prompts).
     - `logging` (forward engine events as MCP logs at the negotiated level).
  3. **Tools surface:** every registered workflow becomes an MCP tool whose `inputSchema` is the workflow's `inputSchema` (foundation item from the Transport Schemas section). Plus engine-control tools: `start_workflow`, `signal_workflow`, `update_workflow`, `query_workflow`, `cancel_workflow`, `list_workflows`, `get_workflow_state`. Per-workflow tools are named `start_<workflow_name>` (lowercase, underscores) so MCP clients render them as discrete actions.
  4. **Resources surface:** read-only views — workflow state by ID, checkpoint history, event log, search-attribute query results. URIs like `weft://workflow/<id>/state`, `weft://workflow/<id>/checkpoints/<step>`, `weft://workflows?status=running`. Subscribable so resource changes push `notifications/resources/updated` to clients (natural fit — the engine already has an event-feed backend).
  5. **Methods to handle:** `initialize`, `notifications/initialized`, `notifications/cancelled`, `tools/list`, `tools/call`, `resources/list`, `resources/read`, `resources/subscribe`, `resources/unsubscribe`, `resources/templates/list`, `prompts/list`, `prompts/get`, `logging/setLevel`, `ping`, `completion/complete` (for argument autocompletion in clients that support it). Outbound: `notifications/tools/list_changed`, `notifications/resources/list_changed`, `notifications/resources/updated`, `notifications/progress`, `notifications/message` (logs).
  6. **Authentication:**
     - **Remote (Streamable HTTP):** OAuth 2.1 with PKCE per MCP spec. The codebase already has `src/ai/mcp/oauth2-token-manager.ts` on the client side; server needs the authorization-server half. Reuse `src/server/authentication.ts` and `src/server/authorization-scope.ts` infrastructure.
     - **Local stdio (`npx weft-mcp`):** no auth on the wire — stdio means the parent process is already inside the trust boundary. Embedded mode trusts the local user; proxy mode holds the upstream token via `--token` or `WEFT_TOKEN` env var.
  7. **Transports the server speaks:**
     - **Streamable HTTP** (primary remote) — 2025-03-26+ spec, single endpoint.
     - **stdio** (primary local) — newline-delimited JSON-RPC 2.0 over stdin/stdout.
     - **Legacy HTTP+SSE** — only if compat with older clients matters. Decide based on what Claude Desktop and Cursor support at implementation time.

  **Best practices the implementation must follow:**
  - **Tool input schemas are JSON Schema, not Zod-specific.** Convert via `zod-to-json-schema` (already in use in `src/server/openrpc.ts`).
  - **Tool names follow MCP convention:** lowercase with underscores, descriptive (`start_checkout_workflow`, not `startCheckoutWorkflow` or `swc`).
  - **Tool descriptions are user-facing.** They show up in Claude Desktop's UI. Sourced from workflow registration metadata — add a `description?: string` field to `WorkflowRegistration`.
  - **Errors use MCP error codes** (`-32600` invalid request, `-32601` method not found, `-32602` invalid params, `-32603` internal error, plus MCP-specific codes for tool execution failures). `tools/call` errors return `isError: true` with a `content` block, _not_ a JSON-RPC error — the spec distinguishes "the call failed" (isError) from "the request was malformed" (JSON-RPC error).
  - **Long-running tool calls support cancellation** via `notifications/cancelled` — natural fit since workflows already support `engine.cancel(id)`. The server cancels the workflow when it receives the notification.
  - **Long-running tool calls emit progress** via `notifications/progress` with the `_meta.progressToken` from the original request — natural fit since workflows emit checkpoints and events.
  - **Resource subscriptions emit `notifications/resources/updated`** when workflow state changes. Use the existing event-feed backend; don't poll.
  - **Capability negotiation is honored:** if a client doesn't declare `roots` capability, the server must not assume root-listing support.
  - **Multiple `protocolVersion` values supported gracefully;** reject unsupported ones with a clear error during `initialize`.
  - **Pagination from day one.** `tools/list` and `resources/list` support cursor-based pagination per spec. Realistic deployments will have hundreds of workflows.
  - **Conformance testing:** stand up the MCP reference server's _test client_ (or use Claude Desktop in CI) and run end-to-end tests against both transports. This is the canary for spec drift.

  **Architectural questions to resolve before implementation:**
  - **Engine ownership:** in-process MCP server (simplest, matches inline activity execution) vs. separate process talking to the engine over WebSocket (matches remote workers). Answer: both. The remote shape uses in-process; the `npx weft-mcp` binary uses either embedded (own engine) or proxy (forwards to remote) depending on flags.
  - **Activities exposed via MCP?** Activities are workflow-scoped; exposing them as standalone MCP tools would let clients bypass durability. **Don't.** Only workflows are MCP tools, since they're the durable unit. Document the rationale so future contributors don't try to "fix" this.
  - **Tenant scoping:** an MCP session needs a tenant context. Remote: resolve via the session's auth token (OAuth scope claim). Local embedded: single-tenant — there's only the local user. Local proxy: forward the configured token's tenant.
  - **What to do when no `inputSchema` is registered for a workflow.** Reject. Every MCP-exposed workflow must declare a schema. No fallback, no config flag — once the unified catalog item ships, schemas are mandatory anyway.
  - **Binary distribution:** publish `weft-mcp` as a separate package, or as a sub-bin of `weft` (`npx weft mcp`)? Separate package is more discoverable and matches the MCP server naming convention (`@modelcontextprotocol/server-filesystem`, `mcp-server-github`, etc.). Use `bun build --compile` to produce platform binaries the npm package wraps — the same single-binary approach the README already advertises.

  **Why this matters:** MCP has the highest _outside_ leverage of every transport in this roadmap. AsyncAPI and OpenAPI serve developers writing custom clients; MCP serves _every_ MCP-aware AI tool out of the box. The pitch becomes "your durable workflows are first-class tools in any MCP client — paste a one-line config, you're done." That lands hard for the agent-native positioning the README leans on. The dual deployment (remote + `npx`) covers both ends: production teams add Weft to their hosted infra and connect Claude clients to it; individual developers run `npx weft-mcp` against a local SQLite file and have durable workflows in Claude Desktop in 30 seconds.

  **Out of scope for this item:** the MCP-server _catalog endpoint_ (the `x-weft-mcp` extension on OpenRPC, or `/mcp.json`) — that's the deferred item from the Transport Schemas section, and it follows naturally once a server exists.

- [ ] **MCP server catalog endpoint (deferred from Transport Schemas section).**

  **Where:** Picks up the deferred item from the Transport Schemas section once the MCP server exists. Decide between:
  - `x-weft-mcp` extension on the OpenRPC document — inline, simplest.
  - Separate `/.well-known/mcp.json` route — more discoverable, mirrors `api-catalog`.
  - Native MCP `tools/list` is already the canonical answer once a server exists; the catalog is just for _static_ introspection without instantiating a session.

  Lean toward "minimal" — an extension on OpenRPC plus the live `tools/list` is enough; a separate static catalog is nice-to-have, not a blocker.

  **Sequencing:** This item is gated by the MCP server implementation. Don't pick this up until the server exists.

**Sequencing for this section:**

1. MCP server implementation — the substantive item.
2. MCP server catalog endpoint — follows server existence.

## Engine Semantics

- [ ] **🚨 Preserve sub-operation results across `ctx.all` partial failures.**

  **Severity: high.** This is a correctness foot-gun in the middle of a feature the README leans on hard. Workflows that look like they checkpoint at every boundary (because the docs say so) silently re-execute already-successful side effects when a sibling branch in `ctx.all` fails.

  **Where:** `src/core/engine.ts:6965-6981` (`#processParallelOperation`), `src/core/context.ts:1163-1193` (`*all`), and the partner code paths for `ctx.race` (`#processRaceOperation`, line 6983) and `'run-all'` (line 7174). Test scaffolding in `src/core/engine.test.ts` around the existing `ctx.all` cases.

  **The problem:** `ctx.all` is checkpointed as a single composite operation. The current implementation:

  ```ts
  return this.#runOperationWithResult(workflowId, operation, async () =>
    Promise.all(
      operation.operations.map((subOperation) =>
        this.#executeSubOperation(workflowId, subOperation),
      ),
    ),
  );
  ```

  `Promise.all` short-circuits on first rejection. `#runOperationWithResult` (line 6654) catches the rejection and calls `#failOperation`. The successful branches' results never reach `#completeOperation`, so the parent `accumulatedResults[step]` slot stays empty. On retry, every sub-operation re-executes — including the ones that already succeeded.

  **Concrete trace (the README's checkout example):**

  ```ts
  const [confirmation, shipment] =
    yield *
    ctx.all([
      ctx.run(sendConfirmation, order.email, charge.receiptId),
      ctx.run(scheduleShipping, order.address),
    ]);
  ```

  1. Both sub-ops dispatched. `sendConfirmation` succeeds (email sent). `scheduleShipping` rejects.
  2. `Promise.all` rejects. Parent operation fails. Step `N` in `accumulatedResults` remains unset.
  3. Activity retry policy fires. `ctx.all` re-yields; step `N` not in cache; **both** sub-ops run again. **Customer gets two confirmation emails.**

  The author of `#processParallelOperation` documented this consciously (line 6969): _"`ctx.all()` awaits every branch, so there's no 'loser' to abort like there is for `ctx.race()`. Each sub-operation runs to completion or throws; `Promise.all` short-circuits on the first rejection."_ They were describing cancellation; the same mechanism produces the partial-loss behavior.

  **What to change:**
  1. **Switch to `Promise.allSettled` semantics for the inner dispatch, with per-sub-operation result persistence.** The parent `ctx.all` operation still fails when any branch fails — the _external_ contract doesn't change. But internally, every branch that _did_ settle (success or failure) is recorded against its own slot before the parent rejects. On retry, the engine checks each sub-operation's slot and skips the ones marked successful.
  2. **Sub-operation result table.** Each `'parallel'` operation gets a stable per-branch identity (positional index plus the sub-operation's own `operationId`). When a branch settles, write `{ status: 'fulfilled' | 'rejected', value }` keyed by that identity into the parent's checkpoint structure. The serialization format already supports per-step accumulated results — extend it to "per-step, per-branch" for parallel composites.
  3. **Retry path.** When `ctx.all` re-yields after a partial failure, `#executeSubOperation` consults the sub-operation table:
     - `fulfilled` → return cached value, don't dispatch.
     - `rejected` → re-dispatch, subject to the activity's retry policy. If it succeeds this time, write `fulfilled` into the slot. If it fails again past its retry budget, the parent rejects again with the new error.
     - `missing` → dispatch as normal (this is a branch that was canceled or never started before the parent failed — though with `Promise.all` short-circuiting today, this case shouldn't occur; with `Promise.allSettled` it shouldn't either).
  4. **Apply consistently to `'run-all'`** (`engine.ts:7174`). Same shape, same fix. `'run-all'` is the variant of `ctx.all` that runs activities sequentially with shared retry policy — the partial-success problem is identical and arguably worse (sequential execution makes the "we already did this" intuition stronger).
  5. **Don't apply to `'race'`** (`engine.ts:6983`). Race semantics are different — losers are _intentionally_ canceled, not "succeeded but unrecorded." A race that re-runs on retry should re-race; preserving a loser's partial result would be wrong. Keep current behavior; document the asymmetry.
  6. **Tests.**
     - Unit: `ctx.all` with two activities, one fails, retry succeeds. Assert the successful one is called _once_, not twice. Test the same with three branches where two succeed at different times before the third fails. Test recovery across an actual checkpoint round-trip (kill engine, restart, verify successful branches don't re-execute).
     - Property: random branch counts, random failure positions, random delays — total successful executions = total successful branches across the entire workflow lifetime.
     - Regression: every existing `ctx.all` test continues to pass.

  **Open design questions:**
  - **Idempotency annotations.** Even with this fix, an activity that fails _partway through_ its own execution (network call sent, response not received) is still re-executed on retry. That's the existing per-activity contract — orthogonal to this fix, not solved by it. Document the layering clearly.
  - **Checkpoint format change.** The serialized `'parallel'` accumulated entry gains per-branch slots. Pre-release — no in-flight production workflows to preserve. Bump the checkpoint format version, refuse to load older checkpoints, done. If we ever need backward compatibility, that's a post-1.0 concern.
  - **`isParallelOperationCacheEntry`** (`context.ts:1170`): the existing cache-entry shape carries `subOperationCount` for step-counter advancement. Extend to carry the per-branch slots so re-entry into `ctx.all` after recovery sees them.
  - **Inflight cancellation:** if branch B fails fast while branch A is still running, today branch A's promise just resolves into the void after the parent rejects. With the new behavior, we want branch A to _complete and persist its result_ before the parent settles. That's the behavior `Promise.allSettled` already gives us — switch the inner dispatch to it, and have `#processParallelOperation` decide the parent's outcome from the settled results (any rejection → parent rejects; all fulfilled → parent fulfills with the result array). This is the central wiring change.

  **Why this matters:**
  - **README correctness.** The intro pitch says "Checkpoints are written at every `yield*` boundary" and the checkout example is the load-bearing demonstration. With current behavior, the checkout example is an _anti-example_ of durable execution — it's the exact double-charge / double-email failure mode durability is supposed to prevent.
  - **Parity with the field.** Temporal preserves individual activity results across workflow retries by replaying history. Weft's checkpoint-not-replay model is supposed to give the same correctness with simpler ergonomics. Today, the simpler ergonomics come at a real correctness cost in `ctx.all`. Closing this gap is the difference between "checkpoint model" being a tradeoff and being strictly better.
  - **Foot-gun severity.** The bug is silent. Tests pass. Workflows complete with the right return value (eventually). The only signal is "user got two emails, customer support ticket filed." That's the worst kind of correctness bug.

  **Out of scope:**
  - Changing `ctx.all`'s external API or return shape.
  - Changing `ctx.race` semantics.
  - Activity-internal idempotency (separate, well-known concern).
  - Cancellation semantics for in-flight sibling branches when one fails — current behavior (let them complete) is correct for this fix; aborting them on first failure would be a separate `ctx.allOrCancel` variant.

  **Sequencing:** Independent of all other roadmap items. Can ship in isolation. Should ship before the Hello World / `ctx.all` documentation fixes — once the engine behaves correctly, the docs only need to describe what's true rather than warning around what isn't.

- [ ] **Document `ctx.all` and `ctx.race` failure semantics in `documentation/guides/parallel-execution.md` and the README.**

  **Where:** `README.md` lines 98–110 (the checkout example with `ctx.all`), `documentation/guides/parallel-execution.md`, and any tutorial that uses parallel composites.

  **The problem:** Both are silent about what happens on partial failure. The README's checkout example specifically uses `sendConfirmation` and `scheduleShipping` — two non-idempotent operations side-by-side in `ctx.all` — without any acknowledgment of the failure mode. Until the engine-behavior fix above lands, this is misleading; after it lands, it still needs documenting because retries-of-failed-branches still re-execute the _failing_ branch (the per-activity contract).

  **What to change (assuming the engine fix lands first):**
  1. In the parallel-execution guide, lead with the contract: "When any branch of `ctx.all` fails, the successful branches' results are persisted to the checkpoint and not re-executed on retry. Only the failed branch retries."
  2. Spell out what is and isn't idempotent. A branch that retries internally (network blip, transient 500) re-executes the activity once per retry attempt — same as a standalone `ctx.run`. The activity is responsible for its own idempotency at _that_ layer.
  3. Document the asymmetry with `ctx.race`: race losers are aborted and _do_ re-run on retry, because there's no meaningful "successful loser result" to preserve. If a workflow author wants race-with-preservation semantics, that's `ctx.all` with a `Promise.race`-style guard, not `ctx.race`.
  4. Update the README's checkout example with a one-line aside calling out why this is durable: "if `scheduleShipping` fails, the engine retries it without re-sending the confirmation email."
  5. If the engine fix has _not_ landed yet at the time this doc work happens, the docs need to honestly say so — "today, partial successes are not preserved; tracked under [issue]." Don't ship the polished version of the doc against a broken implementation.

  **Out of scope:** activity-level idempotency patterns (their own guide), saga patterns (`ctx.saga()` is its own thing), and the engine fix (separate item above).

  **Sequencing:** Should ship after the engine fix. If for some reason the engine fix is deferred, ship the honest "warning, this is the current behavior" version of the doc immediately — silence is the worst option.

## API Ergonomics

- [ ] **Rename `Otel*` identifiers to `OpenTelemetry*` throughout the observability module.**

  **Where:** Pervasive. Every identifier carrying the `Otel` shorthand:
  - `src/observability/metrics.ts`: `OtelMetrics` (type), `OtelMeter` (type), `createOtelMetrics` (function), JSDoc examples.
  - `src/observability/no-op-telemetry.ts`: `OtelApi`, `OtelSpan`, `OtelMeter`, `getOtelApi`.
  - `src/observability/index.ts`: `otelApi` field on `ObservabilityOptions`, `OtelSpan` imports, multiple internal references.
  - Every test file under `src/observability/`.
  - Every public re-export from `src/index.ts`.
  - All `documentation/agents/agent-observability.md`, `documentation/guides/observability.md`, README mentions.

  **The problem:** `Otel` is project jargon, not a brand. The official project is **OpenTelemetry** — the spec, the npm packages (`@opentelemetry/api`, `@opentelemetry/sdk-metrics`, etc.), and user-facing docs all spell it out. The codebase's own naming rules already say _"prefer `documentation` over `docs`, `repository` over `repo`, `pull request` over `pr`."_ Same logic applies here, and the upstream project's own package naming backs it up — they could have gone with `@otel/api` but chose `@opentelemetry/api`.

  **What to change:**
  1. Type renames: `OtelMetrics` → `OpenTelemetryMetrics`, `OtelApi` → `OpenTelemetryApi`, `OtelSpan` → `OpenTelemetrySpan`, `OtelMeter` → `OpenTelemetryMeter`.
  2. Function renames: `createOtelMetrics` → `createOpenTelemetryMetrics`, `getOtelApi` → `getOpenTelemetryApi`.
  3. Field rename: `ObservabilityOptions.otelApi` → `ObservabilityOptions.openTelemetryApi`.
  4. Update every JSDoc example block, README snippet, and guide that uses the old name.
  5. Update `src/index.ts` re-exports.

  **Approach:** Hard rename, single PR. Pre-release, no users — no aliases, no codemod, no changelog warnings.

  **Why this matters:** The README already pitches Weft as "for today's workloads, designed today." Spelling out external standards correctly is part of that. Short names also make grep-by-purpose harder for new contributors who type `OpenTelemetry` first because that's what every other library uses.

  **Out of scope:** changing the actual telemetry surface, the no-op fallback behavior, or what attributes get emitted. Pure rename.

- [ ] **Collapse `workflowInterceptors` and `activityInterceptors` into a single `interceptors` list.**

  **Where:** `src/core/engine.ts` (constructor options, the two `#interceptors` / `#activityInterceptors` fields, and every method that routes through them), `src/core/interceptor.ts` (the `WorkflowInterceptor` / `ActivityInterceptor` types and the composition helpers), `src/observability/index.ts:862` (`createObservabilityInterceptors` returns `{ workflow, activity, metrics, ... }` today — should return one object). Pervasive across tests and docs.

  **The problem:** The current shape leaks an internal implementation detail (interceptors are routed by which lifecycle they hook) into the public API. Two awkward consequences:
  1. **One logical concern, two named buckets.** A user setting up observability thinks _"I want observability on this engine"_ — not _"I have a workflow tracer and an activity tracer from the same factory that I'm going to manually re-bucket into two separate constructor lists."_ The README's example illustrates the friction:

     ```ts
     const interceptors = createObservabilityInterceptors({ metrics });
     const engine = new Engine({
       storage,
       workflowInterceptors: [interceptors.workflow],
       activityInterceptors: [interceptors.activity],
     });
     ```

     That's three lines of plumbing to wire up one feature. With a unified shape:

     ```ts
     const observability = createObservabilityInterceptors({ metrics });
     const engine = new Engine({ storage, interceptors: [observability] });
     ```

  2. **Splits interceptors that legitimately span both lifecycles.** A single tracing concern that wants to observe `activity`, `sleep`, `signal`, _and_ the `execute` boundary has to be authored as two objects, registered in two different lists. The implementation has no reason to require this — the engine routes hooks by name internally either way.

  **What to change:**
  1. **One `Interceptor` type** with all hooks optional:
     ```ts
     type Interceptor = {
       // workflow-side hooks
       activity?: WorkflowInterceptor['activity'];
       sleep?: WorkflowInterceptor['sleep'];
       signal?: WorkflowInterceptor['signal'];
       // ...rest of WorkflowInterceptor hooks
       // activity-side hook
       execute?: ActivityInterceptor['execute'];
     };
     ```
     Either as a single optional-field interface or a discriminated union — pick whichever composes better with the existing `ComposedInterceptor` machinery.
  2. **`Engine` accepts one list:** `interceptors?: Interceptor[]`.
  3. **Engine internally routes** to the same `WorkflowInterceptor` / `ActivityInterceptor` composition pipelines that exist today by filtering for present hooks. The composition machinery in `src/core/interceptor.ts` (lines 491–791) doesn't have to change much — it gets a wrapper at construction time that splits the unified list into the two internal buckets.
  4. **`createObservabilityInterceptors` returns one object,** not two. Same for any other factory that today returns `{ workflow, activity }`.
  5. **Order semantics:** an interceptor's position in the list determines wrapping order for _both_ the workflow and activity pipelines simultaneously. Document this — it's a meaningful semantic. The current dual-list shape lets users specify _different_ orders per side, which is technically more flexible but in practice nobody wants that and it's a foot-gun.

  **Approach:** Hard rename, single PR. Pre-release, no users. Mechanical changes to consuming code:
  - `workflowInterceptors: [a]` + `activityInterceptors: [b]` → `interceptors: [a, b]`.
  - `[interceptors.workflow]` + `[interceptors.activity]` → `[interceptors]` (the factory now returns one object).
  - `WorkflowInterceptor` and `ActivityInterceptor` stay as advanced types for users who want to author single-lifecycle interceptors; `Interceptor` is the new everyday type.

  **Why this matters:** The README leans on interceptors as a key extensibility story (_"Composable interceptors layer cross-cutting concerns — tracing, validation, encryption — without any of them knowing about each other"_). The current shape forces the user to know about the two-bucket internal routing on the very first interaction. Composition stories should hide their plumbing, not expose it.

  **Out of scope:** changing what hooks exist, what they receive, or the composition order semantics. Pure restructuring of the public surface.

  **Sequencing:** Independent of all other items. Should ship before any new interceptor-shaped feature lands (otherwise that feature inherits the awkward dual-list shape).

- [ ] **Move `TestEngine`, `TimeControl`, `ActivityMockRegistry`, and chaos helpers to a `weft/testing` subpath export.**

  **Where:** `package.json` `exports` field (add `"./testing"` mapping), `src/index.ts:323-330` (remove the re-exports for `TestEngine`, `RunNOptions`, `RunNResult`, `ActivityMockRegistry`, `MockCall`, `MockHandle`, `MockedActivity`, `TimeControl`, `withChaos`, `ChaosScenario`, `FaultClass`), `src/testing/index.ts` (create as the new subpath entry — currently doesn't exist; the directory has the source files but no barrel). Update `documentation/guides/testing.md`, the README's `TestEngine` example, and any other doc that imports from `weft`.

  **The problem:** Today, every test-only primitive sits on the main `weft` entry alongside `Engine`, `Context`, and the rest of the production surface. Three concrete consequences:
  1. **Autocomplete pollution in production code.** A workflow author typing `import { ` from `'weft'` sees `TestEngine`, `ActivityMockRegistry`, `TimeControl`, `withChaos` competing for space with `Engine`, `defineAgent`, `serve`. There's no signal at the import site that these are test-only. New contributors reasonably assume they're all production primitives.

  2. **Inconsistent with every other subpath.** `weft/storage/bun-sqlite`, `weft/storage/lmdb`, `weft/storage/turso`, `weft/storage/indexeddb`, `weft/server`, `weft/mcp/stdio`, `weft/client/local` — every other "you might not need this" surface is already a subpath. `testing` is the only exception. Following the existing convention is itself valuable: predictable structure, fewer special cases.

  3. **Tree-shaking is probabilistic; subpaths are structural.** The testing module currently has no third-party deps and is small (~1100 lines source, probably 15–25 KB minified), so tree-shaking _should_ drop it from production bundles. But "should" depends on the consumer's bundler configuration (`sideEffects: true` upstream, CJS interop, module-level side effects) — none of which are issues today, but any of which can silently start carrying weight tomorrow. A subpath export is a guarantee; tree-shaking is a hope.

  **What to change:**
  1. Add `src/testing/index.ts` as a barrel re-exporting `TestEngine`, `TimeControl`, `ActivityMockRegistry`, `withChaos`, plus their associated types.
  2. Add `"./testing": { "types": "./dist/testing/index.d.ts", "default": "./dist/testing/index.js" }` to `package.json` `exports`.
  3. Remove the testing re-exports from `src/index.ts:323-330`. Hard delete — pre-release, no users.
  4. Update `documentation/guides/testing.md`, the README's `TestEngine` example, and any other doc that imports test primitives from `weft`. Every example becomes `import { TestEngine } from 'weft/testing'`.
  5. Add a tree-shaking verification entry to `scripts/verify-tree-shaking.ts` proving that `import { Engine } from 'weft'` does not pull `TestEngine`, `TimeControl`, etc. into the bundle.
  6. Audit the `dist/` build output to confirm `dist/testing/index.js` ships cleanly and the build pipeline (`bunfig.toml`, `package.json` `prepack` hook) covers it.

  **Why this matters:** The marginal bundle-size win is real but small. The real wins are _intent at the import site_, _clean autocomplete for production code_, and _consistency with the rest of the export surface_. The READMEs's testing pitch — _"`TestEngine` swaps the production engine in tests"_ — is more honest when the import path itself says so.

  **Out of scope:**
  - Changing the `TestEngine` API. Pure relocation.
  - Splitting `chaos` into its own subpath (`weft/testing/chaos`). Keep one `weft/testing` umbrella unless a future use case justifies finer-grained.
  - Anything to do with the `bun:test` integration story — `TestEngine` is runner-agnostic and stays that way.

  **Sequencing:** Independent. Ship anytime.

- [ ] **Default `Engine` to a runtime-appropriate storage backend when `storage` is omitted.**

  **Where:** `src/core/engine.ts` (`Engine` constructor — currently requires `storage` in options or throws), `src/core/types.ts` (`EngineOptions` — make `storage?` optional). Coordinates with the `resolveStorage()` helper item already in the Storage section.

  **The problem:** Every quickstart, every Hello World, every test harness starts the same way: `new Engine({ storage: new SomeStorage(...) })`. The user has to _know_ which storage class fits their runtime, import it from the right subpath, instantiate it with the right arguments. For the _common_ case — "I just want to try Weft on whatever runtime I'm in" — that's friction without payoff. The runtime can be detected; the right storage backend can be picked automatically.

  **The fix:** if `storage` is omitted from `EngineOptions`, the `Engine` constructor calls `resolveStorage({ type: 'auto' })` internally:
  - **Bun** detected → `BunSQLiteStorage` (default path `./weft.db`).
  - **Node** detected (no Bun) → `NodeSQLiteStorage` (default path `./weft.db`).
  - **Browser** detected (no `Bun`/`process`, has `indexedDB`) → `IndexedDBStorage` (default database name `weft`).
  - **Web Extension** detected → `WebExtensionStorage` (default area `local`).
  - **Service Worker** detected → `IndexedDBStorage` (matches the browser case).
  - None of the above → throw a clear error: _"Engine requires a `storage` option in this runtime; pass one explicitly. Available backends: ..."_

  Hello World becomes:

  ```ts
  import { Engine } from 'weft';

  const engine = new Engine(); // ← that's it. SQLite on Bun, SQLite on Node, IndexedDB in browser.
  engine.register('welcome', async function* (ctx, input) {
    /* ... */
  });
  ```

  The explicit-import form (`new Engine({ storage: new BunSQLiteStorage('./prod.db') })`) stays — it's the right answer for production where you want to control the path, the connection options, the namespace. The auto-detection is for the _quickstart_ and _test_ cases where the user just wants to try it.

  **What to change:**
  1. **Make `storage` optional on `EngineOptions`.** If omitted, the constructor invokes `resolveStorage({ type: 'auto' })`.
  2. **Implement the detection logic in `resolveStorage('auto')`** (already tracked under the Storage section's `resolveStorage(config)` item — this item is the consumer of that). Detection order:
     - `typeof Bun !== 'undefined'` → Bun → `BunSQLiteStorage`
     - `typeof process !== 'undefined' && process.versions?.node` → Node → `NodeSQLiteStorage`
     - `typeof chrome !== 'undefined' && chrome.storage` (or `browser.storage`) → extension → `WebExtensionStorage`
     - `typeof indexedDB !== 'undefined'` → browser/SW → `IndexedDBStorage`
     - otherwise throw with a clear message.
  3. **Lazy-load each adapter** so unselected ones don't end up in the bundle. Same pattern the existing per-adapter subpath exports already use.
  4. **Default file paths and database names** documented and conservative — `./weft.db` for SQLite, `weft` for IndexedDB. Configurable via `EngineOptions` would defeat the point of the auto-default; users who want to configure should pass `storage` explicitly.
  5. **Log a one-time info message** on the engine the first time it constructs an auto-detected storage: `"[weft] Auto-detected runtime: bun. Using BunSQLiteStorage at ./weft.db. Pass `storage` explicitly for production."` Surfaces the choice without being noisy.
  6. **Tests** — one per runtime, asserting the right backend is instantiated. The IndexedDB and WebExtension cases require browser-test or extension-test harnesses; gate them appropriately.
  7. **Update Hello World examples everywhere** to drop the explicit storage line. The "for production, pass `storage` explicitly" callout lives in the Hello World fix doc-item already on the roadmap.

  **Why this matters:**
  - **Hello World shrinks by one line.** That sounds trivial; it isn't. The first impression of a library is "how many lines do I need before something works." Cutting the storage import line is one fewer thing to explain in the first paragraph.
  - **Test harnesses simplify too.** `new Engine()` in a test is `MemoryStorage`-equivalent ergonomics for the SQLite-on-disk reality, with the test runner picking the right thing per-environment.
  - **Aligns with how every runtime-aware library in the ecosystem works.** `bun:sqlite` is auto-loaded on Bun; `node:sqlite` on Node; `localStorage` and `indexedDB` are ambient in browsers. Weft asking the user to pick is one layer of friction the platform already eliminated.

  **Out of scope:**
  - Auto-detecting `LMDBStorage`, `TursoStorage`, or any other backend. Those are deliberate production choices, not "runtime defaults." Auto-detection covers the _quickstart_ case only.
  - Migrating users between backends. If a user starts with auto-detected SQLite and later wants LMDB, they pass `storage` explicitly and migrate their data themselves. Not Weft's job to migrate.

  **Sequencing:** Depends on the `resolveStorage()` helper from the Storage section. Land that first; this is its consumer. Pre-1.0 — once shipped, removing it would be a breaking change.

- [ ] **Add a `setupServiceWorker()` helper that collapses Service Worker setup into one call.**

  **Where:** New file `src/service-worker/setup.ts`. New export from `weft/service-worker`. Existing per-handler functions (`createFetchHandler`, `createPeriodicSyncHandler`, `createLifecycleHandlers`, `ServiceWorkerScheduler`) stay — the setup helper composes them.

  **The problem:** Today, setting up Weft to run inside a Service Worker requires this much boilerplate:

  ```ts
  /// <reference lib="webworker" />
  import { Engine } from 'weft';
  import { IndexedDBStorage } from 'weft/storage/indexeddb';
  import {
    createFetchHandler,
    createLifecycleHandlers,
    createPeriodicSyncHandler,
    ServiceWorkerScheduler,
  } from 'weft/service-worker';

  const storage = new IndexedDBStorage('weft');
  const engine = new Engine({ storage });
  const scheduler = new ServiceWorkerScheduler({
    storage,
    onTimerFired: (entry) => engine.processTimer(entry),
  });

  const { install, activate } = createLifecycleHandlers();
  self.addEventListener('install', install);
  self.addEventListener('activate', activate);
  self.addEventListener('fetch', createFetchHandler({ engine, pathPrefix: '/weft/' }));
  self.addEventListener('periodicsync', createPeriodicSyncHandler(scheduler));
  ```

  Eight imports. Five `addEventListener` calls. The wiring between scheduler and engine is hand-coded. **For the common case — "set up Weft as a Service Worker" — this is too much ceremony.** The engine, storage, scheduler, and event-listener registration are not independently configurable in any meaningful way; they're a fixed wiring pattern. Patterns deserve helpers.

  **The fix:** a single `setupServiceWorker()` call that does all of it:

  ```ts
  /// <reference lib="webworker" />
  import { setupServiceWorker } from 'weft/service-worker';

  const { engine } = setupServiceWorker({
    pathPrefix: '/weft/',
  });

  engine.register('checkout', async function* (ctx, input) {
    /* ... */
  });
  ```

  The helper internally:
  - Creates an `IndexedDBStorage` (default database name `weft`, override-able via `options.databaseName`).
  - Creates an `Engine` with that storage (or accepts a pre-built engine via `options.engine` for users who want to wire it themselves).
  - Creates a `ServiceWorkerScheduler` wired to the engine's `processTimer`.
  - Registers `install`, `activate`, `fetch`, and `periodicsync` listeners on `self`.
  - Returns `{ engine, storage, scheduler }` for users who need to reach in.

  Auto-detection from the previous item makes this even tighter: with both items shipped, `setupServiceWorker()` doesn't even need to construct storage explicitly — the `Engine` auto-detects IndexedDB.

  **What to change:**
  1. **Implement `setupServiceWorker(options?)`** in `src/service-worker/setup.ts`. Options:
     - `pathPrefix?: string` (default `/weft/`)
     - `databaseName?: string` (default `weft`)
     - `engine?: Engine` (escape hatch — if provided, skip engine creation)
     - `storage?: Storage` (escape hatch — if provided, skip storage creation)
     - `periodicSyncTag?: string` (default `weft-timers`)
     - `register?: (workflow) => void` (optional — pre-register workflows before listeners attach; useful when the worker is loaded as a module).
  2. **Return the wired components** so users who need to extend the setup (custom event listeners, additional middleware) can. Don't lock users out of the lower-level API by shipping the helper.
  3. **Document the helper as the recommended path** for Service Worker setup. The lower-level functions (`createFetchHandler`, etc.) become the escape hatch for users who need custom wiring.

  4. **Sequencing the helper's dual role:** the `bootstrap` term was avoided because (a) it carries Java/enterprise connotations that don't fit Weft's voice, and (b) `setupX` is the JS-ecosystem standard for "wire this thing up once at module load" (`setupTests`, `setupFiles`, `setupTracing`, `setupGlobals`, etc.). Stick with `setup` here and use it consistently if other "wire up X" helpers land later.
  5. **Tests** — service worker test harness validates that all four listeners are attached and that the engine + scheduler interaction is correct.

  **Why this matters:**
  - **The service worker pitch is one of Weft's differentiators.** "Runs in the browser" is a load-bearing claim in the README. The current setup ergonomic undersells it — eight imports and five listener registrations is a lot of boilerplate for a feature that's supposed to be ergonomic.
  - **Pattern collapse where the pattern is genuinely fixed.** The existing four-call wiring isn't independently configurable in any meaningful way; nobody legitimately wants `install` without `activate`, or `fetch` without `periodicsync`. Helpers are appropriate when the pattern is closed.
  - **Pairs with the auto-storage item.** Both reduce setup friction for environments where the right choice is obvious. Together, the Service Worker quickstart drops to ~6 lines.

  **Out of scope:**
  - Removing the lower-level helpers. They stay — bootstrap is the recommended path; the per-handler functions remain for advanced wiring.
  - Auto-detecting whether the user is in a Service Worker context (the user knows; they imported from `weft/service-worker`).
  - Supporting Shared Workers or other Web Worker variants — different lifecycle, different APIs, different item.

  **Sequencing:** Independent of other items. Pairs naturally with the auto-storage item — ship together for the strongest combined ergonomic story. Pre-1.0 — adding it later is fine, but the boilerplate is already in published examples.

## Storage

- [ ] **Consolidate SQLite imports under `weft/storage/sqlite` with runtime auto-detection; delete the legacy `weft/storage/bun-sqlite` alias.**

  **Where:** `package.json` `exports` field, every doc and example that imports `BunSQLiteStorage` (currently nine doc files and the README), and any internal references to the `weft/storage/bun-sqlite` subpath.

  **The current state (partly done, partly not):**

  ```jsonc
  // What package.json already has:
  "./storage/sqlite": {
    "bun":  { "types": "./dist/storage/bun-sql.d.ts",     "default": "./dist/storage/bun-sql.js" },
    "node": { "types": "./dist/storage/node-sqlite.d.ts", "default": "./dist/storage/node-sqlite.js" }
  },
  "./storage/sqlite/bun":  { "types": "./dist/storage/bun-sql.d.ts",     "bun":  "./dist/storage/bun-sql.js" },
  "./storage/sqlite/node": { "types": "./dist/storage/node-sqlite.d.ts", "node": "./dist/storage/node-sqlite.js" },
  "./storage/bun-sqlite":  { "types": "./dist/storage/bun-sql.d.ts",     "bun":  "./dist/storage/bun-sql.js" },
  // (no corresponding `./storage/node-sqlite` — asymmetric)
  ```

  The auto-detecting `weft/storage/sqlite` and the explicit overrides `weft/storage/sqlite/bun` and `weft/storage/sqlite/node` exist. **But** `weft/storage/bun-sqlite` also exists as a parallel third name for the same thing, and _every_ doc and example uses that legacy name. There's no `weft/storage/node-sqlite` parallel — the asymmetry is itself a smell. So the design you're proposing is half-shipped and inconsistently used; this item is the cleanup.

  **What to change:**
  1. **Delete the `./storage/bun-sqlite` exports entry from `package.json`.** Pre-release, no users — single hard cut.
  2. **Update every doc and example to use `weft/storage/sqlite`.** Confirmed call sites that need the rename:
     - `README.md` (lines 38, 190, 206, 310)
     - `documentation/getting-started/hello-world.md:158`
     - `documentation/getting-started/installation.md:31`
     - `documentation/guides/storage.md:71`
     - `documentation/guides/resource-management.md:10`
     - `documentation/reference/api-storage.md:170`
     - Any other guide that lifts `BunSQLiteStorage` (one final grep before shipping the rename)
  3. **Update `README.md:191`** which currently lists `weft/storage/sqlite/node` for Node — the README's storage section should mention `weft/storage/sqlite` as the canonical entry, with the explicit `/bun` and `/node` subpaths as opt-out overrides for users who _need_ to force one runtime (cross-runtime test harnesses, polyglot deployments, etc.).
  4. **Verify the Bun and Node conditions actually work end-to-end.** Both runtimes should import from `weft/storage/sqlite` and get the right module without manual config. Add an integration test that:
     - Builds a tiny consumer entry against the published `dist/`.
     - Runs once under Bun, once under Node.
     - Asserts the imported `BunSQLiteStorage` / `NodeSQLiteStorage` constructor name matches the runtime.
     - Lives in `scripts/verify-tree-shaking.ts` or a sibling `verify-storage-conditions.ts`.
  5. **Decide whether the unified entry exports a single name or runtime-specific names.** Today, `weft/storage/sqlite` resolves to _either_ `BunSQLiteStorage` or `NodeSQLiteStorage` depending on runtime — different class names. That's awkward for users writing cross-runtime code:

     ```ts
     // Today, won't typecheck cleanly across runtimes:
     import { BunSQLiteStorage } from 'weft/storage/sqlite'; // works in Bun, breaks in Node
     ```

     Options:
     - (a) Keep the asymmetric names. Users who want cross-runtime code use the override paths.
     - (b) Add a runtime-neutral re-export (`SQLiteStorage`) that's the same name on both sides. Most ergonomic; matches how the rest of the codebase names things.

     Lean (b). It's what users will reach for and it's cheap to add — just a `re-export as SQLiteStorage` in each backend module.

  6. **Make the explicit-override paths the documented escape hatch, not the default.** Doc text should read something like: _"`weft/storage/sqlite` auto-detects Bun vs. Node. If you need to force a specific runtime — for tests that run under both, or for polyglot deployments — use `weft/storage/sqlite/bun` or `weft/storage/sqlite/node`."_

  **Why this matters:** Single canonical import path is friendlier than runtime-specific imports for users who don't care about the underlying engine — which is most users. The exports-conditions feature was made for exactly this case. Today's situation (auto-detect path exists but every doc uses the legacy flat path) is the worst of both worlds: the right structure is there, but readers never see it. Cleaning this up before 1.0 is cheap and tightens the surface meaningfully.

  **Out of scope:**
  - Touching the LMDB, Turso, IndexedDB, or compressed-storage exports. Different deps, different shape — they don't have the runtime-conditional case SQLite has.
  - Renaming the `BunSQLiteStorage` / `NodeSQLiteStorage` _classes themselves_ (unless we go with option 5b, in which case `SQLiteStorage` becomes the additional public name; the runtime-specific names stay for users who want them).

  **Sequencing:** Independent. Cheap. Should ship as part of any pre-1.0 docs/examples sweep.

- [ ] **Add `ChromeStorage` (a.k.a. `WebExtensionStorage`) for Chrome / WebExtension contexts.**

  **Where:** New file `src/storage/chrome.ts` (or `web-extension.ts` — see naming question below). New `weft/storage/chrome` (or `weft/storage/web-extension`) subpath in `package.json` `exports`.

  **The gap:** Today the only browser-shaped backend is `IndexedDBStorage`. `IndexedDB` works _inside_ Chrome extensions — service workers, background scripts, popups, content scripts can all open IDB — but it isn't the idiomatic storage API for extension contexts, and it has real friction there:
  - **Service worker lifecycle:** MV3 background service workers die after ~30s of idle. Reopening an `IDBDatabase` connection after the worker restarts is doable but adds complexity. `chrome.storage` reconnection is transparent.
  - **Cross-context shape:** `chrome.storage.local` (and `.sync`, `.session`, `.managed`) is the storage API extensions are _expected_ to use. Linters, examples, the WebExtension API docs, and review processes all assume it.
  - **Sync support across devices:** `chrome.storage.sync` replicates state across a user's signed-in browsers automatically — a Weft workflow that runs in a browser extension and follows the user across devices is a genuinely interesting use case that IndexedDB can't service.
  - **Quotas and policies:** managed extensions can ship admin-controlled `chrome.storage.managed` defaults. IDB has none of that.
  - **Cross-context messaging:** `chrome.storage.onChanged` events let any extension surface react to writes from any other surface. With IDB you'd be writing your own pub/sub.

  **What to change:**
  1. **Implement the `Storage` interface against `chrome.storage.local`.** Maps the five required methods (`get`, `put`, `delete`, `scan`, `batch`) onto `chrome.storage.local.{get, set, remove, clear}` and per-key prefix scans. Storage values are `Uint8Array` per the existing interface — base64-encode for `chrome.storage` (which only accepts JSON-serializable values), or use the `chrome.storage` quota-friendly chunking pattern for large blobs. Pick whichever the test results favor.
  2. **Support the four `chrome.storage` areas as constructor options:** `'local'` (default), `'sync'`, `'session'`, `'managed'` (read-only). Different durability + size + replication semantics — let the caller pick.
  3. **Support cross-browser via the `browser.*` namespace.** Firefox, Safari (WebExtensions), and Edge expose the same surface under `browser.storage` instead of `chrome.storage`. The implementation should detect both — typically `globalThis.browser ?? globalThis.chrome`. This is why "WebExtensionStorage" is arguably the more accurate name; "ChromeStorage" is the colloquial one.
  4. **Honor `chrome.storage` quotas.** `chrome.storage.local` has a 10MB default, `chrome.storage.sync` has 100KB and per-item limits. The backend should expose quota info via an introspection method _and_ fail fast with a clear error if a single value would exceed `sync` per-item limits. Don't silently chunk into multiple keys without the caller knowing — that breaks `scan` semantics.
  5. **Implement `onChanged` integration.** `chrome.storage.onChanged` fires for any write. The backend can use this to invalidate any in-memory caches and (optionally) emit Weft engine events when storage changes from outside the current process. This is the "natural pub/sub" win unique to this backend.
  6. **Add a manifest documentation example.** Extension authors need to declare `"permissions": ["storage"]` in `manifest.json`. The doc page should show the minimal manifest plus a "hello world" workflow running in a service worker.
  7. **Bun/Node compatibility:** the backend must not break in non-extension contexts. Either (a) lazy-load `chrome.storage` access only on first method call and throw a clear error if absent, or (b) export the backend behind a runtime check at module load. Lean (a) — same pattern as `LMDBStorage`'s lazy import.
  8. **Tests:** browser test harness (Playwright + a tiny test extension) covering all five required methods, the optional ones (`conditionalBatch`, `has`, `deletePrefix`), area-switching (`local` vs. `session`), the chunking path for large values, and `onChanged` round-tripping.

  **Naming question to resolve:**
  - **`ChromeStorage`** — colloquial, matches the API namespace users will actually type, but inaccurate (works in Firefox, Safari, Edge too).
  - **`WebExtensionStorage`** — accurate, matches the spec, but jargon-heavy and slightly longer.
  - **`ExtensionStorage`** — middle ground.

  Lean toward `WebExtensionStorage` per the project's full-words rule (`documentation` over `docs`, `repository` over `repo`, etc.) — and a re-export as `ChromeStorage` for users who think colloquially. Subpath: `weft/storage/web-extension`.

  **Why this matters:**
  - **Browser story is incomplete without it.** The README pitches "Runs in the browser" prominently. _In an extension_, IndexedDB technically works but isn't what extension developers expect to see. Shipping a `WebExtensionStorage` makes Weft a first-class extension-shaped library, not just a "library that happens to also work in extensions."
  - **Cross-device sync is genuinely novel.** A durable workflow that survives the user moving from their work laptop to their phone to their home desktop — automatically, via `chrome.storage.sync` — is something no other workflow engine (Temporal, Inngest, Trigger.dev) can offer. The MV3 lifecycle constraints make implementation tricky but the payoff is a unique capability.
  - **Service-worker durability becomes simple.** Workflow checkpoints survive the ~30s idle restart with no extra glue code from the extension author. Pair with the existing service-worker persistence story in `src/service-worker/` and the offline durability story snaps together.

  **Out of scope:**
  - Anything specific to a _particular_ extension framework (Plasmo, WXT, etc.). The backend is plain `chrome.storage` against the WebExtensions API spec — frameworks consume it directly.
  - `chrome.storage.session` durability promises. By design it's cleared on browser restart; the backend exposes it for in-session workflows but doesn't pretend it's durable across restarts. Document explicitly.
  - Native messaging (`chrome.runtime.connectNative`) integration — different extension feature, not storage.
  - Migration tooling between `IndexedDBStorage` and `WebExtensionStorage`. Different consumer profiles; users who want migration write it themselves.

  **Sequencing:** Independent of all other items. Lower priority than the storage SQLite consolidation (which fixes a current confusion) but higher upside (a genuinely new capability). Probably ships after the pre-1.0 cleanup items but before any "more LLM providers" work — extension support is a positioning feature, more providers are an incremental one.

## Type-Safety on User-Provided Payloads

- [ ] **Replace `input: unknown` + `as` casts with idiomatic inline parameter annotations across every payload-accepting API.**

  **The trigger:** The README's "Step API for `async`/`await` users" example currently reads:

  ```ts
  engine.register('welcome', async (ctx, input) => {
    const { name } = input as { name: string }; // ← bad TypeScript
    // ...
  });
  ```

  The `as { name: string }` cast is the smell. The project's own TypeScript rules say _"Treat every `as` cast with suspicion. The pattern `as unknown as SomeType` is a red flag."_ Casting `input` straight to a typed shape is one cast away from that anti-pattern, and it's the _first_ TypeScript a reader sees in the doc.

  **The decision: inline parameter annotations are the idiomatic everyday pattern.**

  Three options were considered:
  - **Option A — generic on the registration:** `engine.register<{ name: string }>('welcome', (ctx, input) => ...)`. Looks like it's parameterizing the registration itself but is really just declaring what the parameter should be. That's what parameter annotations are for. Verbose and creates two ways to do the same thing.
  - **Option B — inline parameter annotation:** `engine.register('welcome', async (ctx, input: { name: string }) => ...)`. Standard JS/TS function-typing. Every developer already knows how to read it. Matches Hono, Bun, the JS ecosystem at large.
  - **Option C — module-augmentation registry via `Engine<TRegistry>`:** already exists in the codebase (`src/core/types.ts` `WorkflowRegistry` + the typed-`Engine<TRegistry>` plumbing). Provides cross-call type safety: `engine.start('welcome', input)` knows `input`'s type from the registry. The right shape for power users; not the right default for the quickstart.

  **Conclusion:** **Option B is the everyday default; Option C is the opt-in upgrade.** The two coexist — when a registry is present, `register` consults it and the inline annotation must match (or TypeScript errors); when there's no registry, the inline annotation is the source of truth. **Option A is rejected** — it's redundant with Option B and adds ceremony.

  **Three layers of type-safety, all reinforcing each other.** This item covers the local (Option B) and same-codebase (Option C) layers. The third layer — _cross-process_ type-safety, where a client in a separate repo or even a separate language wants typed access to a remote Weft server's surface — is covered by two paired items elsewhere in the roadmap:
  - **Unified Operation Catalog → "Unify `WorkflowRegistration` and `ActivityRegistrationOptions` with the `OperationDefinition` shape"** is the foundation. Workflows and activities become catalog citizens carrying `inputSchema` / `outputSchema`. Without that, there's nothing to publish.
  - **Type Generation → "Expose JSON Schema registries from the server, then ship a static-generation tool that emits a `.d.ts`"** is the consumer side. A `weft codegen` CLI fetches the server's JSON Schema registry and emits a `.d.ts` that augments `WorkflowRegistry` and (eventually) `ActivityRegistry`. **See also: "CLI → Add `weft codegen`"** for the concrete CLI shape.

  The full picture: inline annotations for the everyday case, `Engine<TRegistry>` for cross-call safety in the same codebase, generated `.d.ts` for cross-process safety. Each layer is opt-in; users adopt whichever match their topology.

  **What to change:**

  Every API surface today that takes `input: unknown` (or `payload: unknown`) and expects the user to project it. Inline annotation should _just work_ via TypeScript's contextual typing. If it doesn't currently, the parameter type on the function signature needs to be loosened to allow user-supplied annotations to flow through.
  1. **`engine.register(name, handler)`** — `src/core/engine.ts:2473-2483` and the underlying `WorkflowFunction<TInput, TOutput>` / `StepWorkflowFunction<TInput, TOutput>` types in `src/core/types.ts:888, 944`. Both function types are _already generic_. The runtime overload throws away the generics by defaulting to `unknown`. Verify that contextual typing flows when the user writes `async (ctx, input: { name: string }) => ...` — if it does, the only change needed is _example code_ in docs. If it doesn't, the overload signatures need a tweak so TypeScript pulls the parameter type from the user's annotation.
  2. **`engine.start(type, input, options)`** — `src/core/engine.ts:2693`. Currently `input: unknown`. Two paths:
     - With a typed `Engine<TRegistry>`, `start`'s `input` should be derived from `TRegistry[type]['input']` — already partly there per the existing `Engine<TRegistry>` typing.
     - Without a registry, allow `engine.start<{ name: string }>('welcome', { name: 'Steve' })` as a generic-positional escape hatch, _or_ keep `unknown` and require the registry for type-safety on the start side. Lean toward the latter — `start` is far enough from the workflow definition that inline annotation isn't ergonomic.
  3. **`engine.signal(id, name, payload)`, `engine.update(id, name, payload)`, `engine.query(id, name, payload)`** — symmetric problem. Each currently takes `payload: unknown`. With a registry that declares signal/update/query schemas per workflow, these can become typed. Without a registry, fall back to `unknown` (callers can cast at their site, but that's their decision).
  4. **`ctx.waitForSignal<T>(name)`** — already generic on the receive side. The asymmetry with `engine.signal` is the gap: senders are untyped while receivers are. The registry path fixes both sides at once.
  5. **`engine.registerActivity(name, fn, options)`** — `src/core/engine.ts:2681`. Activity input/output types should flow from the function signature contextually, same as workflows. Confirm contextual typing works; tighten the signature if needed.
  6. **`ctx.run(fn, ...args)`** — already covered by the typed-`ctx.run` roadmap item ("Add typed `ctx.run` and `engine.start` via a module-augmentation activity registry"). The shape there is consistent with this item's conclusion: registry for cross-call typing, inline for the everyday case.
  7. **Update/query handler registration via `WorkflowRegistration`** — same shape as workflow input/output. Generic types already exist; verify contextual flow.

  **Documentation pass that has to ship with the code:**

  Every doc, README example, and JSDoc snippet that currently uses `as { ... }` to cast the input parameter must be rewritten to use inline annotation:

  ```ts
  // Before
  engine.register('welcome', async (ctx, input) => {
    const { name } = input as { name: string };
    // ...
  });

  // After
  engine.register('welcome', async (ctx, input: { name: string }) => {
    const { name } = input;
    // ...
  });
  ```

  Specific files to audit (definitely affected; one final grep before shipping):
  - `README.md` — Step API section (around line 320), Hello World, every `engine.register` snippet.
  - `documentation/getting-started/hello-world.md`, `documentation/getting-started/key-concepts.md`.
  - `documentation/guides/workflows.md`, `documentation/guides/activities.md`, `documentation/guides/signals-and-queries.md`, `documentation/guides/synchronous-updates.md`.
  - `documentation/agents/*.md` — agent input/output examples likely have the same pattern.
  - JSDoc examples in `src/core/engine.ts`, `src/core/context.ts`, `src/core/types.ts` — anywhere a `register` / `start` / `signal` example appears.

  **Lint rule to prevent regression:**

  Add an oxlint rule (or a custom AST check) that flags `as <ObjectType>` directly inside a `register` / `start` / `signal` / `update` / `query` callback. The codebase already uses oxlint with type-aware rules; this is a natural extension. The rule's message should suggest the inline-annotation rewrite.

  **Why this matters:**
  - **First impressions.** The `as { name: string }` cast in the README is the _first_ line of TypeScript a reader sees. It teaches them to use casts where annotations belong. That's a bad mental model to seed.
  - **Internal consistency.** The codebase's own rules (`.claude/rules/typescript.md` and `CLAUDE.md`) say to treat `as` with suspicion. The public API examples should model that, not contradict it.
  - **Pre-1.0 hygiene.** Audit once, fix everywhere, lint to prevent regression. This is the kind of cleanup that's cheap now and expensive once users have copy-pasted the old pattern into their own code.

  **Open questions:**
  - **Should `engine.start` accept a generic for the input type when no registry is in use?** Lean no — the registry is the right shape for call-site typing. If a user's caller doesn't have access to the workflow's handler type (different file, different package), they should be using the registry pattern anyway.
  - **Should the `WorkflowRegistration<TInput, TOutput>` overload of `register` _require_ matching generics with the handler?** Probably yes, but verify TypeScript can infer that without forcing users to write `register<TInput, TOutput>` explicitly.

  **Out of scope:**
  - Replacing the `Engine<TRegistry>` registry pattern with something else. It stays — it's the upgrade path for cross-call type-safety. This item just makes the _everyday_ case (no registry) work cleanly via inline annotation.
  - Adding runtime validation to match the type-level annotation. That's the unified-operation-catalog item — schemas at registration. Separate concern; this item is purely about removing `as` casts and making contextual typing work.
  - Changing the function-type generics themselves. `WorkflowFunction<TInput, TOutput>` already has the right shape.

  **Sequencing:** Independent. Should ship before or alongside the README docs cleanup work — same audit, same files, same time saved if done together.

## CLI

- [ ] **Add `weft codegen` — pull the JSON Schema registry from a Weft server and write a `.d.ts` that augments `WorkflowRegistry` (and `ActivityRegistry`) for cross-process IntelliSense.**

  **The shape:**

  ```bash
  bunx weft codegen \
    --server https://weft.internal:7233 \
    --token "$WEFT_TOKEN" \
    --out src/weft.generated.d.ts

  # Or with a config file:
  bunx weft codegen --config weft.config.json
  ```

  After running, the user's editor autocompletes against the _real_ set of workflows and activities running on that server, with `engine.start(name, input)` and `ctx.run(name, args)` typed end-to-end:

  ```ts
  // The generated file augments the module:
  declare module 'weft' {
    interface WorkflowRegistry {
      'order.checkout': { input: CheckoutInput; output: CheckoutOutput };
      'agent.research': { input: ResearchInput; output: ResearchOutput };
      // ...one entry per workflow registered on the server
    }
    interface ActivityRegistry {
      chargeCard: (input: ChargeInput) => Promise<ChargeResult>;
      reserveInventory: (input: ReserveInput) => Promise<ReserveResult>;
      // ...one entry per activity
    }
  }
  ```

  **Where:** New file `src/cli/codegen.ts`. New entry in the `CliCommand` discriminated union in `src/cli.ts:25-91`. New dispatch case in `src/cli-main.ts` alongside `serve`, `doctor`, `validate`, `timeline`, `schedule` (lines 31–128 of that file). The actual codegen logic likely lives in a separate module (`src/cli/codegen-emit.ts`) so it's testable independently of the CLI argument-parsing layer.

  **Dependencies:**

  This item is _gated by_ two other roadmap items:
  1. **Unified Operation Catalog → "Unify `WorkflowRegistration` / `ActivityRegistrationOptions` with the `OperationDefinition` shape"** — without `inputSchema` / `outputSchema` on workflows and activities, there's nothing to publish.
  2. **Type Generation → "Expose JSON Schema registries from the server"** — the _server-side_ discovery endpoint (e.g., `GET /v1/registry`) that this CLI consumes. The Type Generation item describes the registry endpoint in detail; this item is its CLI consumer.

  Don't start implementation until both are in flight. The CLI is the user-facing entry point of a three-piece system.

  **What to change:**
  1. **Argument parsing:** add `'codegen'` to the `CliCommand` union with fields `{ server: string; token?: string; out: string; configPath?: string; help: boolean }`. Plumb through `parseArgs` like the existing subcommands. Support a `--config <path>` flag that reads the same fields from a JSON or TS config file (mirrors `prisma generate`, `drizzle-kit`, `openapi-typescript`).
  2. **Registry fetch:** authenticate via the same token mechanism the JSON-RPC client uses (header in, scope-checked at the server). Fetch the registry document. Validate it against an expected shape (Zod, since the codebase already uses it).
  3. **Schema → TypeScript:** convert each workflow's `inputSchema` and `outputSchema` from JSON Schema to TypeScript via `json-schema-to-typescript` (well-maintained, exports clean types) or our own emitter if we want fewer deps. Same for activities.
  4. **Emit a single `.d.ts` file** with module augmentation as shown above. The file should:
     - Carry a header banner: `// Generated by weft codegen — DO NOT EDIT. Source: <serverUrl> at <ISO timestamp>`.
     - Be deterministic — same registry input always produces byte-identical output, so it's diff-friendly and CI-friendly.
     - Use `interface` (not `type`) for `WorkflowRegistry` and `ActivityRegistry` so user code can further augment them locally if needed.
     - Sort keys alphabetically for stable diffs.
  5. **Validate the result:** after writing, optionally run `tsc --noEmit` against the generated file and surface any errors. A schema that produces invalid TypeScript is a server-side bug — fail fast.
  6. **Watch mode:** `--watch` polls the server's registry endpoint (or subscribes to a registry-changed event if/when AsyncAPI lands one) and regenerates on change. Useful in dev, off by default.
  7. **Offline mode:** `--from <path-to-registry.json>` reads the registry from a local file instead of fetching. Lets users vendor the registry into source control for build-time codegen without a live server.
  8. **Help text and examples:** `weft codegen --help` shows the four primary forms (live server, config file, watch, offline) with examples. Match the existing CLI subcommand help shape.

  **Best practices the implementation must follow:**
  - **Generated file is in `.gitignore` by default in the docs example, but checked-in mode is also viable.** Both have legitimate use cases (CI freshness vs. reproducible builds). Document both; let the user pick.
  - **Codegen is a build step, not a runtime concern.** The generated `.d.ts` is types-only — zero runtime cost in the consumer's bundle.
  - **Idempotent writes.** If the regenerated file is byte-identical to the existing one, don't write it. Avoids spurious file-watcher cascades in dev environments.
  - **Auth follows the rest of the CLI's pattern** — token from `--token`, env var `WEFT_TOKEN`, or `~/.weft/credentials` if we add one. Consistent with how `weft serve` and `weft validate` do auth (audit those before deciding the conventions for this).
  - **Registry endpoint URL is configurable.** Default `${server}/v1/registry`, but `--registry-path` lets a user point at a custom mount.

  **Design questions to resolve:**
  - **Naming on the user-facing side.** `weft codegen` (matches `prisma generate`, `drizzle-kit generate`, `openapi-typescript`) or `weft typegen` (more specific to "TypeScript types") or `weft sync` (matches Hasura's `console-sync`)? Lean `codegen` — most common in the JS ecosystem, broadest mental model, leaves room for _other_ code-generation outputs later (Python types, Go types, OpenAPI clients, etc.).
  - **Output target language.** v1 is TypeScript only. The registry-as-JSON-Schema pattern would let `weft codegen --target python` or `--target go` work later — design the CLI flag for it now (`--target ts` default) but only ship the TypeScript emitter in v1.
  - **Multi-server support.** Some users will want to codegen against multiple Weft servers (e.g., a microservices topology where each service runs its own engine). Either:
    - (a) Run `weft codegen` once per server, output to different files. Simple. User merges the `.d.ts`'s in their tsconfig.
    - (b) `--server` accepts a comma-separated list, codegen merges into one `.d.ts`. More ergonomic.

    Lean (a) for v1 — simpler, matches how every other codegen tool handles multi-source.

  - **Where to publish the CLI.** Today `weft` is the package; the CLI is invoked via `bunx weft <subcommand>` or directly from `bun build --compile` output. Both work for `codegen`. No new package needed.

  **Why this matters:**
  - **Closes the cross-process type-safety gap.** The roadmap already has the local-typing story (inline annotations + `Engine<TRegistry>`). This is the missing piece for users whose client and server live in different repos, different deploys, or even different languages.
  - **Polyglot SDKs become trivial.** The same JSON Schema registry the TypeScript codegen reads can drive a `weft codegen --target python` later. JSON Schema is the universal interchange.
  - **Reduces the "did I spell the workflow name right?" production bug.** Today, `engine.start('chekout', ...)` (typo) is a runtime error in production. With codegen, it's a compile-time error in the developer's editor.
  - **Lines up with how the rest of the ecosystem ships type-safety.** `prisma generate`, `drizzle-kit generate`, `openapi-typescript`, `tRPC`'s inferred types — every modern data-layer tool has a codegen step. Weft having one too is unsurprising and immediately learnable.

  **Out of scope:**
  - **Generating client _implementations_** (typed proxies, RPC stubs). Just types — `engine.start(name, input)` and `ctx.run(name, args)` are still called via the existing API; codegen makes them typed, not auto-generated.
  - **Live-reload of generated types in the IDE.** Editors pick up `.d.ts` changes on save; that's a good-enough story for v1. Watch mode regenerates the file; the IDE handles the rest.
  - **Schema migration / versioning.** If the server's schema changes between codegen runs, the user's old code typechecks against the old schema and breaks at runtime. That's the same risk every API-codegen tool has; we don't try to solve it here.
  - **Cross-language emitters in v1** (Python, Go, etc.). Design the CLI flag to allow them; ship TypeScript only.

  **Sequencing:** This is the _user-facing entry point_ of the cross-process type-safety story. Sequence:
  1. Unified Operation Catalog → workflow/activity schemas at registration. (Foundation.)
  2. Type Generation → server endpoint exposing the registry as JSON Schema. (Producer.)
  3. **This item — `weft codegen` CLI.** (Consumer.)

  Do not start (3) until (1) and (2) are designed (not necessarily complete — the CLI's I/O contract just needs to be stable).

## Multi-Tenancy Documentation

There is no dedicated multi-tenancy guide. The README has a 12-line "Multi-Tenancy" section (lines 237–250) showing `tenantFromInputField` and `tenantQuotas` and stops there. The `documentation/guides/` listing (README lines 358–362) doesn't link to anything tenant-related because nothing exists to link to. References to tenants only appear _incidentally_ inside `documentation/guides/remote-workers.md` and `documentation/guides/interceptors.md`. For a feature this load-bearing — quotas, resolvers, isolation, agent-declaration tenant scoping (`agent-declaration.md` covers this), workflow-context tenancy (`api-context.md`) — that's a serious doc gap.

- [ ] **Write `documentation/guides/multi-tenancy.md`.**

  **Where:** New file `documentation/guides/multi-tenancy.md`. Update `documentation/reference/` index if there's a tenant-specific reference page worth pointing to.

  **What it must cover:**
  1. **Conceptual model.** What "tenant" means in Weft (a logical isolation boundary, not a physical one), how it relates to workflows, activities, agents, and storage. Lead with the mental model before any API.
  2. **Tenant resolution.** `tenantFromInputField`, custom `tenantResolver` functions, default-tenant behavior, what happens when resolution fails. Code examples for each.
  3. **Per-tenant quotas.** `maxRunningWorkflows`, `workflowCreationRateLimit`, storage quotas. Cover what's enforced where (quotas at start time vs. quotas during execution), what error surfaces when limits hit, and how to monitor tenant-level usage.
  4. **Tenant scoping in agents.** Cross-reference `documentation/agents/agent-declaration.md` — `toolsForTenant` is already mentioned there but the multi-tenancy guide should be the canonical home for the pattern. Show the per-tenant tool gating example.
  5. **Tenant context in workflows.** `ctx.tenant` (or whatever the surface is — verify), how it propagates to activities, how interceptors see it. Cross-reference `api-context.md`.
  6. **Storage isolation.** Whether storage backends are tenant-scoped by default, and how to enforce per-tenant data isolation (likely via `ScopedStorage` — `src/storage/scoped-storage.ts` already exists).
  7. **Multi-tenant deployment patterns.** Common topologies — single-engine multi-tenant (the default), per-tenant engines (heavier isolation), hybrid (shared engine, per-tenant storage). Tradeoffs of each.
  8. **Observability and auditing.** How tenant identifiers flow through events, traces, and metrics. How to filter logs/metrics by tenant.
  9. **Security boundaries.** What tenants _cannot_ see across each other (workflow data, signals, queries) and what they _can_ (engine-wide events, if any). Be explicit — this is a security claim.
  10. **Common pitfalls.** Resolver returning the wrong tenant, quotas hitting before user expects, cross-tenant signal injection bugs, debugging a "wrong tenant" production incident.

  **Cross-references the guide should establish:**
  - `documentation/agents/agent-declaration.md` — agent-level tenant scoping.
  - `documentation/reference/api-context.md` — tenant context on `ctx`.
  - `documentation/reference/api-engine.md` — `tenantResolver` / `tenantQuotas` engine options.
  - `documentation/reference/configuration.md` — config-driven tenant defaults.
  - `documentation/guides/remote-workers.md`, `documentation/guides/interceptors.md` — current incidental mentions should link back to the guide instead of duplicating.

  **Why this matters:** Multi-tenancy is the difference between "a workflow engine I can run for my one app" and "a workflow engine I can host as a service." For SaaS deployments, this is a top-three feature that prospective users evaluate. The README pitching it in 12 lines without a link to deeper docs is selling it short, _and_ it leaves operators flying blind on quotas, isolation, and security boundaries — exactly the things they need to be confident about before shipping a multi-tenant deployment.

  **Out of scope:**
  - Adding _new_ multi-tenancy features. Document what exists; gap items become separate roadmap entries.
  - Per-tenant pricing / billing primitives. Different concern; if it's surfaced via interceptors and metrics, the guide cross-references those.

- [ ] **Add a multi-tenancy link in the README's `documentation/guides/` listing and a one-line pointer at the end of the README's Multi-Tenancy section.**

  **Where:** `README.md` — the Multi-Tenancy section (around line 237) and the "Guides" listing in the Documentation section (around line 358–362).

  **What to change:**
  1. End the README's Multi-Tenancy code example with a one-line link: _"See [Multi-Tenancy guide](documentation/guides/multi-tenancy.md) for resolvers, quotas, isolation, and deployment patterns."_
  2. Add `[Multi-Tenancy](documentation/guides/multi-tenancy.md)` to the bullet list of Guides links in the README's Documentation section.

  **Sequencing:** Ships _with_ the guide above, in the same PR. A README link to a missing file is worse than no link at all. If the guide is delayed, the README change waits.

  **Out of scope:** rewriting the README's Multi-Tenancy code example. The example is fine as a quickstart; the guide is where the depth lives.

## Type-System Cleanup

- [ ] **🚨 Eliminate the `(ctx as Context)` cast pattern: widen `WorkflowContext` to be the full handler surface, not a "minimal" subset.**

  **Severity: high.** This isn't a stylistic nit — it's the project's _own type definitions_ requiring users to write `as` casts on the very first method they call. The codebase's TypeScript rules say _"Treat every `as` cast with suspicion. The pattern `as unknown as SomeType` is a red flag."_ Then `WorkflowContext`'s own JSDoc _prescribes_ `(ctx as Context).run(...)` as the documented usage pattern. The rule and the documented API are in direct conflict.

  **Where:** `src/core/types.ts:1228` (the `WorkflowContext` interface), `src/core/types.ts:1184-1227` (its JSDoc that documents the cast pattern), and `src/core/context.ts:610` (the `Context` class implementing it). Pervasive in JSDoc examples throughout `src/core/types.ts` and `src/core/context.ts` (every `(ctx as Context).run(...)`, `(ctx as Context).sleep(...)`, `(ctx as Context).agent(...)` snippet).

  **The bug:** `WorkflowContext` is intentionally narrow — it exposes only `workflowId`, `signal`, `executionTimeRemaining`, `startedAt`, `tenant`, plus the composition operators `pipe`, `map`, `reduce`, and `sessionState`. It does _not_ expose `run`, `sleep`, `waitForSignal`, `startChild`, `all`, `race`, `offload`, `archive`, `agent`, `setAttribute`, `stream`, `suspendUntil`, or any of the other methods that workflow handlers actually use 99% of the time. The full surface lives on the concrete `Context` class.

  When `engine.register('order', async function* (ctx, input) => ...)` types `ctx` as `WorkflowContext` (per the `WorkflowFunction` signature), calling `ctx.run(...)` _fails to typecheck_ — `run` isn't on `WorkflowContext`. So the user has to write `(ctx as Context).run(...)`. The library is effectively forcing every workflow author to bypass type safety on their most common operation.

  The JSDoc's stated rationale (`src/core/types.ts:1187-1208`) is that `WorkflowContext` is the "minimal context contract" — the readable subset useful for type-only access without pulling in the full class. That's a reasonable instinct for libraries with stable-vs-evolving distinctions, but the _cost_ — `as` cast on every handler — is way out of line with the value. The "minimal subset" should not exclude the operations users actually call.

  **What to change:**
  1. **Widen `WorkflowContext`** to include the full handler surface: `run`, `sleep`, `waitForSignal`, `startChild`, `all`, `race`, `offload`, `load`, `archive`, `agent`, `setAttribute`, `stream`, `suspendUntil`, `humanReview`, `memo`, `saga`, plus any other public methods on the `Context` class that workflows call. Each method's signature stays generic (`run<TResult>`, etc.) — the interface mirrors the class's public surface.
  2. **Verify `Context implements WorkflowContext` still holds** after the widening. The class should already satisfy it since it's the source of all these methods; just make sure no signature drift was hiding behind the previous narrow interface.
  3. **Remove every `(ctx as Context)` cast** from the codebase's JSDoc examples. Inventory:
     - `src/core/types.ts` — at least a dozen JSDoc examples currently use the cast (verified with grep).
     - `src/core/context.ts` — its own JSDoc has more.
     - Any other source file that documents `WorkflowContext` usage.
  4. **Remove every `(ctx as Context)` cast** from the user-facing documentation:
     - `documentation/guides/workflows.md` (line 222 — the child-workflows example, surfaced by the user).
     - `documentation/guides/activities.md`, `documentation/guides/signals-and-queries.md`, etc. — full audit pass.
     - Tutorial / example markdown elsewhere in `documentation/`.
  5. **Update the `WorkflowContext` JSDoc header** (`src/core/types.ts:1187-1227`) — remove the entire "for most operations, cast to `Context`" prescription. Replace with a one-liner: _"The context object every workflow handler receives. Includes all durable execution primitives (`run`, `sleep`, `waitForSignal`, etc.) plus identity (`workflowId`, `tenant`) and composition operators (`pipe`, `map`, `reduce`)."_
  6. **Decide whether `Context` (the class) needs to remain a separately exported name.** If `WorkflowContext` is now the full surface, users who today write `(ctx as Context)` will instead write nothing — `ctx` is already typed correctly. The `Context` class export becomes an implementation detail that escapes through the type system mainly for testing or advanced cases. Keep the export for backward-compat-of-imports (pre-release, but cheap), or remove it for hygiene. Lean toward keeping it — it's harmless and someone, somewhere, has typed `import { Context } from 'weft'`.
  7. **Add a lint rule** (or extend the type-safety lint rule from the "User-Provided Payloads" item) that flags any `as Context` cast inside a workflow handler. Catches regressions where someone copies an old example and the cast comes back.

  **Why this matters:**
  - **The library's first-class TypeScript story is broken on the most common operation.** Users typing `ctx.run(` get no autocomplete and a type error; the documented fix is a cast. That trains them to ignore type errors and reach for `as`. This is the worst kind of teaching moment.
  - **The user-facing example in `workflows.md` makes Weft look amateurish.** A reader landing there sees `as Context` in the child-workflow example and thinks "this library's types don't work right." First impressions matter.
  - **Internal inconsistency.** Project rules say `as` is suspicious; project's own examples use `as` everywhere. Pick a side. The right side is "the types should be correct so users never need to cast."
  - **Pre-1.0 hygiene.** Type design errors get baked into user code as it accumulates. Fix this before 1.0 and users never know it was broken; fix it after and you're explaining a breaking change.

  **Pairs with:**
  - The **Type-Safety on User-Provided Payloads** item — both are "the project's TypeScript surface contradicts the project's TypeScript rules; fix the surface." Same lint rule, same audit pass, ideally same PR.
  - The **Documentation → Hello World fixes** items — those audit `documentation/` for cast smells too. Coordinate.

  **Out of scope:**
  - Restructuring the `Context` class or adding new methods. Pure interface-widening to match what the class already exposes.
  - Renaming `WorkflowContext` or `Context`. The names are fine; the contract behind `WorkflowContext` is wrong.
  - Removing the JSDoc `@example` blocks. They stay; they just stop using `as Context`.

  **Sequencing:** Independent of all other items, but should ship before or alongside the Hello World docs cleanup. Once `(ctx as Context)` is gone from the type system, the doc audit becomes "remove the cast everywhere it appears" rather than "we still need the cast for X but not for Y" — much cleaner sweep.

- [ ] **Unify `activity()` to handle both bare-function and metadata forms; add a peer `workflow()` helper for symmetry; tighten the activity calling convention to single-input.**

  **Where:** `src/core/types.ts:1943` (existing `activity()` builder), `src/core/types.ts:654` (`ActivityFunction<TInput, TOutput>`), `src/core/engine.ts:9180` (runtime args-spread), `src/core/engine.ts:2473-2483` (`engine.register` overloads). New: a `workflow()` helper. Pervasive in JSDoc and `documentation/guides/activities.md`, `documentation/guides/workflows.md`.

  **Three intertwined problems, one unified fix:**

  **Problem A: Activity types and runtime disagree on calling convention.**

  `ActivityFunction<TInput, TOutput>` (`types.ts:654`) is `(input: TInput, context?: ActivityContext) => ...` — a strict two-parameter shape. But the engine invokes activities with `[...args, activityContext]` (`engine.ts:9180`) — user args are spread positionally, context appended. Single-arg activities work; multi-arg activities like `ctx.run(sendConfirmation, email, receiptId)` are typed as if `TInput` were a tuple `[string, string]`, called as three positional args, and the type system collapses the mismatch with `args.length === 1 ? args[0] : args` (`engine.ts:9163`). The types and runtime agree by accident.

  **Problem B: No ergonomic way to define an activity with type inference for the bare-function case.**

  Today's `activity({ name, execute, retry, ... })` requires the metadata-bundling shape — overkill for a quickstart activity. The bare-function alternative (`async (path: string, context?: ActivityContext) => ...`) requires explicit `ActivityContext` annotation on the second param, and there's no helper that infers the input/output types and _also_ registers the function as an activity.

  **Problem C: Workflows have no equivalent helper at all.**

  There's `engine.register(name, handler)` and `engine.register(name, { handler, version, migrate, searchAttributes, ... })` — two overloads on the registration call. But workflows can't be _defined_ (with their config) before registration the way activities can with `activity({ ... })`. The asymmetry creates an arbitrary distinction: activities are values you can pass around; workflows are inline arguments to `register`.

  **The unified fix:**
  1. **Switch the activity calling convention to single-input.** `ctx.run(sendConfirmation, { email, receiptId })` instead of `ctx.run(sendConfirmation, email, receiptId)`. `ActivityFunction<TInput, TOutput> = (input: TInput, context?: ActivityContext) => ...` becomes a _strict_ contract — runtime no longer spreads. Pre-release, no users, hard cut. Matches `OperationDefinition`, future MCP server, codegen story, and every RPC framework convention (gRPC, tRPC, MCP).

  2. **Overload `activity()` to accept both forms.** Same name, two signatures:

     ```ts
     // Form A: bare function — name inferred from variable / fn.name
     const greet = activity(async (input: { name: string }, ctx) => {
       return `Hello, ${input.name}!`;
     });

     // Form B: metadata-bundling — name explicit, with config
     const charge = activity({
       name: 'charge',
       retry: { maxAttempts: 5, initialBackoff: '1s', backoffMultiplier: 2, maxBackoff: '30s' },
       timeout: '30s',
       queue: 'payments',
       async execute(input: Order, ctx) {
         return await stripe.charges.create({ amount: input.total, signal: ctx?.signal });
       },
     });
     ```

     Both return the same shape — a callable function that's also an `ActivityDefinition`. Form A infers `name` from the function name (TypeScript hoists `const greet = ...` so `fn.name` is `"greet"`); Form B specifies it. Both satisfy the type contract; both work with `ctx.run`; both can be registered via `engine.registerActivity(fn)` _without a name string_ (it pulls from `fn.name`).

  3. **Add a peer `workflow()` helper.** Same overload pattern:

     ```ts
     // Form A: bare generator — name inferred
     const welcome = workflow(async function* (ctx, input: { name: string }) {
       const greeting = yield* ctx.run(greet, { name: input.name });
       return { greeting };
     });

     // Form B: metadata-bundling — version, migrate, searchAttributes, etc.
     const order = workflow({
       name: 'order',
       version: '2',
       searchAttributes: { customerId: 'string', status: 'string' },
       retention: { completed: '30 days' },
       async *handler(ctx, input: Order) {
         /* ... */
       },
       migrate(checkpoint, fromVersion) {
         return checkpoint;
       },
     });
     ```

     Both produce a `WorkflowRegistration`-shaped value. `engine.register(welcome)` (no name string) becomes the canonical registration form — name pulled from the workflow's own property. The string-name overloads of `engine.register` stay for backward-friendliness _to the new API_ (you can still write `engine.register('order', orderHandler)` if you prefer name-at-registration), but the docs lead with `workflow()` + bare-`register(workflow)`.

  4. **Tighten `engine.register` accordingly.** New primary overload: `engine.register(workflow: WorkflowDefinition): void`. Existing string-name overloads stay; their internal path validates that the bare handler form does _not_ already declare a name (no double-naming).

  5. **Update `documentation/guides/activities.md`** to lead with `activity(async (...) => {...})` (Form A) for the quickstart, and `activity({ name, execute, retry, ... })` (Form B) for configured activities. Remove inline `ActivityContext` annotations — Form A's inference makes them redundant.

  6. **Update `documentation/guides/workflows.md`** to lead with `workflow(async function* (ctx, input) {...})` (Form A), then `workflow({ name, version, handler, migrate, ... })` (Form B). The README's Hello World becomes:

     ```ts
     const welcome = workflow(async function* (ctx, input: { name: string }) {
       const greeting = yield* ctx.run(greet, { name: input.name });
       yield* ctx.sleep('1 hour');
       return { greeting, onboarded: true };
     });

     engine.register(welcome);
     ```

  7. **Update every multi-arg `ctx.run(fn, arg1, arg2, ...)` example** to single-input object form. Inventory:
     - `README.md` — the checkout example (`ctx.run(sendConfirmation, order.email, charge.receiptId)` becomes `ctx.run(sendConfirmation, { email: order.email, receiptId: charge.receiptId })`).
     - `documentation/guides/activities.md`.
     - `documentation/guides/workflows.md`.
     - JSDoc examples in `context.ts` and `types.ts`.

  8. **Lint rule:** flag `ctx.run(fn, a, b, ...)` calls with more than two arguments (the function plus a single input). Same lint scope as the payload-typing rule from the Type-Safety item.

  **Why this matters:**
  - **One name, one mental model.** Users learn `activity()` once; the bare-function form is the on-ramp, the options-object form is the upgrade. No `activityFn` / `activity` / `defineActivity` zoo. No "wait, which is the inference one and which is the metadata one?"
  - **Activities and workflows feel symmetric.** The library has activities and workflows as its two primary primitives. They should look like peers in the type system. `activity()` and `workflow()` as paired helpers is the obvious shape.
  - **The bare-`register(definition)` form drops the name-string redundancy.** When a user writes `const welcome = workflow(...)` and then `engine.register('welcome', welcome)`, the name appears twice. With name-on-the-definition, `engine.register(welcome)` is the clean form. (String-name overloads stay for the inline-handler case.)
  - **Single-input convention aligns activities with everything else.** `OperationDefinition`, MCP, codegen — all single-input. Closing this gap before 1.0 means activities aren't a special case forever.
  - **Type / runtime alignment.** Once the convention is single-input, the type signature can be strict (no `args.length === 1 ? args[0] : args` collapsing), and `ActivityFunction` fully describes how the engine actually calls it.
  - **Pattern matches the JS ecosystem.** Vue's `defineComponent`, Vite's `defineConfig`, Nitro's `defineEventHandler`, Nuxt's `definePageMeta`, Astro's `defineCollection` — every modern framework has a `defineX` pattern that does exactly this (overload accepting either a bare value or an options object). `activity()` / `workflow()` is Weft's version, just with shorter names.

  **Open design questions:**
  - **`activity` vs. `defineActivity` naming.** The existing API is `activity({ ... })` — short, already shipped. The ecosystem-standard name is `defineActivity`. Lean toward keeping `activity` since it's already public and the shorter name reads better at call sites. `workflow` follows the same shape.
  - **What if `fn.name` is empty?** Bare-function form `activity(async (...) => ...)` (anonymous arrow with no variable hoisting) has `fn.name === ''`. Either (a) require `name` in that case (throw at definition time), or (b) require the user to name the activity via `Object.defineProperty` / variable assignment. (a) is clearer; (b) is what TypeScript already enforces by default since `const x = ...` does set `fn.name`. Recommend (a) — clear error beats mysterious empty name.
  - **Should `workflow()` work with the `ctx.step()` (non-generator) form too?** Today `engine.register` accepts both `WorkflowFunction` (generator) and `StepWorkflowFunction` (async, uses `ctx.step`). `workflow()` should overload to accept either — same dispatch mechanism the existing `register` already uses.

  **Pairs with:**
  - **Type-Safety on User-Provided Payloads** — `activity()` and `workflow()` Form A handlers use inline parameter annotations on the input arg (no `as` cast). Same audit pass.
  - **Eliminate `(ctx as Context)`** — once `WorkflowContext` is the full surface, `workflow(async function* (ctx, input) { yield* ctx.run(...) })` typechecks without any cast.
  - **Unified Operation Catalog** — workflows and activities defined via `workflow()` / `activity()` carry their schemas inline (Form B), feed directly into the catalog as definition objects, and become the foundation for codegen / MCP tools.

  **Out of scope:**
  - Removing the existing `engine.register('name', handler)` string overload. It stays — it's the inline-quickstart form. New `workflow()` / `activity()` helpers are additive.
  - Renaming `ActivityFunction` / `ActivityContext` / `WorkflowFunction`. The underlying types stay; the helpers wrap them.
  - Generic typing of `ctx.run` — covered by the typed-`ctx.run` item in the Type Generation section.

  **Sequencing:** Should land _before_ the Unified Operation Catalog work — the catalog assumes single-input and assumes definitions are values you can introspect. After this item lands, `WorkflowDefinition` and `ActivityDefinition` _are_ those values, with all the metadata the catalog needs. Independent of everything else; can ship in one PR alongside the doc audit.

- [ ] **Add `signal()`, `update()`, `query()` helpers — typed handles for the message-shaped surfaces.**

  **Where:** `src/core/types.ts` (new exports), `src/core/context.ts:1975` (`onUpdate` and the corresponding `onQuery`), `src/core/engine.ts` (`engine.signal`, `engine.update`, `engine.query` — all currently take `payload: unknown`), `ctx.waitForSignal` (already generic but disconnected from the send side).

  **The problem:** Signals, updates, and queries are message-shaped — name + payload + (for update/query) a response. Today, each of those messages is an untyped string-keyed call:

  ```ts
  // Receive — already generic on the receiving end
  const approval = yield * ctx.waitForSignal<{ approved: boolean }>('approval');

  // Send — untyped, no compile-time check that 'approval' carries the right shape
  await engine.signal(handle.id, 'approval', { approved: true });

  // Update handler registration — payload is unknown
  ctx.onUpdate('approveOrder', async (payload) => {
    const { orderId } = payload as { orderId: string }; // ← cast smell
    return { status: 'approved' };
  });

  // Update from outside — also untyped
  const result = await engine.update(handle.id, 'approveOrder', { orderId: 'order-123' });
  ```

  Three concrete failure modes:
  1. **Receive vs. send shapes can drift silently.** A workflow expects `{ approved: boolean }`; the caller sends `{ approval: true }` (typo). Type system can't catch it.
  2. **Updates require a cast inside the handler.** `payload` is `unknown`; the user reaches for `as` (the project's TypeScript rules say to treat that with suspicion).
  3. **No typed return on update/query.** `engine.update(id, name, payload)` returns `Promise<unknown>`; the caller casts the result too.

  **The fix — typed handles for each message kind:**

  ```ts
  import { signal, update, query } from 'weft';

  // Signals: input-only, fire-and-forget
  const approval = signal<{ approved: boolean }>('approval');

  // Updates: input + output, request/response
  const approveOrder = update<{ orderId: string }, { status: 'approved' | 'rejected' }>(
    'approveOrder',
  );

  // Queries: input + output, read-only
  const orderStatus = query<{ orderId: string }, { state: string; updatedAt: number }>(
    'orderStatus',
  );
  ```

  Each helper returns a small typed value carrying the name and the input/output types. Handlers and senders both consume the handle:

  ```ts
  // Inside the workflow — receive side
  const result = yield * ctx.waitForSignal(approval);
  // result: { approved: boolean }

  ctx.onUpdate(approveOrder, async (input) => {
    // input: { orderId: string } — no cast
    return { status: 'approved' as const };
  });

  ctx.onQuery(orderStatus, (input) => {
    return { state: 'shipped', updatedAt: Date.now() };
  });

  // From outside the workflow — send side
  await engine.signal(handle.id, approval, { approved: true });
  // ✓ typechecked

  await engine.signal(handle.id, approval, { approval: true });
  // ✗ type error — wrong shape

  const result = await engine.update(handle.id, approveOrder, { orderId: 'o-123' });
  // result: { status: 'approved' | 'rejected' }
  ```

  **What to change:**
  1. **Add `signal<TPayload>(name)`** returning a `SignalHandle<TPayload>`. The handle carries `{ name, __payloadType: TPayload }` — name at runtime, type at compile time.
  2. **Add `update<TInput, TOutput>(name)`** returning an `UpdateHandle<TInput, TOutput>`.
  3. **Add `query<TInput, TOutput>(name)`** returning a `QueryHandle<TInput, TOutput>`.
  4. **Overload `engine.signal`** to accept either a string (legacy / untyped) or a `SignalHandle`. When given a handle, the third argument is constrained to `TPayload`. Same for `engine.update` and `engine.query`.
  5. **Overload `ctx.waitForSignal`** the same way. The current generic form (`ctx.waitForSignal<T>(name)`) still works; passing a `SignalHandle` infers `T` from the handle.
  6. **Overload `ctx.onUpdate` and `ctx.onQuery`** to accept either string + untyped handler or handle + typed handler.
  7. **Update docs:** `documentation/guides/signals-and-queries.md`, `documentation/guides/synchronous-updates.md`. Lead with the typed-handle form; the string-name form stays as the lower-level escape hatch.
  8. **Lint rule:** flag `engine.signal(id, '<string-literal>', ...)` calls and suggest defining a `signal()` handle. Same scope as the other type-safety lint rules.

  **Best practices the implementation must follow:**
  - **Handles are simple values.** Just `{ name: string }` plus a phantom type field. No runtime overhead. Serializable, importable across module boundaries, no factory state.
  - **Handles can be co-located with the workflow that uses them, or exported from a shared types file.** The latter is the typical pattern for cross-process scenarios — both the workflow code and the calling code import the same `approval` handle.
  - **String-name forms stay for backward-friendliness _to the new API_.** Pre-release means we could remove them, but the string form is also the right shape for dynamic / runtime-determined names — keep it as the escape hatch.

  **Open design questions:**
  - **Naming inside the workflow.** `ctx.waitForSignal(approval)` reads well. `ctx.onUpdate(approveOrder, handler)` does too. What about `ctx.onSignal(approval, handler)` for inline signal handlers? Today `ctx.waitForSignal` is the only signal-receive primitive; if we add a registration-style `onSignal`, the symmetry tightens but adds surface. Defer until users ask for it.
  - **Schema attachment.** Should `signal<{ approved: boolean }>('approval')` also accept an optional Zod schema for runtime validation? Lean yes — pairs with the unified-catalog work, since signals are part of the per-workflow contract. Form: `signal('approval', z.object({ approved: z.boolean() }))` with the type inferred from the schema if no explicit generic is provided.
  - **Should handles carry their _own_ `engine.signal` method?** `approval.send(handle.id, { approved: true })` reads even better than `engine.signal(handle.id, approval, { approved: true })`. But it requires the handle to know about the engine. Defer — pure types are simpler in v1; the bound-method version is a follow-up.

  **Why this matters:**
  - **Lifts a class of production bugs to compile time.** "I sent the wrong-shaped signal" is a real production incident shape — it's silent, it manifests as a workflow stuck waiting forever, and it's painful to debug. Typed handles make it impossible.
  - **Removes another `as` cast site.** `update`'s untyped payload was a load-bearing cast in every doc example. Goes away.
  - **Pairs with the cross-process codegen story.** Once schemas attach to handles (via the optional Zod option above), the codegen CLI can emit typed `SignalHandle` / `UpdateHandle` / `QueryHandle` values for cross-repo consumers. Same trick that produces typed `engine.start`.

  **Pairs with:**
  - **Type-Safety on User-Provided Payloads** — same instinct, same audit pass, same lint scope.
  - **Unified Operation Catalog** — signal/update/query schemas become part of the workflow's catalog entry. Codegen produces typed handles for cross-process consumers.
  - **Typed `ctx.run` / `engine.start`** — same pattern (registry-augmentation for cross-codebase, inline annotation for local). Signals/updates/queries should derive from the same registry once it exists.

  **Out of scope:**
  - Removing the string-name forms. They stay as the dynamic-name escape hatch.
  - Generic typing of `engine.list` (search-attribute filters) — covered by the next item (`searchAttribute()` helper).
  - Auto-generating handles from JSON Schema. That's the codegen item.

  **Sequencing:** Land alongside or after the `activity()` / `workflow()` unification. Same mental model, same audit window. Before the unified-catalog work — the catalog can then carry signal/update/query schemas as first-class fields rather than retrofitting them.

- [ ] **Complete the definition vocabulary: `searchAttribute()`, `interceptor()`, `constraint()`, `schedule()`, and rename `defineAgent` → `agent` for family symmetry.**

  **Where:** `src/core/context.ts` (`ctx.setAttribute`), `src/core/engine.ts` (`engine.list`, `engine.scheduleCreate`), `src/core/interceptor.ts` (interceptor type), `src/core/constraint.ts` (`ConstraintDefinition`), `src/ai/declaration.ts:222` (`defineAgent`). Pervasive in JSDoc and docs (`documentation/guides/search-attributes.md`, `interceptors.md`, etc.).

  **The pattern this completes:** the previous items establish `activity()`, `workflow()`, `signal()`, `update()`, `query()` as the way users define each primary primitive. The library has a few more primitives that should follow the same family pattern.

  **The five missing helpers:**

  ### `searchAttribute(name, type)` — typed search-attribute keys, three accepted forms, all converging on JSON Schema

  Today: `ctx.setAttribute('customerId', value)` and `engine.list({ attributes: [{ key: 'customerId', value: 'acme' }] })`. Both sides take strings, no type connection. The internal `SearchAttributeDefinition` (`src/core/types.ts:404-406`) uses a hand-rolled tag enum (`'string' | 'number' | 'boolean' | 'datetime' | 'keyword_list'`) — see the _"Replace `SearchAttributeDefinition` with JSON Schema"_ item below for the underlying cleanup.

  The helper accepts the type description in three forms, layered from simple to rich. **All three converge on JSON Schema internally** — the helper normalizes to JSON Schema before storage, indexing, and registry export.

  **Tier 1 — Bare JSON Schema primitive name (simplest, default for the 80% case):**

  ```ts
  import { searchAttribute } from 'weft';

  const customerId = searchAttribute('customerId', 'string');
  const orderValue = searchAttribute('orderValue', 'number');
  const isPriority = searchAttribute('isPriority', 'boolean');
  ```

  The second argument is one of `'string' | 'number' | 'integer' | 'boolean' | 'array' | 'object'` — **JSON Schema's own primitive type names**, not invented vocabulary. Sugar for `{ type: <name> }`. No validator dependency, no schema library, no ceremony.

  **Tier 2 — JSON Schema fragment (intermediate, for constraints without a validator dep):**

  ```ts
  const orderValue = searchAttribute('orderValue', { type: 'number', minimum: 0 });
  const status = searchAttribute('status', {
    type: 'string',
    enum: ['pending', 'shipped', 'delivered'],
  });
  const createdAt = searchAttribute('createdAt', { type: 'string', format: 'date-time' });
  const tags = searchAttribute('tags', { type: 'array', items: { type: 'string' } });
  ```

  Hand-written JSON Schema fragments. The indexer stores them directly; the TypeScript type is inferred from the fragment via a `JSONSchemaToType<T>` mapper. This tier replaces the legacy `'datetime'` (now `{ type: 'string', format: 'date-time' }`) and `'keyword_list'` (now `{ type: 'array', items: { type: 'string' } }`) — see the cleanup item below for the migration trace.

  **Tier 3 — Standard Schema (richest, for users already using Zod / Valibot / ArkType / etc.):**

  ```ts
  import { z } from 'zod';

  const status = searchAttribute('status', z.enum(['pending', 'shipped', 'delivered']));
  const tags = searchAttribute('tags', z.array(z.string()));
  const orderValue = searchAttribute('orderValue', z.number().nonnegative());
  ```

  Converted to JSON Schema via the same `toJSONSchema(schema)` helper used by the rest of the Standard Schema story (Zod via `zod-to-json-schema`, Valibot via `valibot-to-json-schema`, etc.). The TypeScript type is inferred via `StandardSchemaV1.InferOutput<typeof schema>`.

  **Usage is the same across all three tiers:**

  ```ts
  // Inside workflow
  ctx.setAttribute(customerId, input.customerId); // typechecked
  ctx.setAttribute(status, 'shipped'); // narrowed to the literal union (Tier 2 or 3)

  // From outside
  engine.list({ attributes: [{ key: customerId, value: 'acme' }] }); // typechecked
  ```

  Workflows that import these handles get their `searchAttributes` field auto-populated, regardless of which tier was used to declare them.

  ### `interceptor({ activity?, sleep?, ... })` — typed interceptor definition

  Today: users write `{ activity: ..., sleep: ... }` directly and the type ergonomics are ad-hoc. After the "Collapse `workflowInterceptors` / `activityInterceptors`" item lands, the unified `Interceptor` type exists but the definition surface has no helper.

  Fix:

  ```ts
  const tracing = interceptor({
    name: 'tracing', // optional — for observability
    activity(ctx, next) {
      // typed hook context, typed `next`
      return next(ctx);
    },
  });

  const engine = new Engine({ interceptors: [tracing] });
  ```

  Identity at runtime, full inference at the type level. Same shape as the other definition helpers.

  ### `constraint({ check, onViolation })` — typed constraint definition

  Today: `WorkflowRegistration.constraints?: ConstraintDefinition[]` — user writes inline objects.

  Fix:

  ```ts
  const totalUnderLimit = constraint({
    name: 'total-under-limit',
    check: (state) => state.total < 10_000,
    onViolation: 'fail',
  });

  const order = workflow({
    name: 'order',
    handler: ...,
    constraints: [totalUnderLimit],
  });
  ```

  Lower priority — constraints are advanced — but completes the family.

  ### `schedule({ workflow, cron, input, ... })` — typed schedule definition

  Today: schedules are created via `engine.scheduleCreate(...)` (per the CLI subcommands inventoried earlier). No way to _define_ a schedule as a value before creating it.

  Fix:

  ```ts
  const dailyReport = schedule({
    name: 'daily-report',
    workflow: reportWorkflow, // ← typed reference, input shape inferred
    cron: '0 9 * * *',
    input: { region: 'us-east-1' }, // ← typechecked against reportWorkflow's TInput
    overlapPolicy: 'skip',
  });

  await engine.scheduleCreate(dailyReport);
  ```

  Doubles as the cleanup point where the CLI's `weft schedule create --workflow X --cron Y` becomes a thin wrapper that loads a `schedule()` definition from a file.

  ### Rename `defineAgent` → `agent`

  Today: `defineAgent({ name, model, systemPrompt, tools, ... })` (`src/ai/declaration.ts:222`). Standalone naming, doesn't match the rest of the family.

  Fix: rename to `agent({ ... })`. Pre-release, hard rename. The agent is one of the primary primitives the library advertises (the README leans on it heavily) — it should sit alongside `workflow()` / `activity()` in the user's mental model, with matching shorthand.

  **What to change:**
  1. **Add `searchAttribute(name, type)` with three accepted forms** — JSON Schema primitive name (`'string'`, `'number'`, etc.), raw JSON Schema fragment, or Standard Schema (Zod / Valibot / etc.). All three normalize to JSON Schema internally; the TypeScript type is inferred from whichever form was used. Overload `ctx.setAttribute` and `engine.list({ attributes })` to accept either string keys (current, dynamic) or handles (new, typed). Depends on the _"Replace `SearchAttributeDefinition` with JSON Schema"_ item below for the underlying type cleanup.
  2. **Add `interceptor(spec)` as identity-with-inference.** Returns the same shape passed in; types narrow correctly. Optional `name` field for observability/tracing.
  3. **Add `constraint(spec)` similarly.** Identity helper; types narrow.
  4. **Add `schedule(spec)`** that produces a `ScheduleDefinition` ready for `engine.scheduleCreate`. Input type inferred from the workflow reference passed in.
  5. **Rename `defineAgent` → `agent` everywhere.** Source files, JSDoc examples, README, every doc page under `documentation/agents/`. Pre-release, hard rename.
  6. **Family-style docs page:** `documentation/reference/api-definitions.md` (or similar) showing all the helpers in one table — `workflow`, `activity`, `agent`, `signal`, `update`, `query`, `searchAttribute`, `interceptor`, `constraint`, `schedule`. Same shape, predictable mental model, link to the deep-dive guide for each.
  7. **Consistent JSDoc:** every helper's JSDoc follows the same template — what it does in one sentence, the bare-form example, the options-form example (where applicable), a cross-link to the deep guide.

  **Why this matters:**
  - **One vocabulary, one mental model.** A new user learns "Weft has primitives; you define them with a function named after the primitive." `workflow()`, `activity()`, `agent()`, `signal()`, `update()`, `query()`, `searchAttribute()`, `interceptor()`, `constraint()`, `schedule()`. Predictable. Discoverable. Memorable.
  - **Removes the last hand-rolled definition shapes.** Today the library is a mix of "use the helper" (activities), "options object on register" (workflows, agents — sort of), and "string-keyed plus untyped payload" (signals, updates, queries, search attributes). After this item, every primary primitive uses the same shape. Internal consistency.
  - **`defineAgent` → `agent` is the symmetry-breaking case.** It's already a definition helper in the right shape; just the naming is off-family. Cheapest rename in the roadmap, biggest mental-model payoff.
  - **Primes the codegen story.** Once every primitive is a value with a known shape, the codegen CLI can introspect the user's source code (or the runtime registry) and emit typed clients across all of them. `signal()` handles in particular show up in cross-repo scenarios where typed-message contracts pay off.

  **Open design questions:**
  - **Should the helpers live under one import path?** `import { workflow, activity, agent, signal, update, query, searchAttribute, interceptor, constraint, schedule } from 'weft'`. That's a lot of named exports from the main entry. Could be `import { define } from 'weft'` with `define.workflow(...)`, `define.activity(...)`, etc. — namespacing trades one import for one extra dot. Lean toward flat exports — the names are short, distinctive, and JS ecosystem precedent (Vue, Vite, Nitro, etc.) is flat.
  - **Should `agent` accept both bare (just a system prompt) and options forms?** The current `defineAgent({ name, model, ... })` is options-only. Activities and workflows have a bare form (`activity(async (i) => ...)`). Agents probably _don't_ — there's no minimal "just a function" form because an agent always needs at least a model and prompt. Keep options-only for `agent()`.
  - **Schedule: `engine.scheduleCreate(scheduleDef)` vs. `scheduleDef.create()`?** Same question as the bound-method version of `signal()`. Defer to follow-up if users ask.

  **Pairs with:**
  - **`activity()` / `workflow()` unification** — same family pattern; this item completes it.
  - **`signal()` / `update()` / `query()` typed handles** — same idea applied to message-shaped surfaces; this item is the next layer.
  - **Unified Operation Catalog** — search-attribute schemas, constraints, interceptor metadata all become catalog inputs once defined as values.

  **Out of scope:**
  - **`ctx.onSignal` registration helper.** Inline signal handlers don't exist as a primitive yet — `ctx.waitForSignal` is the only receive form. If users want fire-and-handle-immediately later, that's a separate addition.
  - **Removing the string-key forms** of `setAttribute`, `engine.signal`, etc. They stay as escape hatches for dynamic names.
  - **Renaming `defineAgent`'s underlying `AgentDefinition` type.** Type stays; only the helper renames.

  **Sequencing:** After `activity()` / `workflow()` and `signal()` / `update()` / `query()` land — those establish the pattern, this item completes it. The `defineAgent` → `agent` rename can ship independently and earlier; group it with this item only for doc-pass cohesion. Should ship before 1.0; after, every rename is a breaking change.

- [ ] **Thread Standard Schema through every definition helper. One declaration drives type inference, runtime validation, and JSON Schema export.**

  **Where:** Every definition helper added in the previous items — `workflow()`, `activity()`, `agent()`, `signal()`, `update()`, `query()`, `searchAttribute()`, `constraint()`, `schedule()`. Plus the existing tool-call surface in `src/ai/providers/types.ts` (which already accepts JSON Schema for tool inputs).

  **The keystone insight:** the previous items added type-only helpers — `signal<{ approved: boolean }>('approval')` carries a phantom type but no runtime info. Wiring Standard Schema through each helper turns one declaration into three artifacts: the TypeScript type (compile-time safety), the validator (runtime safety at boundaries), and the JSON Schema (registry export, codegen, polyglot SDKs). It's the missing piece that makes the unified vocabulary actually load-bearing.

  **What it looks like end-to-end:**

  ```ts
  import { z } from 'zod';
  import { workflow, activity, signal, update, query, searchAttribute } from 'weft';

  const OrderSchema = z.object({
    customerId: z.string(),
    total: z.number().positive(),
    items: z.array(z.string()),
  });

  const ChargeResult = z.object({ id: z.string(), amount: z.number() });

  // Activities — schema replaces the explicit generic
  const charge = activity({
    name: 'charge',
    input: OrderSchema,
    output: ChargeResult,
    async execute(input, ctx) {
      // input typed as z.infer<typeof OrderSchema> — no generic, no cast
      return await stripe.charges.create({ amount: input.total, signal: ctx?.signal });
    },
  });

  // Workflows — same pattern
  const order = workflow({
    name: 'order',
    input: OrderSchema,
    output: z.object({ orderId: z.string(), status: z.string() }),
    async *handler(ctx, input) {
      const result = yield* ctx.run(charge, input);
      return { orderId: 'o-123', status: 'charged' };
    },
  });

  // Signals — input-only
  const approval = signal('approval', z.object({ approved: z.boolean() }));

  // Updates — request/response
  const approveOrder = update(
    'approveOrder',
    z.object({ orderId: z.string() }),
    z.object({ status: z.enum(['approved', 'rejected']) }),
  );

  // Queries — read-only request/response
  const orderStatus = query(
    'orderStatus',
    z.object({ orderId: z.string() }),
    z.object({ state: z.string(), updatedAt: z.number() }),
  );

  // Search attributes — typed key + value validator
  const customerId = searchAttribute('customerId', z.string());
  const status = searchAttribute('status', z.enum(['pending', 'shipped', 'delivered']));
  ```

  Inside the workflow, every consumer reads its type from the schema:

  ```ts
  ctx.onUpdate(approveOrder, async (input) => {
    // input: { orderId: string } — inferred from approveOrder.input schema
    return { status: 'approved' as const };
  });

  await engine.signal(handle.id, approval, { approved: true });
  // ✓ shape validated at compile time AND at runtime when the engine receives it
  ```

  **The four wins:**
  1. **Runtime validation comes free.** `engine.start(order, input)` validates `input` against `order.input` before checkpointing. `ctx.run(charge, input)` validates against `charge.input`. `engine.signal(id, approval, payload)` validates against `approval.payload`. No more "the workflow crashed three steps in because the caller passed the wrong shape" — caught at the boundary, with a structured error pointing at the field.
  2. **JSON Schema for the registry endpoint comes free.** The Type Generation item's `GET /v1/registry` endpoint just calls `toJSONSchema(definition.input)` for every catalog entry. No separate `inputSchema` / `outputSchema` field on registration options needed — the schema _is_ the source of truth.
  3. **Codegen produces honest types.** Standard Schema → JSON Schema → emitted `.d.ts`. Round-trip preserves the shape; cross-process consumers get types that match the server's runtime contract.
  4. **The `as` cast disappears across the entire definition surface.** `signal<T>` and `update<TIn, TOut>` generics become unnecessary — the schema infers them. Inline parameter annotations on handlers become unnecessary — the schema provides the contextual type. One declaration, type and validation everywhere.

  **What to change:**
  1. **Pin to Standard Schema, not Zod.** `import type { StandardSchemaV1 } from '@standard-schema/spec'`. Zod, Valibot, ArkType, Effect Schema all conform. Don't lock users into one validator.
  2. **Add optional `input?: StandardSchemaV1` and `output?: StandardSchemaV1` (where applicable) to every definition helper.** When present, the helper's TypeScript signature uses `StandardSchemaV1.InferInput<typeof schema>` / `InferOutput<typeof schema>` to derive parameter and return types automatically.
  3. **Helper signatures use conditional types.** `activity({ name, input?, output?, execute })`:
     - If both `input` and `output` are present, `execute`'s parameters and return type are inferred from them.
     - If neither is present, fall back to TypeScript inference from `execute`'s annotated parameters (the current bare-function form).
     - If only one is present, the other comes from inference.
  4. **Validation hook in the engine.** When dispatching, check if the definition has a schema and call `schema['~standard'].validate(input)` (the Standard Schema dispatch). On failure, throw a structured `ValidationError` with the offending field paths. Activities, workflow starts, signals, updates, queries — same code path.
  5. **JSON Schema conversion.** Use a small `toJSONSchema(schema: StandardSchemaV1)` helper that delegates to the validator's own JSON Schema emitter (`zod-to-json-schema`, `valibot-to-json-schema`, etc.) based on which validator wrote the schema. The registry endpoint and codegen pipeline both consume this.
  6. **Tool-call alignment.** The existing tool-call surface (`src/ai/providers/types.ts`) takes JSON Schema directly for `inputSchema`. Add a parallel form that accepts Standard Schema and converts internally — same ergonomic improvement, same convergence on one validation story.
  7. **Update docs across the board.** Every guide that shows a definition helper should show the Standard Schema form as the recommended pattern. Inline-annotation form remains as the "no validation needed" minimum.
  8. **Lint rule:** suggest adding a schema to any `engine.start` / `engine.signal` / `engine.update` / `engine.query` call where the receiving side is reachable in source. (This is a _suggestion_, not an error — schema is opt-in.)

  **Best practices the implementation must follow:**
  - **Schemas are optional for purely-internal definitions.** A workflow that only the same codebase calls doesn't need a schema — TypeScript types are sufficient. Schemas are _required_ for anything crossing a process boundary (HTTP, MCP, codegen, polyglot SDKs). Document the heuristic.
  - **Validation is _on by default_ when a schema is provided.** Off by default for "no schema declared." There's no flag to disable schema validation when the schema exists — if the user declared the contract, the runtime enforces it.
  - **Validation errors are structured, not strings.** `ValidationError` carries `path`, `expected`, `received`, and the operation name. Surfaceable to OpenTelemetry, observability dashboards, and the structured fault catalog (the OpenRPC error-codes item in the Transport Schemas section).
  - **Schemas serialize via `toJSONSchema` lazily.** The registry endpoint computes JSON Schema on demand; engine-internal validation uses Standard Schema directly. No upfront conversion cost.
  - **Per-validator JSON Schema emitters are _peer dependencies_.** `zod-to-json-schema` is a peerDep, not a direct dep. Users who use Zod install it; users who use Valibot install `valibot-to-json-schema`. Pre-release, this is a clean cut; later we add detection logic so the right emitter loads automatically.

  **Open design questions:**
  - **Should we provide a `weft/schema` re-export of Standard Schema utilities?** Saves users one dep declaration. Probably yes — small ergonomic win, signals "we're committed to this story."
  - **What about complex output types that depend on input?** Today's `WorkflowFunction<TInput, TOutput>` allows generic relationships between input and output. A schema-based helper with a fixed output schema can't model "if input.kind === 'A', output is X; if 'B', output is Y." For those, fall back to inline TypeScript types and skip the output schema. Document the limit.
  - **Standard Schema's `~standard.types` field.** This is the property the spec uses for static type inference. We need to access it via `StandardSchemaV1.InferInput<S>` and `StandardSchemaV1.InferOutput<S>` everywhere we need to extract a type from a schema. Verify the inference helpers work cleanly with the validators we care about (Zod 3, Zod 4, Valibot 1.x).
  - **Validation timing.** Activity input validation: at `ctx.run(activity, input)` boundary or inside `executeOperation`? Same question for workflow input at `engine.start`. Recommend the latter — `executeOperation` is the single dispatch path; validating there means transports automatically participate. Pre-engine validation is a separate concern (catch _outside_ the engine).
  - **Should the catalog endpoint expose the schema _raw_ or only as JSON Schema?** JSON Schema is the right cross-language artifact; raw Standard Schema is TS-only and not serializable. JSON Schema only. Document explicitly so users don't expect to receive a Zod schema from `GET /v1/registry`.

  **Why this matters:**

  This item is the one that makes the previous items _worth doing_. `signal<{ approved: boolean }>('approval')` without a schema is a TypeScript convenience. `signal('approval', z.object({ approved: z.boolean() }))` is a contract — it's enforced at runtime, exported in the registry, codegen-able into other languages, and validated end-to-end. Same line of code, exponentially more value. **This is the load-bearing piece for the cross-process type-safety story.**

  Specifically:
  - **Eliminates the "schema vs. type" duplication problem.** Today, doing this right requires the user to declare types in TypeScript _and_ schemas in Zod _and_ keep them in sync. Standard Schema collapses them into one source of truth.
  - **The unified-operation-catalog item gets its `inputSchema` field for free.** Don't need a separate registration option — schemas live on definitions; catalog reads them off.
  - **The codegen CLI gets honest types.** Without runtime schemas, codegen would generate types from… what? Inline TypeScript inferred from handler signatures? That works for same-codebase consumers but breaks for polyglot. Standard Schema → JSON Schema → cross-language types is the only honest pipeline.
  - **MCP tool registration becomes consistent.** MCP tools require JSON Schema for `inputSchema`. Today, that's a separate declaration from the workflow's TypeScript types. With Standard Schema, the workflow's input _is_ the MCP tool's input. One declaration covers both.

  **Pairs with:**
  - **Every previous definition-helper item** — they all get the schema parameter.
  - **Unified Operation Catalog** — schemas become the catalog's `inputSchema` / `outputSchema` fields directly, no separate declaration.
  - **Type Generation → JSON Schema registry endpoint and codegen CLI** — those items consume what this item produces.
  - **MCP server (tool input schemas)** — workflow input schemas become MCP tool input schemas.
  - **Hydrate OpenAPI bodies** — same schemas drive the OpenAPI request/response body schemas.

  **Out of scope:**
  - Bundling a specific validator. Standard Schema means we don't pick.
  - Auto-converting JavaScript runtime types to schemas (some libraries do `inferSchema(typeof x)` magic). Users declare schemas explicitly.
  - Output validation that wraps the activity's return value — opt-in via the same `output?` field; off if not declared. No silent wrapping.
  - Migration path from existing schemas declared on `WorkflowRegistration.searchAttributes`. That field gets superseded by `searchAttribute()` handles + their schemas; the migration is a docs and registration audit, not new code.

  **Sequencing:** The keystone item. After `activity()` / `workflow()` unification, `signal()` / `update()` / `query()` typed handles, and the completion-pass helpers all land in their schema-less forms. Then this item adds Standard Schema as an optional field across every helper, in a single PR-ish surface. The unified-catalog item depends on this — schemas have to exist on definitions before the catalog can read them. The codegen CLI depends on this transitively.

- [ ] **Replace `SearchAttributeDefinition` with JSON Schema. Don't invent new vocabulary where the standard already has answers.**

  **Where:** `src/core/types.ts:402-406` (the `SearchAttributeValue` union and `SearchAttributeDefinition.type` tag), `src/core/types.ts:428` (`SearchAttributeSchema`), every internal site that branches on `'string' | 'number' | 'boolean' | 'datetime' | 'keyword_list'`, plus dashboard / list-API code that consumes the type tag.

  **The problem:** `SearchAttributeDefinition` is a hand-rolled type-tag enum that diverges from JSON Schema in three concrete ways:

  | Current term     | JSON Schema standard                           | Comment                                                                                                     |
  | ---------------- | ---------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
  | `'string'`       | `{ type: 'string' }`                           | Aligned. ✓                                                                                                  |
  | `'number'`       | `{ type: 'number' }`                           | Aligned. ✓                                                                                                  |
  | `'boolean'`      | `{ type: 'boolean' }`                          | Aligned. ✓                                                                                                  |
  | `'datetime'`     | `{ type: 'string', format: 'date-time' }`      | **Invented.** JSON Schema has no `'datetime'` type — it's a string with a format annotation.                |
  | `'keyword_list'` | `{ type: 'array', items: { type: 'string' } }` | **Invented.** Borrowed from Temporal/Elasticsearch jargon. JSON Schema's standard answer is a string array. |

  Two consequences:
  1. **It can't compose.** Want a status attribute that's one of three string literals (`'pending' | 'shipped' | 'delivered'`)? Can't say it — the type tag stops at `'string'`. Want a numeric attribute constrained to non-negative? Can't say it. Want a string with a min length? Can't say it. JSON Schema has all of these via `enum`, `minimum`, `minLength`, etc. — `SearchAttributeDefinition` has _only_ the type leaf.
  2. **It diverges from the rest of the schema story.** The Standard Schema item threads JSON Schema through every other definition helper. Search attributes being the lone holdout creates a "everything uses JSON Schema… _except_ this corner" pothole.

  **What to change:**
  1. **Replace `SearchAttributeDefinition` with a JSON Schema fragment.** The new shape:
     ```ts
     export type SearchAttributeDefinition = StandardSchemaV1 | JSONSchemaFragment;
     ```
     Either a Standard Schema (Zod / Valibot / etc.) which is converted to JSON Schema for storage and indexing, or a raw JSON Schema fragment for users who prefer to declare it directly. Both feed the same internal indexer.
  2. **Migration of internal type-tag branches.** Every site that today does `if (def.type === 'datetime')` becomes `if (def.format === 'date-time')` (or whatever JSON Schema property covers it). Inventory the call sites and migrate each.
  3. **Validation at ingestion.** `ctx.setAttribute(handle, value)` validates `value` against the schema. Today's hand-rolled type-tag check becomes JSON Schema validation. If the user passed a Standard Schema, validate via `schema['~standard'].validate(value)`; if they passed a raw JSON Schema fragment, validate via `ajv` (or whatever validator we choose) — pick one and stick with it.
  4. **Indexer storage format.** The storage layer indexes attributes by their _JSON Schema type_ (the standard `'string' | 'number' | 'boolean' | 'integer' | 'array' | 'object'`), not the legacy hand-rolled tag. This is the field that drives `engine.list` filter dispatch.
  5. **Dashboard / list-API alignment.** The list-API filter shape (`{ key, value, gt, lt }` at `src/core/types.ts:1481`) gains type narrowing from the JSON Schema. If the attribute is declared with `enum`, the value field accepts only the enum members. If it's `array`, range queries (`gt` / `lt`) error at compile time. JSON Schema is what _enables_ this narrowing.
  6. **Update the docs.** `documentation/guides/search-attributes.md` — lead with Standard Schema; show the JSON Schema escape hatch as the lower-level form. Replace every example using the old type tags.

  **Why this matters:**
  - **Don't invent vocabulary.** JSON Schema has been the lingua franca of cross-language type description for two decades. The five-term tag enum is friction without payoff — every reader who already knows JSON Schema has to learn the Weft-specific dialect.
  - **Composition is the win.** `z.enum(['pending', 'shipped'])` for a literal-union attribute, `z.string().min(1)` for non-empty strings, `z.number().int().nonnegative()` for IDs. The current type tag can't express any of these; JSON Schema (and any Standard Schema validator) can.
  - **Aligns with the rest of the schema story.** After the Standard Schema keystone item lands, _every_ primitive (workflow input, activity input, signal payload, update I/O, query I/O) is a Standard Schema. Search attributes being the one place that still uses a hand-rolled type tag is an inconsistency that confuses users learning the API.

  **Pairs with:**
  - **Standard Schema item** — same threading, same dispatch on `~standard.validate`. This item is its specialization for search attributes.
  - **`searchAttribute()` helper** in the completion-pass item — gets its schema from this item; the helper signature accepts a Standard Schema directly.
  - **Type Generation → JSON Schema registry endpoint** — search-attribute schemas show up there too, in the same form as workflow/activity schemas.

  **Out of scope:**
  - Changing the indexer's _physical_ storage format. The internal indexer already stores values keyed by their primitive type; this item just changes _what attribute description type-checks the input_ from a custom tag to JSON Schema. No data migration needed pre-release.
  - Adding query-DSL features (`gt` / `lt` on enums, etc.). Separate concern; this item just makes them _expressible_ in the type system.

  **Sequencing:** Should ship alongside or just after the Standard Schema keystone item. The `searchAttribute()` helper depends on this. Pre-release, hard cut — the old type tags go away in one PR.

- [ ] **🚨 Redesign `SharedState` from first principles: three named primitives (tenant, workflow-type, run), initial-value-at-construction, local change events, convenience methods.**

  **Severity: high.** Replaces an internally contradictory class (name promises cross-workflow sharing; parameter name and tests demonstrate single-workflow private state) with three primitives that each encode their scope in their name. The current API forces every user to choose what string to pass for `workflowId` — and the choice silently controls whether state is actually shared. Users get burned. The first-principles redesign makes the scope a structural property of the API rather than a footgun parameter.

  **Where:** `src/core/shared-state.ts` (the existing class becomes the underlying primitive), new entry points (likely `src/core/state.ts` or extension of context), `src/core/shared-state.test.ts`, `documentation/guides/shared-state.md`.

  **The current contradiction (worth recording):** Storage keys are `shared:${workflowId}:${stateKey}` (verified at `src/storage/interface.ts:455`). Two workflow runs each passing `ctx.workflowId` write to _two different storage keys_ and share nothing. Yet the class is named `SharedState`, the JSDoc claims cross-workflow sharing, and every test passes a single workflow ID. The class is genuinely capable of being shared, but only when callers pass a _non-workflow-id_ namespace string — and nothing in the docs hints at that.

  **The redesign — three named primitives, scope in the name:**

  ```ts
  // 1. Tenant-wide — every workflow in a tenant shares this state
  const apiBudget = tenantState<number>('api-budget', { initial: 1000 });
  // Storage key: state:tenant:${tenantId}:api-budget

  // 2. Workflow-type-scoped — every execution of a given workflow type within a tenant shares this
  const orderCounter = workflowTypeState<number>('order', 'daily-count', { initial: 0 });
  // Storage key: state:type:${tenantId}:order:daily-count

  // 3. Run-scoped — between a workflow execution and its children/concurrent branches
  const progress = ctx.runState<number>('progress', { initial: 0 });
  // Storage key: state:run:${ctx.workflowId}:progress
  ```

  Each helper has exactly the inputs it needs, no more. Tenant ID comes from the engine's tenant resolver (already present in the codebase). Workflow type comes from registration. Workflow ID comes from `ctx`. **No more "what string do I pass for `scope`?" question — the function name _is_ the scope.**

  The current `SharedState` class stays as the underlying primitive these helpers compose on top of. It also remains as an escape hatch for users who need a custom scope (a feature flag name, a non-standard partition key, etc.):

  ```ts
  // Escape hatch for custom scopes
  const featureFlag = new SharedState<boolean>(engine.storage, `feature:${flagName}`, 'enabled');
  ```

  **Initial value at construction (not on every `.get()` / `.update()`):**

  ```ts
  // Today (initial value passed at every call site — bug-prone)
  const counter = new SharedState<number>(...);
  const { value } = await counter.get(0);
  await counter.update((n) => n + 1, 0);
  await counter.update((n) => n + 1, 0);

  // After (initial value lives on the instance)
  const counter = tenantState<number>('api-budget', { initial: 1000 });
  const { value } = await counter.get();         // no initial needed
  await counter.update((n) => n - 1);            // no initial needed
  ```

  Move `initial` to the options bag. Every `.get()` and `.update()` reads the same initialization story; no risk of one site passing `0` and another `null`.

  **Three observation surfaces, one underlying event source. Instances `extend EventTarget` _and_ implement `[Symbol.observable]()` _and_ `[Symbol.asyncIterator]()` — each idiom for the consumers it fits:**

  ```ts
  // Surface 1 — EventTarget for named events (lowest-level, most flexible)
  counter.addEventListener('change', (event) => {
    /* event.previous, event.current, event.version */
  });
  counter.addEventListener('conflict', (event) => {
    /* event.attempt, event.maxRetries */
  });
  counter.addEventListener('exhausted', (event) => {
    /* event.error, event.attempts */
  });

  // Surface 2 — Observable interop for RxJS / Zen / TC39 observables
  const subscription = counter.subscribe({
    next: (value) => {
      /* handle value */
    },
    error: (err) => {
      /* handle error */
    },
    complete: () => {
      /* handle completion */
    },
  });

  // Or via library interop:
  import { from, map } from 'rxjs';
  from(counter)
    .pipe(map((n) => n * 2))
    .subscribe((doubled) => {
      /* ... */
    });

  // Surface 3 — Async Iterable for for-await-of consumption
  for await (const value of counter) {
    // handle each new value as it arrives
  }
  ```

  All three surfaces consume the same underlying event stream. `EventTarget` is the source of truth; the others are projections.

  **Three events fired on the EventTarget:**
  - **`'change'`** — after every successful write. Lets dashboards, telemetry, and observers react without polling. **Local-only**: the instance that did the write fires the event. Cross-process delivery requires a pub/sub layer (separate from this primitive — see "out of scope" below).
  - **`'conflict'`** — on each CAS retry. For users wiring contention metrics into their observability stack.
  - **`'exhausted'`** — when CAS gives up after `maxRetries`. Strictly more useful than the existing `SharedStateConflictError` throw because it lets observers see the error without try-catch around every call site.

  **Why all three surfaces:**
  - **`extends EventTarget`** — DOM-standard, available in every JS runtime, supports multiple distinct event types. Right for "I want to know when CAS retries" or "I want a dashboard to react to changes." Already in node, Bun, browsers, Web Workers.
  - **`[Symbol.observable]()`** — TC39 proposal stage, but the _de facto_ contract every reactive library already implements. Returns `{ subscribe(observer): { unsubscribe(): void } }`. Anything that calls `from(counter)` (RxJS), `Observable.from(counter)` (Zen), or polls for the symbol just works. **Implementing it costs almost nothing** — the `EventTarget` infrastructure already fires events; `subscribe` just wires a `change` listener that calls `observer.next(current)` and pushes the initial current value once on subscribe.
  - **`[Symbol.asyncIterator]()`** — increasingly idiomatic in modern JS. `for await (const value of counter)` reads naturally for users who want to consume the change stream as a sequence. Implementation is a small async generator over the `change` event.

  **The `Symbol.observable` ecosystem detail:** Native `Symbol.observable` isn't standardized yet. The de facto symbol used by RxJS and others is `Symbol.for('https://github.com/benlesh/symbol-observable')` (the value the `symbol-observable` polyfill provides). Implementation should use `Symbol.observable ?? Symbol.for('https://github.com/benlesh/symbol-observable')` so reactive libraries find us without us taking a runtime dep on the polyfill. Document this in the JSDoc.

  **Convenience methods over `.update()` (instead of a Proxy):**

  The Proxy idea (`counter.value++` translating to `.update(n => n + 1)`) was tempting but rejected — it hides the asynchrony, breaks compound expressions in race-condition-prone ways, and conflicts with `addEventListener`. Instead, ship typed convenience methods:

  ```ts
  // Numeric state
  await counter.increment();
  await counter.decrement();
  await counter.set(42);
  const value = await counter.get();

  // Object state
  await config.merge({ enabled: true });
  await config.set(newConfig);

  // Array state
  await queue.append(item);
  await queue.removeFirst();
  ```

  Each method visibly awaits, each is shorter than `update(fn)`, and each is type-safe based on `T`. **Async stays visible at the call boundary; mutations stay explicit.**

  **What to change:**
  1. **Rename the underlying class to make its role clear.** `SharedState` → something like `NamespacedState` or `AtomicState` (the class is _capable_ of being shared, but its job is namespaced atomic CAS, not "always shared"). Decide via the naming question below; not blocking the new helpers.

  2. **Add `tenantState<T>(key, options?)`** as a top-level export. Resolves the tenant ID from `engine.options.tenantResolver` at construction (or from `ctx.tenant` if called inside a workflow). Throws clearly if no tenant context is available — there's no sensible default for "tenant-wide state with no tenant."

  3. **Add `workflowTypeState<T>(workflowType, key, options?)`** as a top-level export. Scopes by `(tenantId, workflowType)` so two tenants running the same workflow type don't share state.

  4. **Add `ctx.runState<T>(key, options?)`** on `WorkflowContext`. Implicitly scopes to `ctx.workflowId`. This is the answer to the previous "should `scope` be optional?" — _don't make scope optional on the standalone class; provide a separate entry point with the scope baked in._ Replaces the proposed `ctx.sharedState(key)` from the prior version of this item.

  5. **Add `initial: T` to options on every entry point.** When provided, `.get()` / `.update()` use it as the default if no value has been written yet. When omitted, `.get()` returns `undefined` and the user handles the unset case explicitly (don't auto-default to `null` — that hides the "unset" state).

  6. **Implement events as `EventTarget` on each instance.** `change`, `conflict`, `exhausted` per the contract above. Local-only; document that explicitly. Cross-process change notifications are a separate concern — flag as a follow-up that pairs with the engine's existing event-feed infrastructure.

  7. **Add convenience methods:**
     - **Always:** `.get()`, `.update(fn)`, `.set(value)`, `.delete()`.
     - **For numeric `T`:** `.increment(by?)`, `.decrement(by?)`. Conditional on `T extends number`.
     - **For object `T`:** `.merge(partial)`. Conditional on `T extends Record<string, unknown>`.
     - **For array `T`:** `.append(item)`, `.removeFirst()`, `.removeLast()`. Conditional on `T extends unknown[]`.
     - All are sugar over `.update()`; the underlying CAS loop is identical.

  8. **Update tests.** The existing test suite passes `'wf-1'` everywhere — single-namespace correctness only. The new test suite must prove:
     - **Tenant-wide sharing works** — two workflows in the same tenant see each other's writes via `tenantState`.
     - **Tenant isolation works** — two workflows in different tenants don't see each other's `tenantState` writes.
     - **Type-scoped sharing works** — two runs of the same workflow type see each other's writes via `workflowTypeState`; runs of different types in the same tenant don't.
     - **Run-scoped sharing works** — parent and child workflows in the same family tree see each other's `ctx.runState` writes; sibling runs don't.
     - **Initial value semantics are correct** — `.get()` returns `initial` if no value written; `undefined` if no `initial` and no value written.
     - **Events fire correctly** — `change` after writes, `conflict` on CAS retry, `exhausted` when retries are exhausted.
     - **Convenience methods produce correct CAS behavior** — `increment` under contention is atomic, etc.

  9. **Rewrite `documentation/guides/shared-state.md`** to lead with the three named primitives, explain when to reach for each, and make the underlying `NamespacedState` (or whatever we rename it) clearly the escape hatch. Replace every `'wf-1'`-style example.

  10. **Audit related primitives for the same disease.** `offload`, `archive`, anything else that takes a `workflowId` parameter outside a workflow context. Same question: does the parameter name promise lifecycle behavior the implementation doesn't deliver?

  **Why this matters:**
  - **First-principles design.** The three sharing patterns are genuinely different — different scopes, different lifecycles, different correct mental models. Naming each one after its scope means users can't pick the wrong one accidentally. The function name _is_ the contract.
  - **Eliminates the silent failure mode.** Today: pass `ctx.workflowId` to `SharedState`, assume it's shared, ship code that has per-workflow private state, discover the bug in production. After this redesign: there's no "what string do I pass" choice — the API name encodes the answer.
  - **Initial-at-construction kills a duplication-bug class.** Today's "pass the initial value at every call site" pattern is an invitation to inconsistency. Centralized at construction, the value lives in one place.
  - **Events make the primitive observable without polling.** Critical for dashboards, telemetry, and any code that wants to react to state changes. Same `EventTarget` shape the rest of the codebase uses.
  - **Convenience methods make the right thing easy.** `counter.increment()` is shorter, more readable, and provably atomic compared to `counter.update(n => n + 1)` — without losing the explicit-async win that the rejected Proxy approach would have hidden.

  **Pairs with:**
  - **Multi-Tenancy Documentation** — `tenantState` is one of the things the tenancy guide should cover. Cross-link.
  - **Standard Schema item** — state values can carry an optional `schema` for validation on write. Add as a follow-up; not part of v1 of this item.
  - **Hello World docs cleanup** — same instinct: don't reference variables a reader can't trace back to their source.

  **Open design questions:**
  - **Naming the underlying class.** "SharedState" is misleading; replacements include `NamespacedState`, `AtomicState`, `CASState`, `KeyspacedState`. Lean `AtomicState` — most accurate (atomicity via CAS is the actual guarantee), shortest, and doesn't promise sharing the primitive doesn't always provide.
  - **Cross-process change notifications.** Local-only `change` events are sufficient for v1, but a future "subscribe to changes from any process" capability is a real production need. Probably wires through the existing engine event-feed infrastructure rather than the storage layer directly. Flag as a follow-up; not part of this item.
  - **Should `initial` be a function?** `tenantState('quota', { initial: () => computeDefault() })` allows lazy computation. Likely yes — small ergonomic win, no real cost, matches React's `useState` convention.
  - **Atomic deletion?** `counter.delete()` removes the state. CAS-on-delete (delete-if-version-matches) is the safe form. Worth shipping in v1.
  - **The Immer-style transactional draft.** Deferred per the prior question. Not in v1.

  **Out of scope:**
  - The Proxy form (`counter.value++` syntax). Rejected — hides asynchrony, breaks compound expressions in race-prone ways, conflicts with `addEventListener`. Convenience methods cover the ergonomic gap.
  - Cross-process change notification delivery. Local-only events for v1; cross-process is a follow-up that pairs with the event-feed infrastructure.
  - Automatic lifecycle binding (engine cleans up state when workflows terminate). Tenant- and type-scoped state explicitly survives workflow lifecycles. Run-scoped state may want auto-cleanup — flag as a question to resolve in implementation.
  - Schema validation on writes. Falls under the Standard Schema keystone item; adds a `schema?` option to each helper later.
  - The Immer-style transactional draft API. Deferred.

  **Sequencing:** This is the redesign that supersedes the previous "fix the misleading parameter name" item. Pre-release, hard cut — old `SharedState` shape goes away in one PR. The three new helpers ship together; the underlying class rename can be a follow-up.

## Polyglot Activity Workers (Path A)

**Architectural decision:** Workflows are TypeScript-only by design; activities are polyglot. This is a deliberate, load-bearing choice — locked in with the items below. The reasoning is recorded here so future contributors don't quietly drift toward Temporal-style "polyglot everything," which would require abandoning the checkpoint-not-replay model that defines Weft.

The core constraint: JavaScript generators are not serializable across processes. The checkpoint model — `structuredClone` semantics on local variables, position-in-generator as the resumption point — only works when the generator instance lives in a single process throughout its lifetime. That single process must be the engine. **Therefore: workflow code runs where the engine runs, full stop.** Activities, by contrast, are stateless RPC-shaped functions and _are_ portable across languages.

This gives Weft a narrower polyglot story than Temporal (where workers in any language run _both_ workflows and activities), but it's the honest position given the design. The pitch becomes: _"Write your workflows in TypeScript; write your activities in whatever your team uses."_

- [ ] **Formally specify the `RemoteWorker` wire protocol so SDKs in other languages can implement it.**

  **Where:** New `documentation/specifications/remote-worker-protocol.md` (or similar). Driven from the existing `src/worker/index.ts` (registration, task dispatch, heartbeat) and `src/server/json-rpc-websocket.ts` (the server side that talks to it).

  **The problem:** Today the wire protocol between the engine and `RemoteWorker` is _implicit_ — defined by what TypeScript objects get JSON-serialized at each end. There's no spec document, no conformance test suite, no machine-readable schema. A Python or Go author who wants to write an activity worker against a Weft engine has to read the TypeScript source to figure out the message shapes, copy them by hand, and hope future Weft releases don't change them silently.

  **What to change:**
  1. **Document the message envelope.** WebSocket frame = JSON object with a `type` discriminator. Inventory every message type across both directions:
     - **Worker → Server:** `register`, `heartbeat`, `task_complete`, `task_failed`, `task_progress` (heartbeat with details).
     - **Server → Worker:** `task` (dispatch an activity), `cancel` (abort an in-flight activity), `disconnect` (graceful shutdown).
     - For each, document the full payload shape, required vs. optional fields, and semantics (e.g., what an empty `headers` map means vs. omitted).

  2. **Document the lifecycle state machine.** Connect → register → idle → claim task → execute → report result → idle. What happens on disconnect mid-task. What happens when the heartbeat lapses. What `disconnectTimeoutMs` does. Reconnection semantics — does the server reissue tasks the worker had in flight, or assume they completed?

  3. **Document the framing.** WebSocket text frames carrying JSON-serializable values. Specifically: `Uint8Array` payloads need to be base64-encoded (or use the existing MessagePack content-negotiation if it's available on this transport — verify which). No assumed transparent binary support.

  4. **Document the authentication and authorization.** How the worker authenticates on connect (existing `bearerAuth` / `apiKeyAuth` schemes from `src/server/openapi.ts`). What scopes a worker needs. Whether a worker is tenant-scoped (must declare a tenant on connect, only receives that tenant's tasks) or tenant-agnostic (receives tasks for any tenant the connection is authorized for).

  5. **Document the activity contract.** Input validation, output validation, error shape (the `OperationFault` / `fault-to-json-rpc.ts` taxonomy), heartbeat semantics for long-running tasks, cancellation propagation (`AbortSignal` semantics — when a worker receives `cancel`, what does it do, what does the server expect to receive back).

  6. **Publish JSON Schema for every message type.** Same approach as the OpenRPC document for the JSON-RPC API — the message types live in a registry, and the schema is generated from the registry. Drift-prevention test mirroring `track8-discovery-parity.test.ts`: every message type the server emits or accepts must appear in the spec.

  7. **Conformance test suite.** A small test harness that any candidate SDK can run against to prove it's protocol-correct. Tests the lifecycle (connect → register → execute task → disconnect), error cases (malformed messages, missing fields, authentication failures), and edge cases (reconnect with in-flight task, heartbeat lapse, cancellation race). Ship it as a separate package or a CLI subcommand of `weft codegen`-style.

  8. **Versioning.** Declare a `protocolVersion` field in the `register` message. The server accepts a _range_ of compatible versions and rejects (with a clear error) a worker that's outside the range. This is how we evolve the protocol without breaking existing SDKs.

  **Best practices the spec must follow:**
  - **Stable on-the-wire field names.** TypeScript-side renames don't change the wire format. The wire format is the contract.
  - **Forward-compatible.** New message types or fields land as additions, never as renames or repurposings. Old workers should keep working against new servers (within the version range).
  - **Transport-agnostic where reasonable.** WebSocket is the v1 transport, but the message shapes shouldn't bake in WebSocket-specific assumptions. Future stdio or HTTP-streaming transports should be able to carry the same messages.
  - **No TypeScript types in the wire format.** Field names are `snake_case` (or `camelCase`, pick one and stick with it; consistent with the rest of the codebase's wire conventions). No `Map`, no `Set`, no `Date` — only JSON-serializable primitives plus base64-encoded bytes.

  **Why this matters:**
  - **Locks in Path A.** The architectural decision is real only if it's _implementable_ by other languages. Without a spec, "activities are polyglot" is aspirational. With a spec, it's a deliverable.
  - **Lets the ecosystem grow without our involvement.** Once the spec exists, anyone can build a Python `weft-worker-py`, a Go `weft-worker-go`, a Rust `weft-worker-rs`. Doesn't require any change to the TypeScript codebase per language. **The ecosystem story scales independently of our team.**
  - **Forces the existing implementation to be honest about its protocol.** Today the protocol is "whatever the TypeScript code happens to do." Writing the spec will surface places where the implementation has incidental quirks that should be either fixed or formally documented.

  **Pairs with:**
  - **Transport Schemas section** — same instinct (machine-readable contracts for every wire surface). Could share generator infrastructure with the OpenRPC / OpenAPI / AsyncAPI items.
  - **Codegen CLI** — once the spec exists as JSON Schema, `weft codegen --target python-worker` could emit a Python SDK skeleton that implements the protocol. Future item, not v1.

  **Out of scope:**
  - **Building the SDKs themselves.** This item is the spec. SDKs are downstream work, ideally community-driven.
  - **Workflow execution in other languages.** Path A explicitly excludes this. See the "Workflows are TypeScript-only" item below for the rationale.

  **Sequencing:** Should land _before_ any third-party language SDK work, obviously. Doesn't block anything else in the roadmap, but is foundational to the polyglot pitch. Probably sequenced after the Transport Schemas foundation items so the spec generator infrastructure can be reused.

- [ ] **Document "workflows are TypeScript-only by design" prominently across the docs and architecture pages.**

  **Where:** `README.md` (the "Design Constraints" or a new architecture-decision callout), `documentation/architecture/design-philosophy.md`, `documentation/architecture/checkpoint-versus-replay.md`, `documentation/contributing/architecture-decisions.md` (record this as a formal ADR).

  **The problem:** Readers coming from Temporal will reasonably assume that "if I write workflows in TypeScript today, I can write them in Python tomorrow when the Python SDK ships." That's how every other distributed-execution engine has trained them to think. Weft's design choice (checkpoint-not-replay) makes that _not true_, and the docs don't say so anywhere. A team that adopts Weft expecting eventual polyglot workflows will be unpleasantly surprised when the answer is "we're never going to do that."

  Worse: a future contributor without context could try to "fix" the limitation by adding a replay-based runtime, fragmenting Weft into two execution models that have to coexist forever. **Recording the decision now prevents the fragmentation later.**

  **What to change:**
  1. **Add an architecture-decision record (ADR).** New file `documentation/contributing/architecture-decisions/0001-workflows-typescript-only.md` (or wherever the existing ADRs live, if any). The ADR's content is _not_ "see the code" or "see the README" — it captures the full reasoning chain so a contributor encountering the constraint three years from now has the same context the original decision had.

     **The full reasoning the ADR must record:**

     **Status:** Accepted, locked-in for 1.0. Date of decision.

     **Context.** Weft is a durable-execution engine. The defining design choice is **checkpoint-not-replay**: at every `yield*` boundary in a workflow generator, the engine snapshots local variables via `structuredClone` semantics and persists the snapshot to storage. On recovery, the engine reconstructs a fresh generator instance, replays it forward to the snapshot's step index by feeding back recorded operation results, and then continues from there. This is the README's central architectural pitch — _"checkpoint model, not replay model"_ — and the reason `Date.now()`, `Math.random()`, dynamic imports, and arbitrary control flow all work without determinism constraints.

     **The constraint that follows.** Generators are not serializable across processes. `structuredClone` cannot clone a `Generator` object; `JSON.stringify` produces empty objects from them; there is no JavaScript primitive that lets you pause a generator on Process A, ship its iterator state to Process B, and resume it. The checkpoint contains the generator's _position_ (a step index, a number) and its _captured locals_ (variables in scope at the yield boundary), but the generator instance itself — the iterator that holds the runtime stack, the closure scope, the `await` continuation — lives in JavaScript memory in whatever process is driving it, and dies when that process dies.

     **The implication.** The engine has to drive the generator from start to finish _in one process_. When that process restarts, recovery means _constructing a new generator from the workflow function in the new process and replaying it forward to the checkpoint position_. The generator never crosses a process boundary. It can't.

     **Why this makes workflows TypeScript-only.** A polyglot workflow story would mean the same workflow's generator could be driven by a TypeScript engine, then a Python engine, then a Go engine, depending on which one had capacity. That requires shipping the generator's state across language boundaries. Even setting aside language compatibility (Python `async def` coroutines and JavaScript `async function*` generators have different state machines, different yield semantics, different exception-handling shapes), the _cross-language serialization of an in-flight execution_ is the part that cannot be done. The runtime state of an in-flight Python coroutine is not addressable from outside CPython; a JavaScript generator's continuation is not addressable from outside V8. There is no neutral protocol for "give me the current execution state of this in-flight function" because that would require every language runtime to expose its execution-state internals as a serializable artifact, and none of them do.

     Could we work around this? Three theoretical paths:
     - **Path B (replay determinism).** Abandon checkpoint-not-replay. Adopt Temporal's model: every workflow re-executes from the top on each "tick," replaying recorded operation results. Generators become stateless functions with respect to durability — the _history_ is the durable artifact, not the generator's snapshot. Polyglot workflows become possible because any worker in any language can re-run the workflow function from the top against a recorded history.

       _Rejected because_ this abandons the defining design choice. The README's pitch ("Your code can use `Date.now()`, `Math.random()`, dynamic imports, anything — because nothing replays") would become false. Determinism constraints would replace the current ergonomic story. We'd be reimplementing Temporal in TypeScript with worse Java-ecosystem support than the actual Temporal — there's no reason to prefer it over Temporal itself.

     - **Path C (separate state-store, workflows-in-workers).** Keep checkpoint-not-replay conceptually, but require workflows to run in dedicated worker processes (one per workflow type, or one per workflow run) that the engine talks to over RPC. The engine becomes a state-management service; workflow generators run in the workers. Different language workers could serve different workflow types.

       _Rejected because_ this loses the main advantage of checkpoint-not-replay. The whole point of the model is that the generator's state lives where the engine is, so checkpoints capture the actual generator position with no cross-process serialization. If the workflow runs in a worker, the worker would have to serialize the generator state across the boundary at every checkpoint — which it can't do, by the constraint above. This collapses Path C back into Path B.

     - **Path A (workflows in the engine, polyglot activities).** Workflow generators run in the engine process, which is TypeScript. Activities are stateless RPC-shaped functions, so they _are_ trivially portable across languages. A `RemoteWorker` in any language can connect to the engine, declare which activities it implements, and execute them as the engine dispatches them.

       _This is what we chose._ It's a narrower polyglot story than Temporal's but it's the honest one given the design.

     **Decision.** Path A. Workflow code is TypeScript-only. Activity code is polyglot via the `RemoteWorker` wire protocol (separate roadmap item).

     **Consequences.**
     - Weft is for teams whose primary backend language is TypeScript. Teams that need polyglot workflows should pick Temporal.
     - The activity story scales horizontally across languages without any engine changes. A Python team can write Python activities that connect to a TypeScript Weft engine.
     - The `bun build --compile` single-binary story stays clean — one binary, one language, the engine.
     - We must not later "soften" this by adding partial polyglot-workflow support. Doing so would either fragment the codebase (two execution models coexisting) or quietly abandon the checkpoint model. **Future contributors should reject proposals to make workflows polyglot.** The right answer is "use Temporal."

     **Forces this records, for future contributors.**
     - JavaScript generators are not serializable across processes. This is a property of the language, not of our implementation. It will not change.
     - The checkpoint model's ergonomic advantages (no determinism constraints, no `continueAsNew`, no replay overhead) all derive from the generator state living in one process. Anything that splits the generator across processes loses those advantages.
     - "Polyglot workflows" sounds like a feature gap from the outside. It is actually a different _product_. Trying to add it to Weft turns Weft into Temporal-but-worse.
     - The "single binary, every OS" pitch and the "polyglot server" goal pull in opposite directions. Adding polyglot workflows means giving up the single-binary story (you'd need one binary per language). We chose single-binary.

     **What stays open for evolution.**
     - The wire protocol for activities can be extended freely; new activity capabilities (streaming, bidirectional, etc.) don't touch this decision.
     - The engine's _internal_ execution strategies (`InlineExecutionStrategy`, `WorkerExecutionStrategy` in `src/core/`) can change — those are about thread-vs-process within a single TypeScript engine, not cross-language.
     - Storage backends, transport protocols, observability, agent features all evolve independently. None of those interact with this constraint.

  2. **Update `documentation/architecture/checkpoint-versus-replay.md`** to explicitly call out this consequence. The checkpoint model is _the reason_ workflows are TypeScript-only; readers should see those facts together, not separately.

  3. **Add a callout to the README's Design Constraints section.** One sentence under the existing constraints: _"Workflows run in TypeScript on the engine; activities can run in any language via the [RemoteWorker protocol](documentation/specifications/remote-worker-protocol.md). This split is intentional — the checkpoint model requires single-process generator state, so workflow code is TypeScript-only by design."_

  4. **Add a positioning section to the docs index or front page.** Short paragraph: _"Weft is for teams whose primary backend language is TypeScript. If you need workflows in multiple languages, Temporal is the right answer. If you're TypeScript-first and want a smaller, more ergonomic durable-execution engine that integrates with web standards and AI agents, Weft is for you."_ This is honest positioning that helps users self-select correctly and keeps Weft from being judged against a polyglot benchmark it isn't trying to meet.

  5. **Update the `Weft vs. Temporal` table in the README.** Add a row: _"Workflow language" → Temporal: "Any (Go, Java, TS, Python, .NET, Ruby, PHP)" / Weft: "TypeScript only (activities can be any language)."_ The honest comparison helps readers make informed decisions.

  **Why this matters:**
  - **Sets expectations before adoption.** Teams that need polyglot workflows shouldn't pick Weft and be surprised; teams that are TypeScript-first should know they're not signing up for the kind of workflow-language flexibility Temporal pitches. Honest positioning is a kindness.
  - **Locks in the architectural decision.** Without a documented ADR, the decision is a tribal-knowledge thing that erodes over time. Three years in, a contributor proposes a Python workflow runtime, no one remembers why we said no, and the codebase fragments. The ADR is the durable answer.
  - **Strengthens the actual pitch.** "We're TypeScript-only and that's a feature" is a stronger position than "we're polyglot, kind of, eventually maybe." The README's existing positioning leans into web standards and AI agents — both natural fits for a TypeScript-first runtime. Owning the constraint sharpens the message.

  **Pairs with:**
  - **The wire-protocol spec item above** — that item makes activities polyglot; this item makes the workflow constraint explicit. Same architectural decision, two halves of the doc story.
  - **The Hello World docs cleanup items** — same audit pass; the README is being rewritten anyway.

  **Out of scope:**
  - Renaming or restructuring Weft to make the TS-only nature _more_ obvious in the package itself (e.g., publishing as `@weft/typescript`). The `weft` package name is fine; the ADR is the right place for the constraint.
  - Building tooling that helps non-TS authors write activities. The wire protocol spec is sufficient; SDK authoring is downstream.

  **Sequencing:** Should ship in the same docs sweep as the wire-protocol spec. Pre-1.0; it's much easier to set positioning before users have adopted than to clarify it after.

## Agent Bureau Compatibility (First-Class Consumer)

**Architectural commitment:** Weft's first major consumer is **Agent Bureau** (`/Users/stevekinney/Developer/agent-bureau`), a TypeScript monorepo of focused packages for building AI agents. Agent Bureau will _consume_ Weft for durable execution, not the other way around. Critical structural consequence:

> **The dependency arrow goes Agent Bureau → Weft. Never the reverse.** Weft cannot import from `armorer`, `conversationalist`, or `interoperability`. A circular dependency would make both packages unpublishable, version-pinning impossible, and the build graph unresolvable. This is a hard structural constraint.

This means the goal isn't "make Weft compliant with Agent Bureau's types by importing them" (the original framing was wrong). The goal is: **design Weft's tool / tool-call / tool-result types as a minimal durable-execution contract that Agent Bureau's `interoperability` package can extend or compose on top of without translation friction.** Weft owns its narrow contract; Agent Bureau owns the richer agent-shape semantics; the surfaces are designed to compose cleanly.

The relevant Agent Bureau packages (which inform Weft's design but cannot be imported by Weft):

- **`interoperability`** — root of cross-package types within Agent Bureau (`JSONValue`, `ToolCall`, `ToolCallInput`, `ToolResult`, `ToolResultInput`, `ToolError`, `ToolErrorCategory`, `ToolAction`, `ToolActionInput`, plus hash and embedding utilities).
- **`armorer`** — tool registry (`createTool`, `createToolbox`, Zod-validated schemas, provider adapters for OpenAI / Anthropic / Gemini, MCP server integration, OpenTelemetry tracing, middleware for caching / rate-limiting / timeouts).
- **`conversationalist`** — conversation-state management (`Conversation`, `ConversationHistory`, immutable history with undo/redo, provider adapters, streaming-message helpers).

- [ ] **🚨 Design Weft's tool-and-conversation surface as a minimal durable-execution contract that Agent Bureau can compose on top of without translation friction.**

  **Severity: high.** Pre-1.0 commitment. Getting it wrong means Agent Bureau has to maintain ongoing translation between its richer types and Weft's parallel-but-different types — every change to either side becomes a coordination burden. Getting it right means the two packages compose: Agent Bureau's `interoperability.ToolCall` either _is_ Weft's `ToolCall` or _extends_ it as a structural superset, and the only translation needed is the kind that's already trivial (extension, not transformation).

  **Where:**
  - Weft side: `src/ai/providers/types.ts` (currently defines `ToolDefinition`, `ToolCall` shapes — these need to become the _minimal_ contract), `src/ai/agent.ts` (agent loop), `src/ai/declaration.ts` (`defineAgent`, becoming `agent()`), `src/core/types.ts`.
  - Agent Bureau side (read-only — informs design but not imported): `agent-bureau/packages/interoperability/src/types.ts`, `agent-bureau/packages/armorer/src/types.ts`, `agent-bureau/packages/armorer/src/is-tool.ts`, `agent-bureau/packages/conversationalist/src/`.

  **Three options considered for the integration shape:**
  - **Option A — Weft defines its types; Agent Bureau translates on consumption.** Each side has its own `ToolCall` etc., with translation at the boundary. Simple but creates ongoing translation burden as the types evolve. The kind of "two parallel type systems" friction that motivates the whole question.

  - **Option B — Hoist canonical types into a third neutral package.** Pull `interoperability` (or its types) into a standalone published package that _both_ Weft and Agent Bureau depend on. This is how TC39 proposals, Standard Schema, JSON Schema all coordinate — the shared contract lives in a neutral, versioned, narrow package that nothing depends on but everything imports. **Genuinely cleanest if the hoist is feasible**, but requires either (a) publishing `interoperability` as a separate package and rewiring Agent Bureau to consume the published version, or (b) accepting some restructuring of Agent Bureau's monorepo. Out of Weft's control.

  - **Option C — Weft owns a _minimal_ durable-execution contract; Agent Bureau extends it with richer semantics.** Weft defines just enough for "durably execute this thing": `JSONValue`, a minimal `ToolCall { id, name, arguments }`, a minimal `ToolResult { id, value | error }`. That's the durability contract — what has to be checkpoint-serializable, what crosses the worker wire protocol. Agent Bureau's `interoperability` defines the richer model (error categories, action types, validation reports, the full surface) by either _extending_ Weft's narrow types as structural supersets or _using_ Weft's types as fields within richer shapes.

    The boundary becomes clear: Weft owns the _durable-execution_ contract; Agent Bureau owns the _agent-shape_ semantics. No imports either direction; types are designed to compose structurally.

  **The decision: Option C.** It's the principled answer that respects the dependency direction. It also lines up with the Path A reasoning we just locked in for activities — Weft's value is durable execution, and the _transport contract_ for tool calls is small and stable; richer semantics (validation, policy, observability, provider adaptation) live in higher-level packages that consume the transport. Agent Bureau is exactly that "higher-level package."

  Option B remains a viable longer-term path if the `interoperability` hoist becomes practical, but Weft's design must be correct _under Option C_ regardless — the hoist is Agent Bureau's call, not Weft's.

  **What to change:**
  1. **Define Weft's minimal tool surface explicitly.** New file or revised `src/ai/types.ts` containing exactly the types Weft needs for durable execution:
     - `JSONValue` — the standard recursive JSON-safe type (matches `interoperability`'s shape so structural compatibility holds).
     - `ToolCall { id: string; name: string; arguments: JSONValue }` — minimal for "this is a tool call dispatched at a checkpoint boundary."
     - `ToolResult { id: string; value: JSONValue } | { id: string; error: ToolErrorShape }` — minimal success/failure for "this is what came back."
     - `ToolErrorShape { message: string; code?: string }` — minimal error info. Agent Bureau's `interoperability.ToolError` can extend with `category`, `retry`, etc.
     - `ToolDefinition { name: string; description?: string; inputSchema: JSONValue; execute: (input, ctx?) => Promise<JSONValue> }` — minimal for "this is a thing the agent can call."

     **The key constraint:** every field in these types must either match `interoperability`'s field name and shape _exactly_ (for fields they share) or be absent (for fields that are richer in `interoperability`). No renames, no incompatible shapes. This makes Agent Bureau's types _structural supersets_ of Weft's — `interoperability.ToolCall` automatically satisfies `weft.ToolCall` because it has every field Weft requires plus more.

  2. **Audit Weft's current tool / tool-call types** against the minimal contract above. Today Weft has `ToolDefinition`, `ToolCallback`, etc. — likely overshoots in some places (carries metadata that should be Agent Bureau's concern) and undershoots in others (missing fields the wire protocol needs). Prune to the minimum, rename to match `interoperability`'s field names where they overlap.

  3. **Coordinate field-name choices with Agent Bureau by reading, not importing.** Verify that Weft's `JSONValue`, `ToolCall.id`, `ToolCall.name`, `ToolCall.arguments`, `ToolResult.id`, `ToolResult.value` / `error` match `interoperability`'s field names exactly. If a name diverges (e.g., Weft has `params` where Agent Bureau has `arguments`), rename Weft's to match. The structural-superset property only holds if the field names line up.

  4. **Document the structural-superset contract.** New section in the agent docs explaining: _"Weft defines a minimal tool contract sufficient for durable execution. Agent Bureau's `interoperability` package defines a richer contract that is a structural superset — any value that satisfies `interoperability.ToolCall` also satisfies `weft.ToolCall`, and Agent Bureau code can pass its tool calls into Weft without translation."_ Show concrete examples.

  5. **Express the durable-execution-only nature via TypeScript widening helpers.** A small utility type that takes Agent Bureau's richer type and projects to Weft's narrow one without copying:

     ```ts
     // In Agent Bureau (not Weft):
     import type { ToolCall as WeftToolCall } from 'weft';
     import type { ToolCall as InteropToolCall } from 'interoperability';

     // Compile-time guarantee that interoperability extends weft's contract:
     const _check: WeftToolCall = {} as InteropToolCall;
     ```

     If this assertion ever fails, the contract has drifted. Agent Bureau's CI should run this check; Weft's design should make it always pass.

  6. **Conversation history shape.** Weft's agent loop checkpoints conversation state. The shape it stores must be JSON-safe (already required by the checkpoint model) and must be a _structural subset_ of `conversationalist.ConversationHistory` so Agent Bureau code can take Weft's persisted history and instantiate a `Conversation` from it directly. Don't import `conversationalist`'s type — define a minimal `ConversationHistory` shape in Weft that lines up structurally.

     The agent loop's running messages become this minimal `ConversationHistory`. On recovery, the engine reconstructs from the checkpoint. Agent Bureau code that wants undo/redo, branching, provider export, etc. wraps Weft's history in `new Conversation(history)` — pure structural composition, no translation.

  7. **Provider transport leaves Weft.** Per the AI Surface Shrinkage decision, Weft no longer ships `AnthropicProvider` / `OpenAIProvider` classes. Weft's agent loop accepts a structurally-typed `LLMProvider`-shaped object; the actual transport implementations live in `armorer` (tool-call shape) and `conversationalist` (message shape) or in user code. The structural shape is narrow enough that any `armorer`/`conversationalist` provider satisfies it without translation.

  8. **MCP integration alignment.** Weft's MCP server (when implemented) exposes Weft's narrow `ToolCall` shape. `armorer`'s MCP server, separately, exposes Agent Bureau's richer tool shape. Users who want both can run them side-by-side; users using Weft directly get the narrow version; users using Agent Bureau on top of Weft get the rich version via Agent Bureau's MCP integration. **Two MCP servers, two shapes, both correct, no overlap.**

  9. **Tests demonstrating the structural compatibility.** Weft adds tests under `test/agent-bureau-compat/` (or similar) that:
     - Import `interoperability` types as a `devDependency` only, in tests.
     - Assert at the type level that `interoperability.ToolCall extends weft.ToolCall`, `interoperability.ToolResult extends weft.ToolResult`, etc.
     - Pass `interoperability`-shaped values through Weft's APIs and assert they work without translation.

     `interoperability` is in `devDependencies` _only_ — used to verify the contract, never imported in source. Same as the SDK-types pattern from the AI Providers item.

  10. **Documentation.** New `documentation/integrations/agent-bureau.md` explaining the relationship: Weft is the durability layer, Agent Bureau is the agent framework that consumes it. Show the canonical setup. Link from the README. Make the "Weft + Agent Bureau" story explicit so users don't think they're choosing between them.

  **Best practices the design must follow:**
  - **No imports from Agent Bureau in Weft source.** `devDependencies` only, for type-compat tests. Source code in `src/` never imports from `armorer`, `conversationalist`, or `interoperability`.
  - **Structural compatibility, not nominal.** Weft's `ToolCall` and `interoperability.ToolCall` are _different types_ in different packages, but every value of the latter satisfies the former by virtue of having the same fields. Tests verify this; types stay independent.
  - **Field names must match exactly where they overlap.** `arguments` not `params`, `id` not `callId`, `name` not `tool`. This is the entire contract. If `interoperability` renames a field, Weft renames to match (or the tests fail). Coordination happens through the test, not through imports.
  - **Weft's version of each type is the _minimum_ sufficient for durable execution.** Don't overreach. If a field belongs in the agent-shape semantics (validation reports, retry hints, instrumentation tags), it's `interoperability`'s job, not Weft's.
  - **No translation layer.** If Agent Bureau code calls Weft with `interoperability` types and Weft has to convert before processing, the contract failed. The values flow through unchanged; the type system narrows on the way in (Weft sees only the minimal fields), widens back out (Agent Bureau code sees the original richer type since the value was never copied).

  **Open design questions:**
  - **Field-name resolution where Weft and `interoperability` currently differ.** If today's `weft.ToolCall` has fields named differently from `interoperability.ToolCall`, Weft renames. List the divergences during implementation and resolve each. Pre-release, hard cut on Weft's side.
  - **`interoperability` hoist (Option B).** If the Agent Bureau monorepo decides to publish `interoperability` as a standalone package down the road, Weft can switch from "structural compatibility verified by tests" to "shared dependency on the hoisted package." Lower-friction state to be in. Not Weft's call, but worth keeping the door open by not painting Weft into a corner that forecloses the hoist.
  - **Conversation history shape coordination.** `conversationalist.ConversationHistory` is richer than what Weft needs to checkpoint. Define the minimum and verify subset. May need to coordinate with Agent Bureau on which fields are _runtime-only_ vs. _persistence-relevant_ — Weft's checkpoint only needs the persistence-relevant ones.
  - **What happens when Agent Bureau adds a new field to `interoperability.ToolCall`?** If the field is optional, no Weft change needed (the structural superset is preserved). If it's required, that's a breaking change to the contract — Agent Bureau either adds it as optional (preferred) or coordinates a release with Weft. Document this as the contract's evolution rule.
  - **Test coordination cadence.** Weft's CI runs the type-compat tests against whatever `interoperability` version is in `devDependencies`. Agent Bureau's CI should ideally run an integration test against Weft. Aligning these means the contract is verified from both sides, but it requires some lightweight cross-repo coordination. Worth setting up before either side ships 1.0.

  **Why this matters:**
  - **Dependency direction is structurally non-negotiable.** Agent Bureau consumes Weft. Weft cannot import from Agent Bureau without making both packages unpublishable. The original framing of this item was wrong; this revised framing respects the constraint.
  - **Structural subset / superset is the right shape for layered protocols.** It's how every successful "narrow contract, rich extension" coordination in the JS ecosystem works (Standard Schema, JSON Schema, OpenAPI extensions, the Vue 3 + Pinia + Nuxt layer, etc.). Both sides own their types; the contract is verified at type-check time, not enforced via imports.
  - **Weft stays minimal.** Tools are an agent-framework concern; durable execution is Weft's concern. Defining only the minimum-viable tool contract keeps Weft's surface tight and makes it usable in non-agent contexts (workflows that happen to dispatch RPC-shaped operations, future use cases that aren't agent-shaped at all).
  - **Agent Bureau gets to evolve independently.** Adding a new tool-validation field, a new metadata kind, a new policy hook — none of those require Weft to change, as long as they're additive in `interoperability`. Loosely coupled, separately versioned, both win.

  **Pairs with:**
  - **All the AI-providers items** — provider transport restructuring is consistent with this; providers stay narrow, Agent Bureau adapts on top.
  - **Unified Operation Catalog** — Weft's narrow tool contract becomes one shape of catalog citizen. Agent Bureau's richer tools are a structural superset that the catalog also accepts.
  - **MCP server / client items** — Weft's MCP shapes are narrow; Agent Bureau's `armorer` MCP integration uses richer shapes; both can coexist.
  - **Standard Schema item** — Weft's `inputSchema` is JSON Schema (narrowest); Agent Bureau's tools use Zod-via-Standard-Schema (richer). Same pattern: Weft narrow, Agent Bureau rich.
  - **Path A (Polyglot Activity Workers)** — same instinct. Weft owns the minimal durable-execution contract; richer semantics live in higher-level packages that consume it.

  **Out of scope:**
  - Importing `armorer`, `conversationalist`, or `interoperability` in Weft source. Forbidden by the dependency-direction constraint.
  - Forking Agent Bureau types into Weft. The two packages have different lifecycles and different concerns; copying types creates the drift problem we're trying to avoid.
  - Re-implementing `armorer`'s middleware, `conversationalist`'s undo/redo, or any agent-shape semantics inside Weft. Weft does durable execution; Agent Bureau does agent shape. Separate concerns.
  - Forcing the `interoperability` hoist. That's Agent Bureau's call. Weft's design should be correct under Option C and _also_ compatible with Option B if it happens later.

  **Sequencing:** This is _load-bearing for every other AI-related item in the roadmap._ Should land _with_ the AI Surface Shrinkage cuts (same architectural commitment, applied to types and to module surface respectively), and _before_:
  - The `agent()` helper rename (so `agent()`'s `tools` field accepts the structural-compatible shape from day one).
  - The MCP server item (so the server exposes Weft's narrow `ToolCall` cleanly).

  Should land _with_:
  - The Standard Schema keystone item (Weft's tool input schema is JSON Schema; Agent Bureau's is Zod-via-Standard-Schema; both layer cleanly).
  - The unified-operation-catalog item (Weft's narrow tool contract is the catalog shape; Agent Bureau's richer one is a structural extension).

  Pre-1.0; this is the integration that defines what Weft + Agent Bureau looks like for the next several years.

- [ ] **🚨 Make Weft's `Storage` interface a structural superset of Agent Bureau's `KeyValueStore` so Agent Bureau can eventually drop its own storage abstractions and consume Weft's directly.**

  **Severity: high.** Agent Bureau today has its own `KeyValueStore` interface (`agent-bureau/packages/storage/src/types.ts`) with adapters for memory, SQLite, IndexedDB, Chrome storage, and remote-over-HTTP. The plan is for Agent Bureau to drop that abstraction and use Weft's `Storage` directly. **For that to work, Weft's `Storage` interface must support every operation Agent Bureau's storage primitives need.** This is a forward-looking design constraint on Weft's interface — get it wrong now, and either Agent Bureau can't consolidate or Weft has to break its interface to accommodate later.

  **Where:**
  - Weft side: `src/storage/interface.ts` (the `Storage` interface contract), `src/storage/scoped-storage.ts` (the existing namespacing helper), every adapter under `src/storage/`.
  - Agent Bureau side (read-only — informs design): `agent-bureau/packages/storage/src/types.ts` (the `KeyValueStore` interface), `agent-bureau/packages/storage/src/with-namespace.ts` (their namespacing helper), `agent-bureau/packages/storage/src/resolve.ts` (their backend resolver).

  **Concrete diff between the two interfaces today:**

  | Concept           | Weft `Storage`                                            | Agent Bureau `KeyValueStore`                   |
  | ----------------- | --------------------------------------------------------- | ---------------------------------------------- |
  | Value type        | `Uint8Array`                                              | `string`                                       |
  | Read              | `get(key): Promise<Uint8Array \| null>`                   | `get(key): Promise<string \| null>`            |
  | Write             | `put(key, value)`                                         | `set(key, value)`                              |
  | Delete            | `delete(key)`                                             | `delete(key)`                                  |
  | List              | `scan(prefix, opts): AsyncIterable<[string, Uint8Array]>` | `list(prefix): Promise<string[]>` (keys only)  |
  | Atomic batch      | `batch(ops)`                                              | (none)                                         |
  | Existence check   | `has?(key)`                                               | `has?(key)`                                    |
  | Prefix delete     | `deletePrefix?(prefix)`                                   | `deletePrefix?(prefix)`                        |
  | Close             | Via `Disposable`                                          | `close?()`                                     |
  | Namespace         | `ScopedStorage` wrapper                                   | `namespace?` option + `withNamespace()` helper |
  | Conditional batch | `conditionalBatch?` (CAS)                                 | (none)                                         |

  Aligned in spirit, divergent in surface. The value-type difference (`Uint8Array` vs. `string`) is the biggest. Method names diverge (`put` vs. `set`). `list` returns keys only, while `scan` is an async iterable of `[key, value]` pairs.

  **The path forward (locked in by this item): make Weft's `Storage` the structural superset.**

  The same instinct that drove the Agent Bureau Compatibility item: Weft owns the canonical contract; Agent Bureau's `KeyValueStore` becomes a _structural subset_ — every Weft `Storage` is automatically a `KeyValueStore` (via a thin adapter that handles `Uint8Array` ⇄ `string` if needed and renames `put` → `set`). When Agent Bureau drops its own abstraction, it imports Weft's `Storage` directly and the existing adapters retire.

  **What to change in Weft's `Storage` interface to support this:**
  1. **Audit every operation Agent Bureau uses on `KeyValueStore`** and verify Weft's `Storage` supports it cleanly. From the diff: every Agent Bureau operation has a Weft equivalent — but the equivalences need to be ergonomic, not just _technically_ possible.
     - `KeyValueStore.set(key, value: string)` → Weft `put(key, encode(value))`. Trivial wrapper. Verify the encoding overhead is acceptable for hot-path Agent Bureau use cases (skill metadata, identity records, scheduler state).
     - `KeyValueStore.list(prefix)` → Weft `scan(prefix)` then collect the keys. Slightly more work for the consumer than `list` was, but `scan` is strictly more capable. Decide whether to add a `keys(prefix): Promise<string[]>` convenience to Weft's interface to match the ergonomic of `list`.
     - `KeyValueStore.close()` → Weft's `Disposable`. Convergent — the disposable pattern is the more idiomatic JS one anyway.

  2. **Decide the value-type story.** Weft uses `Uint8Array` because it serializes engine-internal state (compressed checkpoints, MessagePack blobs). Agent Bureau uses `string` because it stores JSON-stringified records. Three options:
     - **(a)** Keep `Uint8Array` as the canonical value type; require Agent Bureau to encode strings into bytes on write and decode on read. A thin `withTextValues()` wrapper (like `ScopedStorage`) handles the encoding mechanically.
     - **(b)** Allow either `Uint8Array | string` as the value type, with the storage adapter handling both. Adds complexity to every adapter and weakens the contract.
     - **(c)** Add a parallel `TextStorage` interface alongside `Storage`, with the same shape but `string` values. Adapters can implement either or both.

     Lean **(a)**. Weft's existing storage backends are correct as-is; Agent Bureau pays a tiny encoding cost (`new TextEncoder().encode(s)` and the inverse) on each call. Encapsulate it in a wrapper so Agent Bureau code never sees the byte arrays. **The contract stays narrow; the ergonomic concern is solved by a wrapper, not by widening the interface.**

  3. **Add a `keys(prefix): Promise<string[]>` convenience method** (or document `scan` as supporting "keys only" via an option). This matches Agent Bureau's `list` and avoids forcing every Agent Bureau call site to adapt from `AsyncIterable<[k,v]>` to `Promise<string[]>`. Optional method, like `has` and `deletePrefix` — adapters can implement efficient versions where the backend supports it.

  4. **Verify namespacing parity.** Weft's `ScopedStorage` wraps a `Storage` and applies a key prefix. Agent Bureau's `withNamespace()` does the same for `KeyValueStore`. Once Agent Bureau is using Weft's `Storage`, `ScopedStorage` covers the use case. Verify the wrapper composes cleanly when stacked (e.g., `ScopedStorage(ScopedStorage(s, 'tenant-acme'), 'skills')`) — Agent Bureau's adapters likely use this pattern.

  5. **Verify all six of Agent Bureau's existing adapter shapes are reachable via Weft.**
     - `createMemoryKeyValueStore` → Weft has `MemoryStorage`. Direct equivalent.
     - `createSQLiteKeyValueStore` → Weft has `BunSQLiteStorage` and `NodeSQLiteStorage`. Direct equivalent.
     - `createIndexedDBKeyValueStore` → Weft has `IndexedDBStorage`. Direct equivalent.
     - `createRemoteKeyValueStore` (HTTP) → **Weft does not have a remote HTTP storage adapter.** This is a real gap. Agent Bureau's remote-over-HTTP is for client-server topologies (browser app talks to server-hosted storage). Decide whether Weft adds a `HTTPStorage` (or `RemoteStorage`) adapter, or whether this stays an Agent Bureau-side concern. **Recommend Weft adds it** — it's a natural shape for any storage-consuming library and complements Weft's existing remote-worker story.
     - Chrome storage → already tracked under the `WebExtensionStorage` roadmap item. Should ship before Agent Bureau migrates.
     - `'auto'` resolver — Agent Bureau's `resolveKeyValueStore({ type: 'auto' })` picks the right backend for the runtime. Weft could add a `resolveStorage()` helper that does the same. Worth shipping as an ergonomic convenience.

  6. **Add a structural-compat test.** Same pattern as the Agent Bureau type-compat tests: import `KeyValueStore` from `agent-bureau/storage` as a `devDependency`-only and assert at the type level that any Weft `Storage` (suitably wrapped for `Uint8Array` ⇄ `string`) satisfies `KeyValueStore`. Test in Weft's CI; failure means the contract has drifted.

  7. **Document the migration path.** New section in `documentation/integrations/agent-bureau.md` (the integration doc from the previous item): _"When Agent Bureau drops its `KeyValueStore` abstraction, here's how the migration works: (a) Weft `Storage` is the new canonical interface. (b) Agent Bureau's existing namespacing patterns transfer directly. (c) Per-call encoding from string to bytes is handled by the `TextStorage` wrapper. (d) Existing Agent Bureau adapters become thin wrappers around Weft's adapters until they're retired."_

  **Best practices the design must follow:**
  - **No imports from Agent Bureau in Weft source.** Same constraint as the previous item. `KeyValueStore` is a `devDependency`-only type-compat reference.
  - **Don't widen Weft's interface for Agent Bureau's convenience.** Weft's `Storage` is built around `Uint8Array` for good reasons (compressed checkpoints, binary serialization). Add wrappers (`TextStorage`, etc.) for ergonomic adaptation; don't add string-or-bytes union types to the core contract.
  - **Cover Agent Bureau's adapter list before Agent Bureau migrates.** All six adapter shapes (memory, SQLite, IndexedDB, Chrome storage, remote HTTP, auto) need Weft equivalents. Three exist; the others are tracked as separate roadmap items (`WebExtensionStorage` for Chrome; new `HTTPStorage` for remote-over-HTTP; `resolveStorage()` helper for auto).
  - **Prefix-keyed namespace remains the standard pattern.** Both libraries use colon-separated hierarchical keys (`tenant:acme:skill:pdf:metadata`). Weft's storage already supports this via `ScopedStorage` and `KEYS` helpers. Don't drift.

  **Open design questions:**
  - **`HTTPStorage` adapter design.** Agent Bureau's `createRemoteKeyValueStore` is a thin HTTP client (`baseUrl`, `headers`). Weft could match that shape, or design something richer (auth, retry, batching, server-side `conditionalBatch` support). Lean toward "match Agent Bureau's shape first, add features additively." Adapter should also work as the _server side_ via a Bun.serve route handler — natural pairing.
  - **Should Weft add `keys(prefix)` to the core interface, or document `scan` as the way to do it?** Adding it is one more method to implement on adapters; documenting `scan` is one more thing for Agent Bureau call sites to adapt to. Lean _add_: the storage interface is small enough that one more optional method doesn't bloat it, and the ergonomic gain for prefix-only lookups is real.
  - **Migration cadence.** Agent Bureau's storage package can't be dropped overnight — it's used by `armorer`, `lifecycle`, `memory`, `skills`, etc. The migration probably happens package-by-package over several Agent Bureau releases. Weft's job is to be ready _before_ the migration starts. Once Weft 1.0 ships with this item complete, Agent Bureau can begin.
  - **Agent Bureau's `KeyValueStoreConfiguration` shape.** Their resolver takes `{ type: 'memory' | 'sqlite' | ... }` discriminated unions. Weft's storage backends are constructed by hand (`new MemoryStorage()`, etc.). A `resolveStorage(config)` helper would let Agent Bureau migrate without rewriting their backend-selection logic. Worth shipping; not blocking.

  **Why this matters:**
  - **Forward-looking design constraint.** Once Weft 1.0 ships, the `Storage` interface is hard to change without breaking adapters. Designing it now to support Agent Bureau's needs avoids a future "Weft has to add X for Agent Bureau" coordination problem.
  - **Eliminates duplicate storage abstractions in the ecosystem.** Today: Agent Bureau has six adapters; Weft has six adapters; an Agent Bureau + Weft user has twelve adapters in their dependency tree (only six of them actually doing different things). After migration: one set, owned by Weft.
  - **Strengthens Weft's positioning.** Weft becomes "the storage interface for the durable-execution + agent ecosystem," not just "the storage interface for Weft." That's a much stronger ecosystem position — once Agent Bureau standardizes on Weft, other libraries in the agent ecosystem are likely to follow.
  - **Tests the type-compat pattern at scale.** This is the second use case (after the tool-types compat) for the "import as devDependency, verify structural compatibility, never import in source" pattern. If it works for storage, it scales to other shared abstractions.

  **Pairs with:**
  - **The Agent Bureau Compatibility item above** — same instinct, same dependency direction, same `devDependency`-only type-compat verification pattern.
  - **`WebExtensionStorage` item** — needed before Agent Bureau can drop their Chrome adapter.
  - **New `HTTPStorage` adapter** — needed before Agent Bureau can drop their remote adapter. Should be added to the Storage section as a separate item.
  - **`resolveStorage(config)` helper** — ergonomic match for Agent Bureau's `resolveKeyValueStore`. Should be added to the Storage section as a separate item.
  - **`weft/storage/sqlite` consolidation item** — already handles SQLite cross-runtime; complements this work.

  **Out of scope:**
  - Performing the Agent Bureau migration itself. This item makes Weft _ready_ for the migration; the migration is Agent Bureau's work.
  - Adding non-storage abstractions (vector stores, embedding stores, pub/sub, etc.) to Weft. If Agent Bureau eventually wants those unified too, that's separate items.
  - Backwards-compatibility wrappers in Weft for Agent Bureau's specific naming. The migration handles renaming on Agent Bureau's side; Weft's interface is canonical.

  **Sequencing:** Should land _with or before_ the Agent Bureau Compatibility item — the storage migration is deeper work than the type-compat work, but they share the same architectural commitment. Both pre-1.0; this item is what locks in Weft's storage interface as the canonical shape for the whole agent ecosystem.

- [ ] **Add `HTTPStorage` adapter for remote storage over HTTP.**

  **Where:** New `src/storage/http.ts`. New `weft/storage/http` subpath in `package.json` `exports`. Server-side route handler likely lives in `src/server/operations/storage-*.ts`.

  **The gap:** Weft has SQLite, LMDB, Turso, IndexedDB, Memory, and (planned) WebExtension storage adapters. It does not have a _remote-over-HTTP_ adapter — for client-server topologies where a browser app or a worker talks to a Weft server's storage backend without direct database access. Agent Bureau has this (`createRemoteKeyValueStore`), and the Agent Bureau storage migration depends on Weft having an equivalent.

  **What to change:**
  1. **Implement `HTTPStorage` against `Storage` interface.** Plain `fetch()` calls to a known REST or JSON-RPC surface. `get` → `GET /storage/{key}`, `put` → `PUT /storage/{key}`, etc. Or wrap the existing JSON-RPC API. Decide based on which is simpler to standardize.
  2. **Authentication.** Same scheme as the rest of Weft's HTTP surface (`Authorization: Bearer ...`, API key headers).
  3. **Server-side route handler.** Companion piece — Weft's server exposes the storage endpoints that `HTTPStorage` consumes. Likely a thin route under `/v1/storage/*` that proxies to the engine's underlying `Storage`. Authorization-scoped per tenant.
  4. **Streaming for `scan`.** Server returns a stream of `[key, value]` pairs (NDJSON or chunked transfer). Client consumes as `AsyncIterable`.
  5. **Conditional batch over the wire.** `conditionalBatch` semantics translate to a structured POST that the server applies atomically. Required if Weft wants `SharedState`-style CAS to work over remote storage.

  **Out of scope:**
  - Pub/sub for `'change'` notifications across remote clients. Separate, larger concern; tracked alongside the SharedState observable interface.

  **Sequencing:** Required _before_ the Agent Bureau storage migration. Otherwise paired with the Storage section's other items.

- [ ] **Add `resolveStorage(config)` helper for runtime-driven backend selection.**

  **Where:** New `src/storage/resolve.ts`. Top-level export from `weft`.

  **The gap:** Today, Weft users construct backends explicitly (`new BunSQLiteStorage('./weft.db')`). Agent Bureau has a `resolveKeyValueStore({ type: 'auto' })` helper that picks the right backend for the runtime. Useful pattern, missing from Weft.

  **What to change:**
  1. `resolveStorage(config: StorageConfiguration): Storage` returning the appropriate adapter. Discriminated-union config shape:
     ```ts
     type StorageConfiguration =
       | { type: 'memory' }
       | { type: 'sqlite'; path: string }
       | { type: 'lmdb'; path: string }
       | { type: 'turso'; url: string; authToken?: string }
       | { type: 'indexeddb'; databaseName?: string }
       | { type: 'webextension'; area?: 'local' | 'sync' | 'session' | 'managed' }
       | { type: 'http'; baseUrl: string; headers?: Record<string, string> }
       | { type: 'auto' };
     ```
  2. `'auto'` mode picks based on runtime detection (Bun → `BunSQLiteStorage`, Node → `NodeSQLiteStorage`, browser → `IndexedDBStorage`, extension → `WebExtensionStorage`).
  3. Each adapter is lazy-imported only when its config type is selected — preserves the per-adapter subpath tree-shaking story.

  **Out of scope:**
  - Config parsing from environment variables or config files. Pure programmatic helper.

  **Sequencing:** Cheap convenience. Pairs with the Agent Bureau storage migration. Independent otherwise.
