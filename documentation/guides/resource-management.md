# Resource Management

A workflow engine is a long-running process. It holds database connections, worker threads, interval timers, and in-memory caches. If any of those leak, you get slow degradation that turns into a 3 AM page. Weft uses Explicit Resource Management---the `using` and `await using` declarations from TC39's Stage 4 proposal---to make cleanup automatic.

## The pattern

When you declare a variable with `using`, its `[Symbol.dispose]()` method is called when the enclosing block exits. `await using` does the same but calls `[Symbol.asyncDispose]()` for async cleanup. No try/finally. No manual `.close()` calls.

```typescript
import { BunSQLiteStorage } from 'weft/storage/bun-sqlite';

{
  using engine = new Engine({ storage: new BunSQLiteStorage('./weft.db') });

  engine.register('order', orderWorkflow);
  const handle = await engine.start('order', { orderId: 'abc' });
  await handle.result();
} // engine[Symbol.dispose]() called automatically
```

When the block exits---whether normally or via an exception---the engine shuts down: it aborts pending operations, stops the scheduler, and clears internal state.

## What is disposable

Every major Weft object implements `Disposable`, `AsyncDisposable`, or both.

_Engine_ implements both. `Symbol.dispose` does immediate teardown---aborts all pending operations, terminates the worker pool, stops the scheduler, and clears caches. `Symbol.asyncDispose` does the same thing (it delegates to the synchronous dispose internally, though future versions may add graceful drain semantics).

```typescript
{
  await using engine = new Engine({ storage });
  // ... run workflows ...
} // engine[Symbol.asyncDispose]() called
```

_WorkflowHandle_ implements `AsyncDisposable`. Handles are lightweight, so disposal is currently a no-op---but declaring `await using` on handles is good practice because it documents intent and future-proofs your code.

```typescript
{
  await using handle = await engine.start('order', input);
  const result = await handle.result();
} // handle[Symbol.asyncDispose]() called
```

_BunSQLiteStorage_ implements `Disposable`. Disposal closes the underlying SQLite database connection.

`IndexedDBStorage` is the browser-environment equivalent---also `Disposable`---and uses the `await using` pattern. Import it from `'weft/storage/indexeddb'`.

```typescript
{
  using storage = new BunSQLiteStorage('./weft.db');
  const engine = new Engine({ storage });
  // ...
} // storage[Symbol.dispose]() closes the database
```

_MemoryStorage_ implements `Disposable`. Disposal clears the in-memory map.

_Scheduler_ implements `Disposable`. Disposal stops the polling interval.

## Multi-resource orchestration

When you have multiple resources that need coordinated cleanup, use `AsyncDisposableStack`. It disposes resources in reverse order of registration---like Go's `defer`, but type-safe and automatic.

```typescript
async function runServer(port: number) {
  await using stack = new AsyncDisposableStack();

  const storage = stack.use(new BunSQLiteStorage('./weft.db'));
  const engine = stack.use(new Engine({ storage }));
  const server = stack.adopt(
    Bun.serve({ port, fetch: (request) => handleHTTP(engine, request) }),
    (s) => s.stop(),
  );

  stack.defer(() => console.log('Server shut down cleanly'));

  engine.register('order', orderWorkflow);

  console.log(`Weft running on port ${port}`);
  await new Promise((resolve) => {
    process.on('SIGINT', resolve);
    process.on('SIGTERM', resolve);
  });
} // AsyncDisposableStack disposes in reverse order:
// 1. Logs "Server shut down cleanly"
// 2. Stops HTTP server
// 3. Disposes engine
// 4. Closes storage
```

Three methods on the stack are worth knowing:

- `stack.use(resource)` registers a `Disposable` or `AsyncDisposable` and returns it for continued use.
- `stack.adopt(value, onDispose)` registers any value with a custom disposal callback---perfect for things like `Bun.serve()` that are not natively disposable.
- `stack.defer(fn)` registers an arbitrary cleanup function, executed in stack order (just like `defer` in Go).

## Why this matters

In a traditional Node.js application, you might forget to close a database connection in an error path, or leave an interval timer running after a test. These bugs are insidious---they work fine 99% of the time and only manifest under pressure or after hours of uptime.

With `using`, the compiler and runtime _guarantee_ cleanup happens. You cannot forget. If you reach for `new BunSQLiteStorage()`, TypeScript will nudge you toward `using storage = new BunSQLiteStorage()` because the type implements `Disposable`. The resource lifecycle is visible in the code structure, not hidden in a `finally` block three screens away.

Make `using` your default for any Weft resource. Future you, debugging at 3 AM, will be grateful.
