# Checkpoint, Don't Replay

This is the single most important architectural decision in Weft---the one that shapes everything else.

Temporal recovers workflows by _replaying_ them. When a workflow needs to resume after a crash, Temporal re-executes the entire function from the beginning, feeding in recorded results from an event history to fast-forward through completed steps. The more steps a workflow has completed, the longer recovery takes. This is O(n) recovery, and it brings with it a cascade of constraints that touch every part of your development experience.

Weft takes a different path. Instead of replaying, Weft _checkpoints_. At each `yield*` boundary, the engine snapshots the workflow's current state---all local variables, the current position in the generator---and persists it. On crash, Weft loads that snapshot and resumes from exactly where it stopped. One read, one resume. O(1) recovery, regardless of whether the workflow has completed 10 steps or 10 million.

## How it works

Workflows in Weft are `AsyncGenerator` functions. Each `yield*` is a checkpoint boundary. The engine captures the state at that boundary using a MessagePack codec with structuredClone-compatible semantics---the same serialization algorithm browsers use for `postMessage`.

```typescript partial
export async function* orderWorkflow(ctx: Weft.Context, order: Order) {
  const payment = yield* ctx.run(charge, order); // checkpoint 1
  const shipment = yield* ctx.run(ship, { order, payment }); // checkpoint 2
  return { payment, shipment };
}
```

If the process crashes after checkpoint 1, Weft loads the snapshot, sees that `payment` already has a value, and picks up at the `ship` call. The `charge` function never re-executes. There's no event history to walk through, no replay logic, no determinism constraints.

## No determinism requirement

This is where Weft diverges most sharply from Temporal's developer experience.

Temporal's replay model means your workflow code must be _deterministic_. If `Date.now()` returned a different value on replay than it did on the original execution, the replay would diverge and crash with a `DeterminismViolationError`. So Temporal's TypeScript SDK intercepts and replaces `Date.now()`, `Math.random()`, `WeakRef`, `FinalizationRegistry`, and more. It bundles workflow code through Webpack to create a sandboxed environment. You write what looks like normal TypeScript, it works in tests, and then it explodes in production during replay with inscrutable error messages.

Weft doesn't replay. So there's no determinism requirement at all. Use whatever you want:

- `Date.now()`---go ahead, it won't be replayed.
- `Math.random()`---no deterministic replacement needed.
- `WeakRef` and `FinalizationRegistry`---Weft actually _depends_ on these internally for memory management. The primitives Temporal bans are the ones Weft needs.
- Any npm package, any Node API, `console.log`, `debugger` statements---all fine.

The only rule is `yield*` for durable operations. That's it.

## What structuredClone can and cannot serialize

Since checkpoints use a MessagePack codec with structuredClone-compatible semantics, there are boundaries on what can live in your workflow's local variables at a `yield*` point.

**Can serialize:** primitives, plain objects, arrays, `Date`, `Map`, `Set`, `RegExp`, `ArrayBuffer`, `TypedArray`.

**Cannot serialize:** functions, closures, class instances with methods, Symbols, `WeakMap`, `WeakRef`, or system resources (sockets, file handles).

The practical implication: keep your local variables as plain data at yield boundaries. If you need an API client, store the configuration (a URL string, an API key) and reconstruct the client after resumption---don't try to checkpoint the client object itself.

## Development mode catches mistakes early

The most common bug Weft developers will hit is accidentally putting a non-cloneable value into their checkpoint state. In Temporal, you discover this at replay time in production. In Weft, development mode catches it immediately.

```typescript partial
const engine = new Engine({
  storage: new MemoryStorage(),
  development: true,
});
```

When `development` is `true`, the engine serializes and deserializes the checkpoint at each boundary and compares the result. If they diverge, it emits a `DevelopmentWarningEvent` with the exact field paths that diverged, the values on each side, and a suggestion for how to fix it.

```
CheckpointSerializationError: Cannot serialize workflow state at step 2

  The value at path "locals.apiClient" is a class instance with methods.
  structuredClone cannot serialize functions or class instances.

  Value: ApiClient { baseUrl: "https://api.stripe.com", ... }

  Fix: Move the ApiClient creation inside ctx.run() or store only the
  configuration data (e.g., { baseUrl: "https://api.stripe.com" }) in
  local variables and reconstruct the client when needed.

  at orderWorkflow (./workflows/order.ts:15:3)
```

That error message tells you _what_ went wrong, _where_ it went wrong, and _how_ to fix it. You see it the moment you run your workflow in development, not three weeks later when a production node restarts.

## No history growth, no continueAsNew

Temporal's event history grows linearly with every activity, timer, and signal. At roughly 50,000 events, you must call `continueAsNew()`---which restarts the workflow, destroying all local variable state and requiring manual serialization of everything you want to carry forward. Signal handlers must be re-registered. Child workflow references must be re-established. This isn't an edge case; any workflow that loops (subscriptions, monitoring, batch processing) hits this limit.

Weft's checkpoint is a constant-size snapshot of the current state. It doesn't grow with workflow history length.

```
Temporal: history size grows linearly with activity count
  10 activities  →  ~1K events  →  ~100KB history
  1K activities  →  ~10K events →  ~1MB history
  50K activities →  ~50K events →  LIMIT HIT, must continueAsNew

Weft: checkpoint size is constant regardless of history
  10 activities  →  ~2KB checkpoint
  1K activities  →  ~2KB checkpoint
  1M activities  →  ~2KB checkpoint (same locals, same size)
```

A workflow can run for years, execute millions of activities, and its checkpoint stays the same size as it was after the first `yield*`. There is no history limit, no `continueAsNew`, no manual state serialization. Long-running workflows just run.

## Payload efficiency

Temporal stores every activity input and output in the event history. If your workflow calls 100 activities that each return 10KB of data, the history contains 1MB of payload data---even if the workflow only uses the final result. Large payloads bloat history, slow down replay, and accelerate hitting the 50K event limit.

Weft checkpoints store only the current state---the values of local variables at the yield point. Activity inputs aren't stored (they're derived from the workflow code on re-execution). Previous activity results are only present if they're still in scope as local variables. A workflow that processed 100 large API responses but only keeps a summary has a checkpoint containing only that summary.

The difference is architectural, not incremental. Replay _must_ store everything that happened. Checkpointing stores only what matters _right now_.

## Consequence: workflows are TypeScript-only

The checkpoint model leans on two language features working together: an async-iterable suspension primitive (`AsyncGenerator` + `yield*`) that gives the engine a clean re-entry point at every checkpoint boundary, and a serialization story (`structuredClone` semantics, via MessagePack) that lets the engine durably persist the workflow's locals at that boundary. JavaScript has both in its standard library. Most other mainstream languages have only one or neither: Python `async def` has no `yield*`-shaped typed return-value plumbing and no public way to round-trip arbitrary live values; Go goroutines and Java continuations don't expose suspension state as a serializable artifact at all.

That means **workflows in Weft are TypeScript-only by design**. Activities — the side-effecting work — can run in any language via the [`RemoteWorker` wire protocol](../reference/remote-worker-protocol.md), but the workflow orchestration code itself is TypeScript.

This isn't an oversight or a roadmap item. It's the load-bearing consequence of choosing checkpoint-not-replay. A polyglot workflow runtime would either (a) abandon the checkpoint model and re-introduce replay, which is the thing we left behind, or (b) build a separate state-machine-on-messages model per language, which collapses back to replay with extra steps. Temporal does (a) well. If you need workflows in multiple languages, Temporal is the right answer.

The full design rationale and the alternatives we considered live in [ADR 0001 — Workflows Are TypeScript-Only by Design](../contributing/architecture-decisions/0001-workflows-typescript-only.md).
