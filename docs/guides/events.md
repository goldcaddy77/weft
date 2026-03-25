# Events

You want to know when a workflow starts, when an activity fails, when a signal arrives. You want to build dashboards, trigger side effects, stream progress to a UI. Weft gives you all of that through a single, familiar interface: `EventTarget`.

## EventTarget, not EventEmitter

Both `Engine` and `WorkflowHandle` extend `EventTarget`---the same interface that DOM elements, `WebSocket`, `AbortSignal`, and `BroadcastChannel` use. No custom event emitter. No `.on()` / `.off()` / `.emit()`. Just `addEventListener`, `removeEventListener`, and `dispatchEvent`.

```typescript
engine.addEventListener('workflow:completed', (event) => {
  console.log(`Workflow ${event.workflowId} completed in ${event.duration}ms`);
});
```

This is a deliberate choice. `EventTarget` is a web standard with built-in support for `AbortSignal`-based cleanup, `once` listeners, and capture/bubble phases. Every JavaScript developer already knows the API.

## Typed event subclasses

Weft defines proper `Event` subclasses rather than wrapping data in `CustomEvent` with a `.detail` bag. This means you get named properties directly on the event object and full TypeScript inference without casts.

```typescript
engine.addEventListener(WorkflowCompletedEvent.type, (event) => {
  // event.workflowId: string
  // event.result: unknown
  // event.duration: number
});
```

Each event class has a static `type` property that matches its event string. Use the class reference instead of raw strings---it keeps things type-safe and refactor-friendly.

## Core event types

Here is the full set of events the engine dispatches during a workflow's lifecycle.

_Workflow events:_

- `WorkflowStartedEvent` (`'workflow:started'`) -- carries `workflowId`, `workflowType`, and `input`
- `WorkflowCompletedEvent` (`'workflow:completed'`) -- carries `workflowId`, `result`, and `duration`
- `WorkflowFailedEvent` (`'workflow:failed'`) -- carries `workflowId` and `error` (an `Error` instance)
- `WorkflowCancelledEvent` (`'workflow:cancelled'`) -- carries `workflowId`
- `WorkflowTimedOutEvent` (`'workflow:timed-out'`) -- carries `workflowId`, `timeoutType` (`'execution'` or `'run'`), and `elapsed`

_Activity events:_

- `ActivityStartedEvent` (`'activity:started'`) -- carries `operationId`, `workflowId`, `activityName`, and `attempt`
- `ActivityCompletedEvent` (`'activity:completed'`) -- carries `operationId`, `workflowId`, `activityName`, and `duration`
- `ActivityFailedEvent` (`'activity:failed'`) -- carries `operationId`, `workflowId`, `activityName`, `error`, and `attempt`

_Signal and update events:_

- `SignalReceivedEvent` (`'signal:received'`) -- carries `workflowId`, `signalName`, and `payload`
- `SignalDeliveredEvent` (`'signal:delivered'`) -- carries `workflowId` and `signalName`
- `UpdateReceivedEvent` (`'update:received'`) -- carries `updateId`, `workflowId`, `name`, and `payload`
- `UpdateCompletedEvent` (`'update:completed'`) -- carries `updateId`, `workflowId`, `name`, `result`, and optional `error`

_Operational events:_

- `AttributesChangedEvent` (`'attributes:changed'`) -- carries `workflowId` and `changes`
- `CheckpointSizeWarningEvent` (`'checkpoint:size-warning'`) -- carries `workflowId`, `sizeBytes`, and `step`
- `DevelopmentWarningEvent` (`'development:warning'`) -- carries `workflowId`, `message`, and `fieldPaths`

## Agent events

When running AI agent [workflows](workflows.md), a separate set of events tracks agent-specific behavior.

- `AgentTurnStartedEvent` (`'agent:turn:started'`) -- carries `workflowId`, `agentId`, `turnIndex`, `model`, `inputTokenEstimate`, and `conversationLength`
- `AgentTurnCompletedEvent` (`'agent:turn:completed'`) -- carries detailed metrics: `inputTokens`, `outputTokens`, `cost`, `cumulativeCost`, `duration`, `toolCallCount`, `fallbackAttempts`, and optional `reasoningTrace`
- `AgentToolCalledEvent` (`'agent:tool:called'`) -- carries `toolName`, `toolInput`, `source` (`'local'` or `'mcp'`), and `operationId`
- `AgentToolReturnedEvent` (`'agent:tool:returned'`) -- carries `toolName`, `duration`, `success`, and `operationId`
- `AgentBudgetWarningEvent` (`'agent:budget:warning'`) -- fires when budget usage crosses a threshold
- `AgentBudgetExceededEvent` (`'agent:budget:exceeded'`) -- fires when the budget is fully consumed
- `AgentContextCompactedEvent` (`'agent:context:compacted'`) -- fires when the context window is trimmed, with `tokensBefore`, `tokensAfter`, and `messagesDropped`
- `AgentModelFallbackEvent` (`'agent:model:fallback'`) -- fires when a model fails and the router falls back to another
- `AgentProviderCircuitOpenEvent` (`'agent:provider:circuit-open'`) -- fires when a provider's error rate trips the circuit breaker
- `HumanReviewRequestedEvent` (`'human-review:requested'`) -- carries `reviewId`, `reviewType`, and `reviewers`
- `HumanReviewCompletedEvent` (`'human-review:completed'`) -- carries `reviewId`, `decision`, `reviewer`, and `duration`

## The WeftEventMap

All event types are collected into `WeftEventMap`, a TypeScript interface that maps event type strings to their concrete event classes. You can use it with the `TypedEventTarget` interface for full type safety.

```typescript
import type { WeftEventMap, TypedEventTarget } from 'weft';

const typedEngine = engine as unknown as TypedEventTarget<WeftEventMap>;

typedEngine.addEventListener('workflow:completed', (event) => {
  // event is WorkflowCompletedEvent -- fully typed
  console.log(event.duration);
});
```

## Three consumption patterns

_Pattern 1: addEventListener._ The classic approach. Best for persistent listeners that run for the lifetime of the engine.

```typescript
const controller = new AbortController();

engine.addEventListener(
  WorkflowCompletedEvent.type,
  (event) => {
    metrics.recordCompletion(event.workflowId, event.duration);
  },
  { signal: controller.signal },
);

// Later, clean up all listeners at once:
controller.abort();
```

Using `AbortSignal` for cleanup is the modern best practice. One `abort()` call removes every listener you attached with that signal---no need to track individual references.

_Pattern 2: Async iteration._ `WorkflowHandle` implements `Symbol.asyncIterator`, so you can `for await...of` over events from a specific workflow.

```typescript
const handle = await engine.start('order', orderData);

for await (const event of handle) {
  if (event.type === 'activity:completed') {
    console.log('Activity done');
  }
  if (event.type === 'workflow:completed') {
    console.log('Workflow finished');
    break; // terminal events end the iteration automatically
  }
}
```

This is useful for streaming progress to a client or building real-time UIs. The iterator yields events as they happen and terminates when the workflow reaches a terminal state (completed, failed, or cancelled).

_Pattern 3: Observable._ `WorkflowHandle` also implements `Symbol.observable`, making it compatible with RxJS and other reactive libraries.

```typescript
const handle = await engine.start('order', orderData);
const observable = handle[Symbol.observable]();

const subscription = observable.subscribe({
  next(event) {
    console.log(event.type);
  },
  complete() {
    console.log('Workflow finished');
  },
  error(err) {
    console.error('Workflow failed:', err);
  },
});

// Later:
subscription.unsubscribe();
```

Pick the pattern that fits your use case. `addEventListener` for global engine-level observability, async iteration for following a single workflow, and Observable when you are already in a reactive pipeline.
