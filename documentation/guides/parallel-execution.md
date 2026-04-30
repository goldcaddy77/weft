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

The semantics mirror `Promise.all()`---if any branch fails, the whole operation fails. But unlike raw promises, each branch is independently checkpointed. If your process crashes after `checkInventory` completes but before `computeTax` does, recovery replays only the incomplete branches.

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

The result of a `ctx.all()` or `ctx.race()` is checkpointed as a single step. On replay, the entire parallel result is returned from cache---none of the branches re-execute.

## When to use which

Use `ctx.all()` when you need _every_ result. Enrichment pipelines, multi-service aggregation, parallel approval requests where all must respond---these are `all` territory.

Use `ctx.race()` when you need _any_ result. Hedged requests, timeout wrappers, competing strategies where the fastest path wins---that's `race`.

If you're building something more complex---like "run five tasks, return when any three complete"---compose these primitives. Run the five tasks, track completions via [signals](./signals-and-queries.md), and use `ctx.race()` with a counter to detect when your threshold is met.

Both primitives nest cleanly. You can `all()` inside a `race()` or vice versa, and checkpointing works correctly at every level.
