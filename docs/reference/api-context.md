# Context API

The `Context` class is the workflow's view of the durable execution runtime. It is the `context` parameter passed as the first argument to every workflow generator function. Each durable method is a generator that yields a `ContextOperationRequest` descriptor back to the engine -- the engine handles execution and feeds results back via `generator.next(result)`.

Context does not execute activities or interact with storage directly.

## `Context`

```ts
class Context implements WorkflowContext
```

### Constructor

```ts
new Context(options: ContextOptions)
```

Typically constructed by the engine -- you will not create `Context` instances directly.

### Read-only Properties

| Property                 | Type          | Description                                                              |
| ------------------------ | ------------- | ------------------------------------------------------------------------ |
| `workflowId`             | `string`      | The workflow's unique identifier                                         |
| `workflowType`           | `string`      | The registered workflow type name                                        |
| `startedAt`              | `number`      | Epoch timestamp when the workflow started                                |
| `signal`                 | `AbortSignal` | Abort signal -- fires when the workflow is cancelled                     |
| `executionTimeRemaining` | `number`      | Milliseconds until execution deadline. `Infinity` if no deadline is set. |
| `stepIndex`              | `number`      | Current step counter (incremented by each durable operation)             |

---

## Durable Operations

Each durable method is a generator. Inside a workflow, call them with `yield*`:

```ts
const result = yield * context.run(myActivity, 'arg1', 'arg2');
```

### `run()`

```ts
*run<TResult>(
  fn: (...args: unknown[]) => Promise<TResult> | TResult,
  ...args: unknown[]
): Generator<ContextOperationRequest, TResult, unknown>
```

Execute an activity function durably. The engine checkpoints before the call and records the result. On replay, cached results are returned without re-executing the activity.

| Parameter | Type        | Description                      |
| --------- | ----------- | -------------------------------- |
| `fn`      | `Function`  | The activity function to execute |
| `...args` | `unknown[]` | Arguments passed to the activity |

**Returns:** The activity's return value.

```ts
async function* orderWorkflow(context: Context, order: Order) {
  const receipt = yield* context.run(chargeCard, order.cardToken, order.total);
  yield* context.run(sendConfirmation, order.email, receipt);
  return receipt;
}
```

### `sleep()`

```ts
*sleep(duration: Duration): Generator<ContextOperationRequest, void, unknown>
```

Pause the workflow for the given duration. The sleep is durable -- if the process restarts, the timer resumes from where it left off.

| Parameter  | Type       | Description                                                 |
| ---------- | ---------- | ----------------------------------------------------------- |
| `duration` | `Duration` | Milliseconds or a human-readable string like `'5m'`, `'1h'` |

```ts
yield * context.sleep('30s');
yield * context.sleep(5000);
```

### `waitForSignal()`

```ts
*waitForSignal<T = unknown>(name: string): Generator<ContextOperationRequest, T, unknown>
```

Suspend the workflow until a named signal is delivered. If the signal was already sent before the workflow reached this point, it is consumed immediately.

| Parameter | Type     | Description                 |
| --------- | -------- | --------------------------- |
| `name`    | `string` | The signal name to wait for |

**Returns:** The signal's payload, typed as `T`.

```ts
const approval = yield * context.waitForSignal<{ approved: boolean }>('approval');
if (!approval.approved) {
  return { status: 'rejected' };
}
```

### `waitForUpdate()`

```ts
*waitForUpdate<T = unknown>(name: string): Generator<ContextOperationRequest, T, unknown>
```

Suspend the workflow until a named update is received. Similar to `waitForSignal` but designed for request/response-style interactions.

| Parameter | Type     | Description                 |
| --------- | -------- | --------------------------- |
| `name`    | `string` | The update name to wait for |

**Returns:** The update payload, typed as `T`.

### `all()`

```ts
*all(
  operations: Generator<ContextOperationRequest, unknown, unknown>[],
): Generator<ContextOperationRequest, unknown[], unknown>
```

Run multiple durable operations in parallel. All operations must complete before the workflow continues. Analogous to `Promise.all`.

| Parameter    | Type          | Description                                                         |
| ------------ | ------------- | ------------------------------------------------------------------- |
| `operations` | `Generator[]` | An array of generators from `context.run()`, `context.memo()`, etc. |

**Returns:** An array of results in the same order as the input operations.

```ts
const [user, inventory] =
  yield * context.all([context.run(fetchUser, userId), context.run(checkInventory, sku)]);
```

### `race()`

```ts
*race(
  operations: Generator<ContextOperationRequest, unknown, unknown>[],
): Generator<ContextOperationRequest, unknown, unknown>
```

Run multiple durable operations in parallel, returning the result of whichever completes first. Analogous to `Promise.race`.

| Parameter    | Type          | Description            |
| ------------ | ------------- | ---------------------- |
| `operations` | `Generator[]` | An array of generators |

**Returns:** The result of the first operation to complete.

```ts
const result =
  yield * context.race([context.run(fetchFromPrimary, key), context.run(fetchFromFallback, key)]);
```

### `memo()`

```ts
*memo<T>(key: string, fn: () => T | Promise<T>): Generator<ContextOperationRequest, T, unknown>
```

Execute a function and cache its result by key. On replay or repeated calls with the same key, the cached value is returned without re-executing. Useful for non-deterministic computations that must produce the same value across replays (e.g., generating an ID).

| Parameter | Type                    | Description                            |
| --------- | ----------------------- | -------------------------------------- |
| `key`     | `string`                | Cache key for deduplication            |
| `fn`      | `() => T \| Promise<T>` | Function to compute the memoized value |

**Returns:** The memoized result.

```ts
const correlationId = yield * context.memo('correlationId', () => crypto.randomUUID());
```

### `runAll()`

```ts
*runAll<T extends Record<string, [Function, ...unknown[]]>>(
  branches: T,
): Generator<ContextOperationRequest, Record<keyof T, unknown>, unknown>
```

Run multiple named activity branches in parallel. Returns a record mapping each branch name to its result.

| Parameter  | Type                                  | Description                                           |
| ---------- | ------------------------------------- | ----------------------------------------------------- |
| `branches` | `Record<string, [Function, ...args]>` | Named branches, each a tuple of `[function, ...args]` |

**Returns:** A record with the same keys, each holding the branch's result.

```ts
const results =
  yield *
  context.runAll({
    email: [sendEmail, user.email, 'Welcome!'],
    slack: [notifySlack, '#signups', user.name],
  });
// results.email, results.slack
```

### `offload()`

```ts
*offload<T>(
  key: string,
  fn: () => Promise<T>,
): Generator<ContextOperationRequest, OffloadReference, unknown>
```

Move large data out of the checkpoint by computing it and storing it externally. The function `fn` is called to produce the data, which is then encoded with MessagePack and persisted at a storage key derived from the workflow ID and the provided `key`. Returns an `OffloadReference` that can be passed to `load()` later to retrieve the data.

| Parameter | Type               | Description                                                      |
| --------- | ------------------ | ---------------------------------------------------------------- |
| `key`     | `string`           | A unique identifier for this offloaded data within the workflow. |
| `fn`      | `() => Promise<T>` | An async function that produces the data to offload.             |

**Returns:** `OffloadReference` — an object containing `key`, `workflowId`, and `sizeBytes` (the byte length of the encoded data).

```ts
const reference =
  yield *
  context.offload('large-dataset', async () => {
    return await fetchLargeDataset();
  });
// reference.sizeBytes tells you how large the stored data is
// Pass reference to load() when you need the data again
const data = yield * context.load(reference);
```

### `load()`

```ts
*load<T>(reference: OffloadReference): Generator<ContextOperationRequest, T, unknown>
```

Load data that was previously offloaded via `offload()`. Reads the encoded data from storage using the reference's `workflowId` and `key`, decodes it, and returns the original value. Throws if the data is not found in storage.

| Parameter   | Type               | Description                                            |
| ----------- | ------------------ | ------------------------------------------------------ |
| `reference` | `OffloadReference` | The reference returned by a previous `offload()` call. |

**Returns:** `T` — the decoded data that was originally offloaded.

```ts
const reference = yield * context.offload('large-dataset', async () => bigData);
// ... later in the workflow, or even after recovery ...
const data = yield * context.load<MyDataType>(reference);
```

### `archive()`

```ts
*archive(key: string, data: unknown): Generator<ContextOperationRequest, void, unknown>
```

Persist data to external archive storage, separate from the checkpoint. The data is encoded with MessagePack and stored at a key derived from the workflow ID and the provided `key`. Unlike `offload()`, archive is write-only from the workflow's perspective — the data is meant for auditing, debugging, or external queries rather than retrieval within the same workflow.

| Parameter | Type      | Description                                                     |
| --------- | --------- | --------------------------------------------------------------- |
| `key`     | `string`  | A unique identifier for this archived data within the workflow. |
| `data`    | `unknown` | The data to archive. Must be structuredClone-compatible.        |

**Returns:** `void`

```ts
yield *
  context.archive('processing-result-batch-1', {
    processedAt: new Date(),
    recordCount: records.length,
    summary: computeSummary(records),
  });
```

### `agent()`

```ts
*agent(options: AgentContextOptions): Generator<ContextOperationRequest, unknown, unknown>
```

Execute an AI agent loop as a durable operation. See the agent guides for details on `AgentContextOptions`.

---

## Synchronous Operations

These methods do not yield and can be called directly (no `yield*`).

### `setAttribute()`

```ts
setAttribute(key: string, value: SearchAttributeValue): void
```

Set a single search attribute on the workflow. The change is batched and persisted at the next checkpoint.

### `setAttributes()`

```ts
setAttributes(attributes: Record<string, SearchAttributeValue>): void
```

Set multiple search attributes at once.

### `getAttribute()`

```ts
getAttribute<T extends SearchAttributeValue = SearchAttributeValue>(key: string): T | undefined
```

Read a search attribute by key.

### `getAttributes()`

```ts
getAttributes(): Readonly<Record<string, SearchAttributeValue>>
```

Read all search attributes as a frozen snapshot.

### `onUpdate()`

```ts
onUpdate(name: string, handler: (payload: unknown) => unknown): void
```

Register a synchronous handler for named updates. When `engine.update()` is called with this name, the handler runs immediately and its return value is sent back to the caller.

```ts
let progress = 0;
context.onUpdate('getProgress', () => progress);
```

### `expose()`

```ts
expose(accessors: Record<string, () => unknown>): void
```

Expose named read-only accessors for external introspection.

### `explain()`

```ts
explain(enabled?: boolean): void
```

Enable or disable explain mode. When enabled, durable operations log detailed checkpoint and dispatch information to the console. Useful for debugging workflow replay behavior.

### `setBudget()`

```ts
setBudget(options: BudgetOptions): void
```

Attach a budget tracker to this context for agent cost/token tracking.

### `budgetRemaining()`

```ts
budgetRemaining(): BudgetState | undefined
```

Query the current budget state. Returns `undefined` if no budget is set.

---

## Types

### `ContextOptions`

```ts
interface ContextOptions {
  workflowId: string;
  workflowType: string;
  startedAt: number;
  abortController: AbortController;
  deadline?: number;
  initialStep?: number;
  accumulatedResults?: Map<number, unknown>;
  searchAttributes?: Record<string, SearchAttributeValue>;
  getNow?: () => number;
}
```

### `ContextOperationRequest`

A discriminated union describing the operation the workflow wants the engine to perform:

```ts
type ContextOperationRequest =
  | { type: 'activity'; operationId: string; activityName: string; fn: Function; args: unknown[]; ... }
  | { type: 'sleep'; operationId: string; duration: number; scheduledFireAt: number }
  | { type: 'wait-signal'; operationId: string; signalName: string }
  | { type: 'wait-update'; operationId: string; updateName: string }
  | { type: 'parallel'; operationId: string; operations: ContextOperationRequest[] }
  | { type: 'race'; operationId: string; operations: ContextOperationRequest[] }
  | { type: 'memo'; operationId: string; key: string; fn: () => unknown }
  | { type: 'child-workflow'; operationId: string; workflowType: string; input: unknown; ... }
  | { type: 'offload'; operationId: string; key: string; fn: () => Promise<unknown> }
  | { type: 'load'; operationId: string; reference: OffloadReference }
  | { type: 'archive'; operationId: string; key: string; data: unknown }
  | { type: 'run-all'; operationId: string; branches: Record<string, [Function, ...unknown[]]> }
  | { type: 'agent'; operationId: string; options: AgentContextOptions }
```

### `OffloadReference`

```ts
interface OffloadReference {
  key: string;
  workflowId: string;
  sizeBytes: number;
}
```
