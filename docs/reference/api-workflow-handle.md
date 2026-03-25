# WorkflowHandle API Reference

`WorkflowHandle` is the primary interface for interacting with a running (or completed) workflow. It extends `EventTarget` and implements `AsyncDisposable`, providing methods to read results, send signals, push updates, cancel execution, and observe lifecycle events via both the DOM event model and well-known Symbol protocols.

You get a handle from `engine.start()` or `engine.getHandle()`.

For a guided walkthrough, see the [Workflows guide](../guides/workflows.md).

---

## Class Signature

```ts
class WorkflowHandle extends EventTarget implements AsyncDisposable {
  readonly id: string;

  async result(): Promise<unknown>;
  async signal(name: string, payload?: unknown): Promise<void>;
  async update(name: string, payload?: unknown, options?: { timeout?: number }): Promise<unknown>;
  async cancel(): Promise<void>;

  async *[Symbol.asyncIterator](): AsyncIterableIterator<Event>;
  [Symbol.observable](): Observable;
  async [Symbol.asyncDispose](): Promise<void>;
}
```

---

## Properties

### `id`

```ts
readonly id: string;
```

The unique workflow identifier. This is either the ID you passed via `StartOptions.id` or an auto-generated UUID.

---

## Methods

### `result()`

```ts
async result(): Promise<unknown>;
```

Returns a promise that resolves with the workflow's return value when it completes. If the workflow fails, the promise rejects with the error. If the workflow is cancelled, the promise rejects with `Error('Workflow cancelled')`.

For workflows that are already complete when you call `result()`, the promise resolves immediately from stored state.

```ts
const handle = await engine.start('order-processing', { orderId: '123' });
const output = await handle.result();
```

### `signal(name, payload?)`

```ts
async signal(name: string, payload?: unknown): Promise<void>;
```

Send a named signal to the workflow. If the workflow is currently waiting for this signal (via `ctx.waitForSignal(name)`), it resumes immediately. Otherwise, the signal is persisted and delivered when the workflow reaches a `waitForSignal` call for that name.

```ts
await handle.signal('approve', { approvedBy: 'alice' });
```

### `update(name, payload?, options?)`

```ts
async update(
  name: string,
  payload?: unknown,
  options?: { timeout?: number },
): Promise<unknown>;
```

Send a synchronous update to the workflow and wait for the result. Unlike signals, updates are request-response -- the workflow's registered `onUpdate` handler processes the payload and returns a value.

| Parameter         | Type      | Default     | Description                                           |
| ----------------- | --------- | ----------- | ----------------------------------------------------- |
| `name`            | `string`  | --          | Update handler name (registered via `ctx.onUpdate()`) |
| `payload`         | `unknown` | `undefined` | Payload passed to the handler                         |
| `options.timeout` | `number`  | `5000`      | Timeout in ms waiting for the handler to respond      |

Throws if the handler throws or the timeout is exceeded.

```ts
const count = await handle.update('getProgress');
```

### `cancel()`

```ts
async cancel(): Promise<void>;
```

Cancel the workflow. This:

1. Aborts the workflow's `AbortController`
2. Cleans up the generator
3. Sets the workflow status to `'cancelled'`
4. Dispatches a `WorkflowCancelledEvent`
5. Rejects the `result()` promise with `Error('Workflow cancelled')`

```ts
await handle.cancel();
```

---

## EventTarget Interface

`WorkflowHandle` extends `EventTarget`, so you can listen for lifecycle events using the standard `addEventListener` / `removeEventListener` API. Events are forwarded from the engine to the handle.

```ts
handle.addEventListener('workflow:completed', (event) => {
  console.log('Workflow completed!');
});

handle.addEventListener('workflow:failed', (event) => {
  console.error('Workflow failed');
});

handle.addEventListener('workflow:cancelled', (event) => {
  console.log('Workflow was cancelled');
});
```

Event types forwarded to the handle:

| Event Type           | Dispatched When                    |
| -------------------- | ---------------------------------- |
| `workflow:completed` | Workflow finishes successfully     |
| `workflow:failed`    | Workflow throws an unhandled error |
| `workflow:cancelled` | Workflow is cancelled              |

---

## Symbol Protocols

### `Symbol.asyncIterator`

```ts
async *[Symbol.asyncIterator](): AsyncIterableIterator<Event>;
```

Yields workflow lifecycle events as they occur. The iterator completes when the workflow reaches a terminal state (`workflow:completed`, `workflow:failed`, or `workflow:cancelled`).

Listened event types: `workflow:completed`, `workflow:failed`, `workflow:cancelled`, `activity:started`, `activity:completed`, `signal:received`.

```ts
const handle = await engine.start('my-workflow', input);

for await (const event of handle) {
  console.log(event.type);
  if (event.type === 'workflow:completed') break;
}
```

### `Symbol.observable`

```ts
[Symbol.observable](): {
  subscribe: (observer: {
    next?: (event: Event) => void;
    complete?: () => void;
    error?: (error: Error) => void;
  }) => { unsubscribe: () => void };
};
```

Returns an observable-like object compatible with the TC39 Observable proposal. The observer receives lifecycle events via `next()`, a `complete()` call on `workflow:completed`, and an `error()` call on `workflow:failed`.

```ts
const observable = handle[Symbol.observable]();
const subscription = observable.subscribe({
  next: (event) => console.log(event.type),
  complete: () => console.log('Done!'),
  error: (error) => console.error(error),
});

// Later:
subscription.unsubscribe();
```

Observed event types: `workflow:completed`, `workflow:failed`, `workflow:cancelled`, `activity:started`, `activity:completed`.

### `Symbol.asyncDispose`

```ts
async [Symbol.asyncDispose](): Promise<void>;
```

No-op for now -- handles are lightweight and do not hold resources that need cleanup. This allows `WorkflowHandle` to be used with `await using`:

```ts
await using handle = await engine.start('my-workflow', input);
const result = await handle.result();
// handle is disposed when scope exits
```
