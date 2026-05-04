# Parallel Execution

You have three API calls that don't depend on each other, and you're running them one at a time. Each one checkpoints before the next can start. That's reliable, sure---but it's also needlessly slow. Weft gives you two primitives for running work concurrently: `ctx.all()` for fan-out-and-collect, and `ctx.race()` for first-one-wins.

## Fan-out with `ctx.all()`

`ctx.all()` takes an array of generator operations and runs them in parallel. Every branch gets its own checkpoint. When all branches complete, you get an array of results in the same order you passed the operations.

```typescript partial
async function* enrichOrder(ctx: Context, order: Order) {
  const [inventory, shipping, tax] = yield* ctx.all([
    ctx.run(checkInventory, order.items),
    ctx.run(calculateShipping, order.address),
    ctx.run(computeTax, order.total, order.region),
  ]);

  return { inventory, shipping, tax };
}
```

The rejection condition mirrors `Promise.all()`---if any branch fails, the whole operation fails. **What's different from raw promises**: when one branch rejects, every other branch's settled value is recorded in the parent operation's in-memory cache entry before the rejection propagates. On the workflow's next yield, that entry is persisted to the checkpoint. If the workflow runs again from that checkpoint, fulfilled branches are reused---the activity does **not** run a second time.

> [!IMPORTANT] Failure semantics contract
> When any branch of `ctx.all` fails, fulfilled branches' values are written into the parent's in-memory cache entry _before_ the rejection is thrown into the workflow generator. The entry becomes durable on the **next checkpoint write**, which fires at the next `yield` boundary the workflow reaches. From that point forward, replays at the same step skip dispatch for fulfilled slots and re-dispatch only the non-fulfilled ones.

Three corollaries you should keep in mind:

1. **The partial entry is durable iff the workflow yields again.** If the workflow catches the rejection and yields any other operation (`ctx.run(retry)`, `ctx.sleep(1000)`, `ctx.waitForSignal(...)`, etc.), the next checkpoint persists the partial entry and the fix takes hold. If the workflow does not catch and the parent generator throws all the way to termination, the workflow ends in a failed state and the partial entry is **not** persisted---no resumed run can reuse it. This is a real boundary: design failure handling around catch + yield, or use idempotency keys for branches whose side effects must not be duplicated.
2. **Fail-fast timing changes.** `ctx.all` no longer aborts sibling branches when one fails---surviving branches keep running so their fulfillments can be captured. A slow sibling will delay the parent's rejection until it settles. If you need cancel-on-first-failure semantics, prefer `ctx.race` with a guard branch.
3. **Branch order must be deterministic across retries.** `ctx.all` keys branches by positional index. Same-length reordering between attempts (e.g., `[sendEmail, scheduleShipping]` on attempt 1 → `[scheduleShipping, sendEmail]` on attempt 2) cannot be detected and will silently feed slot 0's value into the wrong position. If your branch list is dynamic, prefer `ctx.runAll` (which keys by branch name and detects reordering as a `BranchTopologyChangedError`).
4. **Top-level only.** Partial-failure preservation applies to top-level `ctx.all` and `ctx.runAll`. A `ctx.all` nested inside another sub-operation (e.g., inside a `ctx.race` branch) does not get its own partial entry---the inner result lives entirely in the outer parent's slot. Inner branches with side effects need idempotency keys.

You can mix operation types freely. Sleeps, signals, and activity calls all work inside `ctx.all()`:

```typescript partial
async function* example(ctx: Context) {
  const [result, _] = yield* ctx.all([
    ctx.run(longRunningTask, data),
    ctx.sleep('5s'), // timeout alongside the task
  ]);
}
```

## First-wins with `ctx.race()`

`ctx.race()` returns the result of whichever operation finishes first. The remaining operations are effectively abandoned---their results are discarded.

```typescript partial
async function* fetchWithFallback(ctx: Context, url: string) {
  const result = yield* ctx.race([
    ctx.run(fetchFromPrimary, url),
    ctx.run(fetchFromSecondary, url),
  ]);

  return result;
}
```

This is useful for timeout patterns, redundant fetches, and any scenario where you want the fastest answer. The engine records whichever result arrives first as the checkpoint, so on recovery you get the same winner.

> [!WARNING] `ctx.race` does not preserve loser results
> Unlike `ctx.all`, `ctx.race` deliberately does not preserve losing branches. Branches are speculative: a loser may have completed a side effect before being aborted, and Weft does not compensate for that. Design `ctx.race` branches to be either idempotent or paired with a compensating transaction.

A common pattern pairs a real operation with a sleep to implement a deadline:

```typescript partial
async function* example(ctx: Context) {
  const result = yield* ctx.race([
    ctx.run(callExternalApi, payload),
    ctx.sleep('30s'), // returns undefined after 30 seconds
  ]);

  if (result === undefined) {
    // The sleep won---the API call took too long
    yield* ctx.run(notifyTimeout, payload);
  }
}
```

## Under the hood

Both `ctx.all()` and `ctx.race()` work by collecting the first yielded operation from each generator you pass in, then emitting a single `parallel` or `race` operation request. The engine handles the concurrent dispatch and result collection internally.

Note that `ctx.race()` emits `{ type: 'race', ... }` rather than `{ type: 'parallel', ... }`. Each sub-operation also advances the workflow's `stepIndex`, which is why subsequent steps remain replay-stable after a parallel or race completes.

```typescript partial
// What ctx.all() yields to the engine:
{
  type: 'parallel',
  operationId: '...',
  operations: [
    { type: 'activity', activityName: 'checkInventory', ... },
    { type: 'activity', activityName: 'calculateShipping', ... },
    { type: 'activity', activityName: 'computeTax', ... },
  ],
}
```

The result of a `ctx.all()` or `ctx.race()` is checkpointed as a single step. The cache entry is shaped as `{ formatVersion: 2, variant: 'all' | 'race' | 'run-all', branches: [...], subOperationCount }`---each branch's slot is `{ status: 'pending' | 'fulfilled' | 'rejected' | 'aborted', operationId, ... }`. On replay, every fulfilled slot is reused without re-dispatch; pending or rejected slots re-dispatch.

The `subOperationCount` field is what lets the workflow's `stepIndex` skip past the cached sub-operations cleanly on replay---without it, replay would re-yield each branch's first operation and double-count steps.

## When to use which

Use `ctx.all()` when you need _every_ result. Enrichment pipelines, multi-service aggregation, parallel approval requests where all must respond---these are `all` territory.

Use `ctx.race()` when you need _any_ result. Hedged requests, timeout wrappers, competing strategies where the fastest path wins---that's `race`.

If you're building something more complex---like "run five tasks, return when any three complete"---compose these primitives. Run the five tasks, track completions via [signals](./signals-and-queries.md), and use `ctx.race()` with a counter to detect when your threshold is met.

Both primitives nest cleanly. You can `all()` inside a `race()` or vice versa, and checkpointing works correctly at every level.
