# Session State

Some workflows need a small amount of mutable, durable state that lives alongside the generator function---a counter that survives recovery, a conversation history that the next turn reads, a feature flag that one signal handler flips and another consults. `ctx.sessionState<T>(key, initialValue?)` is the lightweight option for that.

It's modeled after the virtual-object pattern: a typed slot you read and write through a small handle. Each slot is **scoped to the current workflow instance**---no other workflow shares it, and there's no global registry. The state survives checkpointing and recovery because it lives inside the workflow's checkpoint locals.

## Reading and writing a slot

`ctx.sessionState<T>(key, initialValue?)` returns a `WorkflowSessionState<T>` handle with five methods: `get`, `set`, `update`, `clear`, and `run`.

```ts partial
import { type WorkflowContext } from 'weft';

engine.register('counter', async function* (ctx: WorkflowContext) {
  const counter = ctx.sessionState<number>('count', 0);

  counter.set(counter.get()! + 1);
  return counter.get();
});
```

`get()` returns the current value or `undefined` if the slot has never been written. The optional `initialValue` parameter primes the slot---`get()` returns it until something else writes.

`set(value)` writes the value and returns it. `update((current) => next)` reads, transforms, and writes in one call:

```ts partial
counter.update((current) => (current ?? 0) + 1);
```

`clear()` removes the stored value. After clearing, `get()` returns the handle's captured `initialValue` if you provided one, otherwise `undefined`. The handle's `initialValue` is a snapshot, so subsequent reads see the original value until the next `set` or `update`.

## Survives recovery

The slot's value is part of the workflow's checkpoint locals, so a process crash and recovery preserves whatever was written before the last checkpoint. This is the whole point: you can stash conversation state, accumulated counts, or feature toggles without reaching for an activity or external storage.

```ts partial
engine.register('survives-crashes', async function* (ctx: WorkflowContext) {
  const counter = ctx.sessionState<number>('count', 0);
  counter.update((n) => (n ?? 0) + 1);

  yield* ctx.waitForSignal('resume');

  // After a recovery between the update above and the signal,
  // counter.get() still returns the incremented value.
  return counter.get();
});
```

## Running activities with session-bound stickiness

`run(fn, ...args)` executes a function as a generator-yielding durable operation that's automatically routed through sticky worker execution. This is the typical path for activities that need to be co-located with their session state---LLM calls, conversation-aware tool invocations, anything where moving between workers would lose useful warm context.

```ts partial
async function* example(ctx: Context) {
  const session = ctx.sessionState<number>('conversation', 0);

  const reply = yield* session.run(async (input: string) => {
    return `processed: ${input}`;
  }, 'hello');
}
```

The activity dispatched by `session.run` carries `sticky: true` and any other options you pass through. The function itself runs as a regular activity---it doesn't directly read or write the session slot from inside. If it needs the current value, take it from `session.get()` before yielding the run.

## Validation

The slot has a few guardrails---these are the limits the engine enforces, not advice:

- Keys must be 1 to 256 characters. Empty strings throw `SessionStateValidationError`.
- The reserved prototype keys `__proto__`, `constructor`, and `prototype` are rejected. Trying to set them throws.
- Up to 256 keys per workflow. Past that, the next `set` or `update` throws.
- Total serialized size (across all keys for the workflow) is capped at 32 KB. Writing a value that pushes the slot past that limit throws _and_ leaves the previous value intact---validation runs before commit.

If you hit either size limit, you probably want a different durability mechanism for that data. `ctx.run()` is the right tool for activity results, and shared cross-workflow state belongs in [`SharedState`](./shared-state.md) or external storage.

## Values are cloned

`get()` and `set()` use `structuredClone` so caller mutation can't leak into durable state.

```ts partial
const draft = ctx.sessionState<{ items: string[] }>('draft');

const stored = draft.set({ items: ['a'] });
stored.items.push('b'); // does NOT affect the stored value

const next = draft.get();
console.log(next); // { items: ['a'] }
```

Same applies to `initialValue`: the slot snapshots it when the handle is created, so mutating the passed-in object after the call doesn't leak into the slot either.

## Session state vs. `ctx.run`

These look superficially similar but solve different problems.

| Concern        | `ctx.sessionState`                                        | `ctx.run`                                                 |
| -------------- | --------------------------------------------------------- | --------------------------------------------------------- |
| What it stores | A small mutable value scoped to one workflow              | Activity results, immutable once recorded                 |
| Where it lives | Checkpoint locals (in storage, attached to the workflow)  | Activity history (durable execution log)                  |
| Mutability     | Read-write, supports `update()` and `clear()`             | Append-only                                               |
| Right for      | Counters, flags, conversation handles, small accumulators | Network calls, IO, anything you wouldn't repeat on replay |

When in doubt: if the value would be wrong to recompute on replay (an LLM response, a payment confirmation), use `ctx.run`. If it's bookkeeping the workflow itself wants to track across signals or recoveries, use `ctx.sessionState`.

## Child workflows

Child workflows start with **empty** session state. The parent's slots aren't passed across the boundary---each child workflow is its own instance and has to seed its own keys (or rely on `initialValue`s declared at the call sites where it reads them). Session state belongs to the workflow that wrote it.

If you want a child to inherit context, pass the relevant values as part of the child's input. If you want shared cross-workflow state, [`SharedState`](./shared-state.md) is the right primitive: it lives in storage with optimistic concurrency, scoped to whatever key you give it.

## What's not a contract

A few behaviors aren't pinned by tests and should be treated as implementation detail:

- Same-key handles share the same stored slot, so a write through one handle is visible to another. What is not yet a formal contract is how different `initialValue`s behave across multiple handles before the first write, or how reads interleave across nested generator suspensions.
- The order of validation when a single `set` or `update` triggers multiple constraints (oversize + reserved key, etc.). Today the engine throws on the first failure it finds; future versions may aggregate.

If you find yourself depending on either behavior, file an issue---both deserve explicit tests and a stated contract.
