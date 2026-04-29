# Engine API

The `Engine` class is the central orchestrator in Weft. It manages workflow registration, execution lifecycle, signal delivery, and storage coordination. `WorkflowHandle` is the per-workflow reference returned by `engine.start()`, giving you access to results, signals, updates, and event observation.

## `Engine`

```ts
class Engine extends EventTarget implements Disposable, AsyncDisposable
```

### Constructor

```ts
new Engine(options?: Partial<EngineOptions>)
```

Creates a new engine instance. All options are optional -- sensible defaults are applied when omitted.

| Option                           | Type         | Default               | Description                                                   |
| -------------------------------- | ------------ | --------------------- | ------------------------------------------------------------- |
| `storage`                        | `Storage`    | `new MemoryStorage()` | Storage backend for workflow state and checkpoints            |
| `development`                    | `boolean`    | `false`               | Enable development-mode checkpoint validation                 |
| `serializer`                     | `Serializer` | built-in codec        | Custom serialization for checkpoint data                      |
| `checkpointHistory`              | `number`     | `10`                  | Number of historical checkpoints to retain                    |
| `checkpointSizeWarningThreshold` | `number`     | `65_536`              | Byte threshold that triggers a `CheckpointSizeWarningEvent`   |
| `maxNestingDepth`                | `number`     | `10`                  | Maximum allowed nesting depth for child workflows             |
| `broadcastEvents`                | `boolean`    | `false`               | Enable `BroadcastChannel` for cross-worker event coordination |

```ts
import { Engine, BunSQLiteStorage } from 'weft';

const engine = new Engine({
  storage: new BunSQLiteStorage('./data/weft.db'),
  development: true,
});
```

### `register()`

```ts
register(name: string, handler: WorkflowFunction): void
register(name: string, registration: WorkflowRegistration): void
```

Register a workflow by name. The simple form accepts a generator function directly. The registration form accepts a `WorkflowRegistration` object with additional metadata like `version` and `migrate`.

```ts
engine.register('send-email', async function* (context, input) {
  const result = yield* context.run(sendEmail, input.to, input.body);
  return result;
});

// Or with version metadata:
engine.register('send-email', {
  version: '2',
  handler: async function* (context, input) {
    /* ... */
  },
});
```

### `start()`

```ts
async start(type: string, input: unknown, options?: StartOptions): Promise<WorkflowHandle>
```

Start a new workflow execution. Throws if `type` is not registered or a workflow with the given `id` already exists.

| Parameter | Type           | Description                                 |
| --------- | -------------- | ------------------------------------------- |
| `type`    | `string`       | Name of the registered workflow             |
| `input`   | `unknown`      | Input data passed to the workflow generator |
| `options` | `StartOptions` | Optional start configuration                |

```ts
const handle = await engine.start('send-email', {
  to: 'user@example.com',
  body: 'Hello!',
});
```

### `signal()`

```ts
async signal(workflowId: string, name: string, payload?: unknown): Promise<void>
```

Deliver a named signal to a running workflow. If the workflow is currently waiting for this signal via `context.waitForSignal()`, it resumes immediately. Otherwise the signal is persisted and consumed when the workflow next waits for it.

```ts
await engine.signal(handle.id, 'approval', { approved: true });
```

### `update()`

```ts
async update(
  workflowId: string,
  name: string,
  payload?: unknown,
  options?: { timeout?: number },
): Promise<unknown>
```

Send a synchronous update to a running workflow and wait for the handler's return value. If the workflow has registered an `onUpdate` handler for `name`, the handler runs immediately and its return value is sent back. Falls back to the `UpdateCoordinator` with polling if no active handler is found. Default timeout is 5000ms.

```ts
const count = await engine.update(handle.id, 'getProgress');
```

### `cancel()`

```ts
async cancel(workflowId: string): Promise<void>
```

Cancel a running workflow. Aborts the workflow's `AbortController`, cleans up the generator, updates the persisted state to `'cancelled'`, and rejects the result promise.

### `list()`

```ts
async list(filter?: ListFilter): Promise<PaginatedResult<WorkflowSummary>>
```

List workflows with optional filtering and pagination. Scans all persisted workflow state and applies filters in memory.

```ts
const running = await engine.list({ status: 'running', limit: 20 });
```

### `getHandle()`

```ts
getHandle(workflowId: string): WorkflowHandle
```

Retrieve a `WorkflowHandle` for an existing workflow by ID. Uses a `WeakRef` cache internally -- if the handle has been garbage collected, a new one is created. If the workflow is still running, the result promise chains off the existing resolver. If the workflow has already completed or failed, the result is loaded from storage.

### `addInterceptor()`

```ts
addInterceptor(interceptor: WorkflowInterceptor): void
```

Register a workflow-level interceptor. See the [Interceptors reference](./api-interceptors.md) for details.

### `addActivityInterceptor()`

```ts
addActivityInterceptor(interceptor: ActivityInterceptor): void
```

Register an activity-level interceptor. See the [Interceptors reference](./api-interceptors.md) for details.

### `storage` (getter)

```ts
get storage(): Storage
```

Direct access to the underlying storage backend. Primarily useful for `TestEngine` and debugging.

### `scheduler` (getter)

```ts
get scheduler(): Scheduler
```

Direct access to the underlying scheduler. Primarily useful for `TestEngine` and debugging.

### Disposal

```ts
[Symbol.dispose](): void
[Symbol.asyncDispose](): Promise<void>
```

Clean up all engine resources -- aborts the scheduler, clears active generators, handles, resolvers, signal waiters, sleep resolvers, and closes the `BroadcastChannel` if active. Supports both `using` and `await using` syntax.

```ts
{
  using engine = new Engine();
  // engine is disposed when this block exits
}
```

---

## `WorkflowHandle`

```ts
class WorkflowHandle extends EventTarget implements AsyncDisposable
```

A lightweight handle to an individual workflow execution. Returned by `engine.start()` and `engine.getHandle()`.

### `id`

```ts
readonly id: string
```

The workflow's unique identifier.

### `result()`

```ts
async result(): Promise<unknown>
```

Await the workflow's final result. Resolves when the workflow completes, rejects if it fails or is cancelled.

```ts
const handle = await engine.start('process-order', order);
const receipt = await handle.result();
```

### `signal()`

```ts
async signal(name: string, payload?: unknown): Promise<void>
```

Shorthand for `engine.signal(handle.id, name, payload)`.

### `cancel()`

```ts
async cancel(): Promise<void>
```

Shorthand for `engine.cancel(handle.id)`.

### `update()`

```ts
async update(name: string, payload?: unknown, options?: { timeout?: number }): Promise<unknown>
```

Shorthand for `engine.update(handle.id, name, payload, options)`.

### `[Symbol.asyncIterator]()`

```ts
async *[Symbol.asyncIterator](): AsyncIterableIterator<Event>
```

Iterate over workflow lifecycle events as they happen. Yields events for `workflow:completed`, `workflow:failed`, `workflow:cancelled`, `activity:started`, `activity:completed`, and `signal:received`. The iterator completes when a terminal event (`completed`, `failed`, `cancelled`) fires.

```ts
for await (const event of handle) {
  console.log(event.type);
}
```

### `[Symbol.observable]()`

Returns an observable-compatible object with a `subscribe` method for frameworks that use the TC39 Observable proposal.

### `[Symbol.asyncDispose]()`

```ts
async [Symbol.asyncDispose](): Promise<void>
```

No-op disposal -- handles are lightweight and do not hold expensive resources.

---

## Types

### `EngineOptions`

```ts
interface EngineOptions {
  storage?: Storage;
  development?: boolean;
  serializer?: Serializer;
  checkpointHistory?: number;
  checkpointSizeWarningThreshold?: number;
  maxNestingDepth?: number;
  broadcastEvents?: boolean;
}
```

### `StartOptions`

```ts
interface StartOptions {
  id?: string;
  idempotencyKey?: string;
  executionTimeout?: Duration;
  searchAttributes?: Record<string, SearchAttributeValue>;
}
```

| Field              | Type                                   | Description                                                                                                                 |
| ------------------ | -------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `id`               | `string`                               | Explicit workflow ID. Auto-generated UUID if omitted.                                                                       |
| `idempotencyKey`   | `string`                               | Deduplication key for at-most-once starts                                                                                   |
| `executionTimeout` | `Duration`                             | Maximum wall-clock time before automatic cancellation. Accepts milliseconds or human-readable strings like `'30s'`, `'5m'`. |
| `searchAttributes` | `Record<string, SearchAttributeValue>` | Initial search attributes for the workflow                                                                                  |

### `ListFilter`

```ts
interface ListFilter {
  status?: WorkflowStatus | WorkflowStatus[];
  type?: string;
  attributes?: AttributeFilter[];
  limit?: number;
  offset?: number;
}
```

### `PaginatedResult<T>`

```ts
interface PaginatedResult<T> {
  items: T[];
  total: number;
  offset: number;
  limit: number;
}
```

### `WorkflowSummary`

```ts
interface WorkflowSummary {
  id: WorkflowId;
  type: string;
  status: WorkflowStatus;
  version: string;
  createdAt: number;
  updatedAt: number;
}
```

### `WorkflowStatus`

```ts
type WorkflowStatus = 'pending' | 'running' | 'completed' | 'failed' | 'cancelled' | 'timed-out';
```

### `WorkflowFunction`

```ts
type WorkflowFunction<TInput = unknown, TOutput = unknown> = (
  context: WorkflowContext,
  input: TInput,
) => AsyncGenerator<unknown, TOutput, unknown>;
```

### `WorkflowRegistration`

```ts
interface WorkflowRegistration<TInput = unknown, TOutput = unknown> {
  version?: string;
  handler: WorkflowFunction<TInput, TOutput>;
  migrate?: (checkpoint: unknown, fromVersion: string) => unknown;
  searchAttributes?: SearchAttributeSchema;
}
```

### `Duration`

```ts
type Duration = number | string;
```

Milliseconds as a number, or a human-readable string like `'1s'`, `'5m'`, `'2h'`.
