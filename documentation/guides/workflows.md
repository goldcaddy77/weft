# Workflows

You have a multi-step business process---charge a card, reserve inventory, send a confirmation email---and if anything crashes midway through, you need to pick up exactly where you left off. Not from the beginning. Not by replaying every step. From the _last successful point_, with all your local variables intact.

That is what a Weft workflow gives you.

## Getting started without generators

If you are not familiar with generators, Weft provides a simpler entry point. Register a plain `async` function and use `ctx.step()` for each durable operation:

```typescript partial
import { Engine } from 'weft';

const engine = new Engine();

engine.register('welcome', async (ctx, input: { name: string }) => {
  const greeting = await ctx.step('greet', () => greet(input.name));
  await ctx.step('notify', () => notify(greeting));
  return { greeting, notified: true };
});
```

Each `ctx.step()` call is a checkpoint boundary, just like `yield*` in the generator API. The conversion happens automatically at registration time -- the engine always works with generators internally.

The step-based API is a subset of the full API. It supports sequential steps only. When you need durable timers (`sleep()`), external signals (`waitForSignal()`), or parallel execution (`all()`, `race()`), graduate to the generator API described below.

## Generator functions as workflows

A workflow is an `async function*` that receives a context and an input. The generator syntax is the key: every `yield*` expression is a **checkpoint boundary** where Weft snapshots your entire local scope.

```typescript partial
import { Engine } from 'weft';

const engine = new Engine();

engine.register('welcome', async function* (ctx, input: { name: string }) {
  const greeting = yield* ctx.run(greet, { name: input.name });
  yield* ctx.run(notify, { message: greeting });
  return { greeting, notified: true };
});
```

The `async function*` declaration gives you a function that can pause itself with `yield` and be resumed later. Each pause preserves all local variables. `yield*` delegates to another generator---in this case, the context methods that represent durable operations. These are the only JavaScript primitives that give you serializable, suspendable execution, and they are a web standard that works everywhere.

So when you write `yield* ctx.run(greet, { name: input.name })`, two things happen: the named activity executes, and Weft captures a checkpoint of your workflow's state. If the process crashes after that line but before the next `yield*`, recovery resumes from the checkpoint---not from the top of the function.

## The workflow lifecycle

Every workflow moves through a state machine with six possible states:

- **pending** -- created but not yet executing
- **running** -- actively advancing through its generator
- **completed** -- the generator returned a value
- **failed** -- an unhandled error escaped the generator
- **cancelled** -- explicitly cancelled via `handle.cancel()` or `engine.cancel(id)`
- **timed-out** -- hit its execution deadline

The `pending` state is only observable for workflows scheduled with `startAt` or `startAfter`; workflows started with a plain `engine.start()` call skip directly to `running`.

Transitions are one-way. A completed workflow stays completed. A failed workflow does not automatically retry (that is what [activities](activities.md) are for). This simplicity is deliberate---workflow state is easy to reason about because it only moves forward.

## Checkpoint serialization

Weft uses `structuredClone` semantics to serialize checkpoints---the same algorithm browsers use for `postMessage`. This means your local variables can contain:

- Primitives (strings, numbers, booleans, null, undefined)
- Plain objects and arrays
- `Date`, `Map`, `Set`, `RegExp`
- `ArrayBuffer` and `TypedArray`

They _cannot_ contain:

- Functions or closures
- Class instances with methods
- Symbols, `WeakMap`, `WeakRef`
- System resources (sockets, file handles, database connections)

The practical rule: if you can `structuredClone` it, it survives a checkpoint. If you cannot, keep it outside your workflow's local scope or derive it fresh after each `yield*`.

## Catching serialization bugs early

Set `development: true` when constructing your engine and Weft will validate every checkpoint round-trip as it happens. If a local variable would not survive serialization, you get a `DevelopmentWarningEvent` with the exact field paths that failed.

```typescript partial
const engine = new Engine({ development: true });

engine.addEventListener('development:warning', (event) => {
  console.warn(event.message, event.fieldPaths);
});
```

This is cheap insurance during development. Turn it off in production---the validation adds overhead you do not need once your workflows are proven correct.

## Registering workflows

The simplest registration passes a name and a handler.

```typescript partial
engine.register('order', async function* (ctx, input) {
  // ...
});
```

When you need versioning or migration support, pass an object instead.

```typescript partial
engine.register('order', {
  version: '2',
  handler: async function* (ctx, input) {
    // ...
  },
  migrate: (checkpoint, fromVersion) => {
    // Transform checkpoint data from an older version
    return checkpoint;
  },
});
```

The `version` string tags every checkpoint so that Weft knows which schema produced it. The optional `migrate` function transforms old checkpoints to the current shape when a workflow resumes after a code deploy.

The registration object also accepts `searchAttributes` (declare indexed attributes for this workflow type), `retention` (how long to keep terminal workflow state), and `constraints` (resource-level execution limits). See the [search attributes guide](./search-attributes.md) for `searchAttributes` usage.

## Starting workflows and getting results

Call `engine.start()` with the registered name and your input. You get back a `WorkflowHandle`---a lightweight reference you can use to await the result, send [signals](signals-and-queries.md), or cancel execution.

```typescript partial
const handle = await engine.start('welcome', { name: 'World' }, { id: 'welcome:world' });
const result = await handle.result();
// { greeting: 'Hello, World!', notified: true }
```

You can also provide options when starting a workflow.

```typescript partial
const handle = await engine.start('order', orderData, {
  id: 'order-abc-123', // deterministic ID instead of random UUID
  executionTimeout: '30 minutes', // hard deadline for the entire workflow
});
```

If you omit `options.id`, Weft creates a fresh workflow id for this start. The `id` option is useful when you want idempotent starts---starting a workflow with an ID that already exists throws an error, so your caller can safely retry without creating duplicates and then reattach to the existing workflow.

## No history growth

Unlike systems that replay an ever-growing event history, Weft's checkpoint is a constant-size snapshot of current state. It does not grow with the number of activities executed. A workflow can run for years, execute millions of activities, and its checkpoint stays the same size as it was after the first `yield*`. There is no history limit, no `continueAsNew`, no manual state serialization.

Long-running workflows just run.

## Managing large state

While Weft's checkpoints stay constant-size by default, the data _inside_ your checkpoint can still grow if your workflow accumulates large intermediate results. Two context methods help you manage this. For small mutable state that should survive recovery---a counter, a flag, a conversation handle---reach for the lightweight [`ctx.sessionState`](./session-state.md) primitive instead.

### Offloading large intermediate data

When a workflow produces a large value that it needs later --- a batch of 10,000 processed records, a large API response --- keeping it in a local variable bloats the checkpoint. Use `ctx.offload()` to store the data separately, leaving only a lightweight reference in the checkpoint:

```typescript partial
engine.register('process-batch', async function* (ctx, input) {
  const { batchId } = input as { batchId: string };

  // Offload the large result out of the checkpoint
  const reference = yield* ctx.offload('batch-results', async () => {
    return await fetchAndProcessBatch(batchId);
  });

  // reference.sizeBytes tells you how big the stored data is
  yield* ctx.run(logMetrics, { batchId, bytes: reference.sizeBytes });

  // Load it back when needed
  const results = yield* ctx.load(reference);
  yield* ctx.run(publishResults, results);

  return { batchId, recordCount: results.length };
});
```

The offloaded data survives engine recovery --- it is persisted to the same storage backend as checkpoints. The `OffloadReference` is small (just a key, workflow ID, and size) and serializes cleanly in the checkpoint.

### Archiving historical data

Use `ctx.archive()` when you want to preserve data for auditing or debugging but do not need it again in the workflow. Archived data is stored at `archive:{workflowId}:{key}` and can be queried externally, but the workflow does not load it back:

```typescript partial
engine.register('order-pipeline', async function* (ctx, input) {
  const order = input as Order;

  const validated = yield* ctx.run(validateOrder, order);

  // Archive the validation snapshot for auditing
  yield* ctx.archive('validation-snapshot', {
    validatedAt: new Date(),
    order,
    result: validated,
  });

  const charged = yield* ctx.run(chargeCard, validated);
  return { orderId: order.id, charged };
});
```

**When to use which:**

- **`offload` / `load`** --- large data you need again later in the same workflow. Keeps the checkpoint lean while preserving access.
- **`archive`** --- data you want to persist for external consumption (dashboards, compliance, debugging) but never read back in the workflow.

## Child workflows

Sometimes a workflow needs to kick off a sub-process that should be independently checkpointed---with its own workflow ID, its own state in storage, and its own lifecycle. That is what child workflows are for.

Use `yield* context.startChild()` to start a child workflow from within a parent. The parent suspends at the `yield*` boundary until the child completes or fails.

```typescript partial
engine.register('process-payment', async function* (ctx, input) {
  const { amount } = input as { amount: number };
  // ... payment logic ...
  return { receiptId: 'rcpt-123', amount };
});

engine.register('order', async function* (ctx, input) {
  const context = ctx as Context;
  const { total, email } = input as { total: number; email: string };

  const receipt = yield* context.startChild('process-payment', { amount: total });
  yield* context.run(sendConfirmation, email, receipt);
  return { receipt, confirmed: true };
});
```

### Error handling

If a child workflow throws, the error propagates into the parent. You can catch it with a standard `try/catch` block.

```typescript partial
engine.register('parent', async function* (ctx, input) {
  const context = ctx as Context;
  try {
    yield* context.startChild('risky-child', input);
  } catch (error) {
    // Handle or compensate for the child failure
    yield* context.run(handleFailure, error);
  }
});
```

### Nesting depth limits

Child workflows can themselves start child workflows, creating a nesting hierarchy. To prevent runaway recursion, the engine enforces a maximum nesting depth. The default limit is 10 levels. You can configure it when creating the engine.

```typescript partial
const engine = new Engine({ maxNestingDepth: 5 });
```

When a child workflow would exceed the nesting limit, the engine throws an error into the parent workflow with a message indicating the depth exceeded the maximum.
