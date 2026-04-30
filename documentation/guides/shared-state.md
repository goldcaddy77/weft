# Shared State

Most workflow state lives inside the generator function---local variables, checkpointed at each yield. But some scenarios need mutable state that multiple concurrent branches or even external callers can read and write safely. That's what `SharedState` provides.

## The problem

Imagine a multi-agent workflow where three branches run in [parallel](./parallel-execution.md), each contributing results to a shared accumulator. Or a collaborative editing workflow where the workflow and external API calls both need to update a progress counter. Regular workflow locals can't handle this---they're scoped to a single generator execution and don't support concurrent access.

## Creating shared state

`SharedState` is a class that wraps a named state slot in storage with optimistic concurrency control. You create one by providing the storage, workflow ID, and a key name.

```typescript partial
import { SharedState } from 'weft';

const counter = new SharedState<number>(engine.storage, workflowId, 'progress-counter');
```

An optional `maxRetries` controls how many times a conflicting update retries before giving up (default: 10).

```typescript partial
const counter = new SharedState<number>(engine.storage, workflowId, 'progress-counter', {
  maxRetries: 5,
});
```

## Reading state

The `get()` method returns the current value and its version number. You provide an initial value that's returned if no state has been written yet.

```typescript partial
const { value, version } = await counter.get(0);
console.log(`Current count: ${value}, version: ${version}`);
```

The version starts at `0` for uninitialized state and increments with each successful update.

## Updating state with compare-and-swap

The `update()` method applies a transformation function with optimistic concurrency. It reads the current value, applies your function, checks that the version hasn't changed since the read, and returns batch operations for atomic commit.

```typescript partial
const { value, version, operations } = await counter.update(
  (current) => current + 1,
  0, // initial value if state doesn't exist yet
);
```

The returned `operations` array contains the `put` commands for both the new value and the new version number. You'd typically include these in a larger batch alongside a checkpoint write.

Here's the flow internally:

1. Read the current value and version from storage.
2. Apply your update function to the current value.
3. Re-read the version to check for concurrent writes.
4. If the version is unchanged, return the new value and batch operations.
5. If the version changed (someone else wrote between steps 1 and 3), retry from step 1.
6. After `maxRetries` failures, throw a `SharedStateConflictError`.

This is textbook optimistic concurrency---no locks, no blocking, just retry on conflict.

## Handling conflicts

When contention is high enough to exhaust retries, you get a `SharedStateConflictError`:

```typescript partial
try {
  const { value, operations } = await counter.update((n) => n + 1, 0);
} catch (error) {
  if (error instanceof SharedStateConflictError) {
    console.log(error.stateKey); // 'progress-counter'
    console.log(error.attempts); // 10 (or whatever maxRetries was)
  }
}
```

In practice, conflicts are rare unless many branches are writing to the same key at very high frequency. If you're hitting this, consider reducing contention by partitioning state across multiple keys or using a different coordination pattern.

## When to use shared state

Shared state fits scenarios where multiple concurrent actors need to read and write the same data:

- **Multi-agent workflows** where parallel branches accumulate results into a shared collection.
- **Progress tracking** where both the workflow and external observers update a counter.
- **Collaborative state** where the workflow and API handlers both need to modify a configuration object.

For simpler cases where only the workflow writes and external code just reads, [search attributes](./search-attributes.md) or `ctx.expose()` are lighter-weight alternatives. Shared state is the tool you reach for when you genuinely need concurrent mutable access with conflict detection.
