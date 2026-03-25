# Workflows

You have a multi-step business process---charge a card, reserve inventory, send a confirmation email---and if anything crashes midway through, you need to pick up exactly where you left off. Not from the beginning. Not by replaying every step. From the _last successful point_, with all your local variables intact.

That is what a Weft workflow gives you.

## Generator functions as workflows

A workflow is an `async function*` that receives a context and an input. The generator syntax is the key: every `yield*` expression is a **checkpoint boundary** where Weft snapshots your entire local scope.

```typescript
import { Engine } from 'weft';

const engine = new Engine();

engine.register('welcome', async function* (ctx, input) {
  const { name } = input as { name: string };
  const greeting = yield* ctx.run(greet, name);
  yield* ctx.run(notify, greeting);
  return { greeting, notified: true };
});
```

The `async function*` declaration gives you a function that can pause itself with `yield` and be resumed later. Each pause preserves all local variables. `yield*` delegates to another generator---in this case, the context methods that represent durable operations. These are the only JavaScript primitives that give you serializable, suspendable execution, and they are a web standard that works everywhere.

So when you write `yield* ctx.run(greet, name)`, two things happen: the activity executes, and Weft captures a checkpoint of your workflow's state. If the process crashes after that line but before the next `yield*`, recovery resumes from the checkpoint---not from the top of the function.

## The workflow lifecycle

Every workflow moves through a state machine with six possible states:

- **pending** -- created but not yet executing
- **running** -- actively advancing through its generator
- **completed** -- the generator returned a value
- **failed** -- an unhandled error escaped the generator
- **cancelled** -- explicitly cancelled via `handle.cancel()` or `engine.cancel(id)`
- **timed-out** -- hit its execution deadline

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

```typescript
const engine = new Engine({ development: true });

engine.addEventListener('development:warning', (event) => {
  console.warn(event.message, event.fieldPaths);
});
```

This is cheap insurance during development. Turn it off in production---the validation adds overhead you do not need once your workflows are proven correct.

## Registering workflows

The simplest registration passes a name and a handler.

```typescript
engine.register('order', async function* (ctx, input) {
  // ...
});
```

When you need versioning or migration support, pass an object instead.

```typescript
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

## Starting workflows and getting results

Call `engine.start()` with the registered name and your input. You get back a `WorkflowHandle`---a lightweight reference you can use to await the result, send [signals](signals-and-queries.md), or cancel execution.

```typescript
const handle = await engine.start('welcome', { name: 'World' });
const result = await handle.result();
// { greeting: 'Hello, World!', notified: true }
```

You can also provide options when starting a workflow.

```typescript
const handle = await engine.start('order', orderData, {
  id: 'order-abc-123', // deterministic ID instead of random UUID
  executionTimeout: '30 minutes', // hard deadline for the entire workflow
});
```

The `id` option is useful when you want idempotent starts---starting a workflow with an ID that already exists throws an error, so you can safely retry without creating duplicates.

## No history growth

Unlike systems that replay an ever-growing event history, Weft's checkpoint is a constant-size snapshot of current state. It does not grow with the number of activities executed. A workflow can run for years, execute millions of activities, and its checkpoint stays the same size as it was after the first `yield*`. There is no history limit, no `continueAsNew`, no manual state serialization.

Long-running workflows just run.
