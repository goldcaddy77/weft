# Signals and Queries

Sometimes a workflow needs to wait for something that is not an activity result or a timer. An approval from a human. A webhook from a payment provider. A configuration change pushed from an admin panel. Signals let you send data _into_ a running workflow from the outside world.

## Waiting for a signal

Inside a workflow, `yield* ctx.waitForSignal<T>(name)` pauses execution until a signal with that name arrives. The workflow is checkpointed at the pause point---it costs nothing to wait, even for days.

```typescript
engine.register('approval', async function* (ctx, input) {
  const { orderId } = input as { orderId: string };

  // Pauses here until 'approval' signal arrives
  const approval = yield* ctx.waitForSignal<{ approved: boolean }>('approval');

  if (approval.approved) {
    yield* ctx.run(fulfillOrder, orderId);
  } else {
    yield* ctx.run(cancelOrder, orderId);
  }

  return { orderId, approved: approval.approved };
});
```

The generic type parameter `<{ approved: boolean }>` is purely for TypeScript---it gives you type safety on the returned payload.

## Sending a signal

From outside the workflow, use `engine.signal()` or `handle.signal()` to deliver data.

```typescript
const handle = await engine.start('approval', { orderId: 'order-1' });

// Some time later, when the human clicks "Approve":
await engine.signal(handle.id, 'approval', { approved: true });

const result = await handle.result();
// { orderId: 'order-1', approved: true }
```

You can also signal through the handle directly.

```typescript
await handle.signal('approval', { approved: true });
```

Both forms do the same thing. The handle version is convenient when you already have a reference; the engine version is useful when you only have a workflow ID (for example, from a webhook handler or a message queue consumer).

## Signal durability

Signals are persisted to [storage](storage.md) when they are sent. This means:

- If a signal arrives _before_ the workflow reaches its `waitForSignal` call, it is buffered in storage and delivered immediately when the workflow gets there.
- If the process crashes after a signal is sent but before it is consumed, the signal survives the restart and is delivered on recovery.
- Signals are fire-and-forget from the sender's perspective---`engine.signal()` resolves as soon as the signal is persisted, without waiting for the workflow to consume it.

This durability guarantee is what makes signals safe for human-in-the-loop workflows. You do not need to worry about race conditions between signal delivery and workflow execution.

## Multiple signals

A workflow can wait for multiple signals, either sequentially or with different names.

```typescript
engine.register('multi-step-approval', async function* (ctx, input) {
  const { orderId } = input as { orderId: string };

  // Wait for manager approval
  const manager = yield* ctx.waitForSignal<{ approved: boolean }>('manager-approval');
  if (!manager.approved) return { orderId, status: 'rejected-by-manager' };

  // Then wait for finance approval
  const finance = yield* ctx.waitForSignal<{ approved: boolean }>('finance-approval');
  if (!finance.approved) return { orderId, status: 'rejected-by-finance' };

  yield* ctx.run(fulfillOrder, orderId);
  return { orderId, status: 'approved' };
});
```

Each `waitForSignal` is an independent checkpoint boundary with its own signal name.

## Querying workflow state

You can inspect workflows from outside through the engine's `list()` method, which supports filtering by status and type.

```typescript
const running = await engine.list({ status: 'running' });
const failed = await engine.list({ status: 'failed', type: 'order' });
const all = await engine.list({ limit: 50, offset: 0 });
```

The result is paginated.

```typescript
interface PaginatedResult<T> {
  items: T[];
  total: number;
  offset: number;
  limit: number;
}
```

Each item is a `WorkflowSummary` with the workflow's `id`, `type`, `status`, `version`, `createdAt`, and `updatedAt`. This is enough to build dashboards, monitoring, and administrative tooling without querying the underlying storage directly.

For richer state inspection, workflows can set search attributes via `ctx.setAttribute()` and `ctx.setAttributes()`, which are indexed and queryable. See the [workflows guide](workflows.md) for details on search attributes.

Signals turn your workflows into interactive, event-driven processes. Combined with [durable timers](durable-timers.md), you can model arbitrarily complex human-in-the-loop processes---approval chains, escalation deadlines, SLA monitoring---all within a single workflow function.
