# Events API

Weft uses the standard `EventTarget` API for lifecycle observability. The `Engine` and `WorkflowHandle` classes both extend `EventTarget`, emitting strongly-typed event subclasses. Core events cover workflow and activity lifecycle; agent events cover AI-specific telemetry.

All event classes extend the built-in `Event` with a static `type` property matching the event string.

## Core Events

### `WorkflowStartedEvent`

Emitted when a workflow begins execution.

```ts
class WorkflowStartedEvent extends Event {
  static readonly type = 'workflow:started';
  readonly workflowId: string;
  readonly workflowType: string;
  readonly input: unknown;
}
```

### `WorkflowCompletedEvent`

Emitted when a workflow finishes successfully.

```ts
class WorkflowCompletedEvent extends Event {
  static readonly type = 'workflow:completed';
  readonly workflowId: string;
  readonly result: unknown;
  readonly duration: number; // milliseconds
}
```

### `WorkflowFailedEvent`

Emitted when a workflow throws an unhandled error.

```ts
class WorkflowFailedEvent extends Event {
  static readonly type = 'workflow:failed';
  readonly workflowId: string;
  readonly error: Error;
}
```

### `WorkflowCancelledEvent`

Emitted when a workflow is explicitly cancelled.

```ts
class WorkflowCancelledEvent extends Event {
  static readonly type = 'workflow:cancelled';
  readonly workflowId: string;
}
```

### `WorkflowTimedOutEvent`

Emitted when a workflow exceeds its execution or run deadline.

```ts
class WorkflowTimedOutEvent extends Event {
  static readonly type = 'workflow:timed-out';
  readonly workflowId: string;
  readonly timeoutType: 'execution' | 'run';
  readonly elapsed: number; // milliseconds
}
```

### `WorkflowResumedEvent`

Emitted when a paused or suspended workflow is explicitly resumed.

```ts
class WorkflowResumedEvent extends Event {
  static readonly type = 'workflow:resumed';
  readonly workflowId: string;
}
```

### `ActivityStartedEvent`

Emitted when an activity begins executing.

```ts
class ActivityStartedEvent extends Event {
  static readonly type = 'activity:started';
  readonly operationId: string;
  readonly workflowId: string;
  readonly activityName: string;
  readonly attempt: number;
}
```

### `ActivityCompletedEvent`

Emitted when an activity finishes successfully.

```ts
class ActivityCompletedEvent extends Event {
  static readonly type = 'activity:completed';
  readonly operationId: string;
  readonly workflowId: string;
  readonly activityName: string;
  readonly duration: number; // milliseconds
}
```

### `ActivityFailedEvent`

Emitted when an activity throws an error (may be retried).

```ts
class ActivityFailedEvent extends Event {
  static readonly type = 'activity:failed';
  readonly operationId: string;
  readonly workflowId: string;
  readonly activityName: string;
  readonly error: Error;
  readonly attempt: number;
}
```

### `SignalReceivedEvent`

Emitted when a signal is delivered to the engine for a workflow.

```ts
class SignalReceivedEvent extends Event {
  static readonly type = 'signal:received';
  readonly workflowId: string;
  readonly signalName: string;
  readonly payload: unknown;
}
```

### `SignalDeliveredEvent`

Emitted when a signal is consumed by a waiting workflow.

```ts
class SignalDeliveredEvent extends Event {
  static readonly type = 'signal:delivered';
  readonly workflowId: string;
  readonly signalName: string;
}
```

### `UpdateReceivedEvent`

Emitted when an update request is sent to a workflow.

```ts
class UpdateReceivedEvent extends Event {
  static readonly type = 'update:received';
  readonly updateId: string;
  readonly workflowId: string;
  readonly name: string;
  readonly payload: unknown;
}
```

### `UpdateCompletedEvent`

Emitted when an update handler finishes processing.

```ts
class UpdateCompletedEvent extends Event {
  static readonly type = 'update:completed';
  readonly updateId: string;
  readonly workflowId: string;
  readonly name: string;
  readonly result: unknown;
  readonly error: string | undefined;
}
```

### `AttributesChangedEvent`

Emitted when search attributes are persisted.

```ts
class AttributesChangedEvent extends Event {
  static readonly type = 'attributes:changed';
  readonly workflowId: string;
  readonly changes: Record<string, unknown>;
}
```

### `CheckpointSizeWarningEvent`

Emitted when a checkpoint exceeds the configured size threshold.

```ts
class CheckpointSizeWarningEvent extends Event {
  static readonly type = 'checkpoint:size-warning';
  readonly workflowId: string;
  readonly sizeBytes: number;
  readonly step: number;
}
```

### `DevelopmentWarningEvent`

Emitted in development mode when a checkpoint round-trip detects non-serializable fields.

```ts
class DevelopmentWarningEvent extends Event {
  static readonly type = 'development:warning';
  readonly workflowId: string;
  readonly message: string;
  readonly fieldPaths: string[];
}
```

### `StorageSizeReportedEvent`

Emitted periodically with storage utilization metrics.

```ts
class StorageSizeReportedEvent extends Event {
  static readonly type = 'storage:size-reported';
  readonly totalBytes: number;
  readonly entryCount: number;
}
```

### `AlertFiredEvent`

Emitted when a metric crosses an alert threshold.

```ts
class AlertFiredEvent extends Event {
  static readonly type = 'alert:fired';
  readonly metric: string;
  readonly value: number;
  readonly threshold: number;
}
```

### `AlertResolvedEvent`

Emitted when a previously fired alert metric returns below its threshold.

```ts
class AlertResolvedEvent extends Event {
  static readonly type = 'alert:resolved';
  readonly metric: string;
  readonly value: number;
}
```

### `ConstraintViolatedEvent`

Emitted when a quota or constraint is violated (e.g., tenant workflow creation rate limit).

```ts
class ConstraintViolatedEvent extends Event {
  static readonly type = 'constraint:violated';
  readonly constraint: string;
  readonly detail: string;
}
```

### `TokenEvent`

Emitted for streaming token output from AI agent operations.

```ts
class TokenEvent extends Event {
  static readonly type = 'agent:token';
  readonly workflowId: string;
  readonly token: string;
  readonly model: string;
}
```

---

## Agent Events

### `AgentTurnStartedEvent`

Emitted at the start of each agent LLM turn.

```ts
class AgentTurnStartedEvent extends Event {
  static readonly type = 'agent:turn:started';
  readonly workflowId: string;
  readonly agentId: string;
  readonly turnIndex: number;
  readonly model: string;
  readonly inputTokenEstimate: number;
  readonly conversationLength: number;
}
```

### `AgentTurnCompletedEvent`

Emitted when an agent turn finishes. Contains full cost and token telemetry.

```ts
class AgentTurnCompletedEvent extends Event {
  static readonly type = 'agent:turn:completed';
  readonly workflowId: string;
  readonly agentId: string;
  readonly turnIndex: number;
  readonly model: string;
  readonly selectedModel: string;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cost: number;
  readonly cumulativeCost: number;
  readonly duration: number;
  readonly toolCallCount: number;
  readonly fallbackAttempts: number;
  readonly reasoningTrace: string | undefined;
}
```

### `AgentToolCalledEvent`

Emitted when an agent invokes a tool.

```ts
class AgentToolCalledEvent extends Event {
  static readonly type = 'agent:tool:called';
  readonly workflowId: string;
  readonly agentId: string;
  readonly turnIndex: number;
  readonly toolName: string;
  readonly toolInput: unknown;
  readonly source: 'local' | 'mcp';
  readonly operationId: string;
}
```

### `AgentToolReturnedEvent`

Emitted when a tool call completes.

```ts
class AgentToolReturnedEvent extends Event {
  static readonly type = 'agent:tool:returned';
  readonly workflowId: string;
  readonly agentId: string;
  readonly turnIndex: number;
  readonly toolName: string;
  readonly duration: number;
  readonly success: boolean;
  readonly operationId: string;
}
```

### `AgentBudgetWarningEvent`

Emitted when an agent's budget consumption exceeds a warning threshold.

```ts
class AgentBudgetWarningEvent extends Event {
  static readonly type = 'agent:budget:warning';
  readonly workflowId: string;
  readonly agentId: string;
  readonly budgetUsedPercent: number;
  readonly tokensRemaining: number;
  readonly costRemaining: number;
  readonly threshold: number;
}
```

### `AgentBudgetExceededEvent`

Emitted when an agent exceeds its allocated budget.

```ts
class AgentBudgetExceededEvent extends Event {
  static readonly type = 'agent:budget:exceeded';
  readonly workflowId: string;
  readonly agentId: string;
  readonly tokensUsed: number;
  readonly costUsed: number;
  readonly tokenBudget: number;
  readonly maxCost: number;
}
```

### `AgentContextCompactedEvent`

Emitted when an agent's conversation history is compacted by a context strategy.

```ts
class AgentContextCompactedEvent extends Event {
  static readonly type = 'agent:context:compacted';
  readonly workflowId: string;
  readonly agentId: string;
  readonly strategy: string;
  readonly tokensBefore: number;
  readonly tokensAfter: number;
  readonly messagesDropped: number;
}
```

### `AgentCheckpointResumedEvent`

Emitted when an agent resumes from a persisted checkpoint after a process restart.

```ts
class AgentCheckpointResumedEvent extends Event {
  static readonly type = 'agent:checkpoint:resumed';
  readonly workflowId: string;
  readonly agentId: string;
  readonly turnIndex: number;
}
```

### `AgentModelFallbackEvent`

Emitted when a model call fails and the agent falls back to an alternative model.

```ts
class AgentModelFallbackEvent extends Event {
  static readonly type = 'agent:model:fallback';
  readonly workflowId: string;
  readonly agentId: string;
  readonly turnIndex: number;
  readonly failedModel: string;
  readonly failedReason: string;
  readonly nextModel: string;
  readonly attemptIndex: number;
}
```

### `AgentProviderCircuitOpenEvent`

Emitted when a provider's error rate trips the circuit breaker.

```ts
class AgentProviderCircuitOpenEvent extends Event {
  static readonly type = 'agent:provider:circuit-open';
  readonly provider: string;
  readonly errorRate: number;
  readonly threshold: number;
  readonly windowDuration: number;
}
```

### `HumanReviewRequestedEvent`

Emitted when an agent operation requires human review before proceeding.

```ts
class HumanReviewRequestedEvent extends Event {
  static readonly type = 'human-review:requested';
  readonly workflowId: string;
  readonly reviewId: string;
  readonly reviewType: string;
  readonly reviewers: string[];
}
```

### `HumanReviewCompletedEvent`

Emitted when a human review decision is submitted.

```ts
class HumanReviewCompletedEvent extends Event {
  static readonly type = 'human-review:completed';
  readonly workflowId: string;
  readonly reviewId: string;
  readonly decision: string;
  readonly reviewer: string;
  readonly duration: number;
}
```

---

## Event Map Types

### `WeftEventMap`

A complete mapping of event type strings to their event classes. Use this with `TypedEventTarget` for fully typed `addEventListener` calls.

```ts
interface WeftEventMap extends WeftAgentEventMap {
  'workflow:started': WorkflowStartedEvent;
  'workflow:completed': WorkflowCompletedEvent;
  'workflow:failed': WorkflowFailedEvent;
  'workflow:cancelled': WorkflowCancelledEvent;
  'workflow:timed-out': WorkflowTimedOutEvent;
  'workflow:resumed': WorkflowResumedEvent;
  'activity:started': ActivityStartedEvent;
  'activity:completed': ActivityCompletedEvent;
  'activity:failed': ActivityFailedEvent;
  'agent:token': TokenEvent;
  'signal:received': SignalReceivedEvent;
  'signal:delivered': SignalDeliveredEvent;
  'attributes:changed': AttributesChangedEvent;
  'update:received': UpdateReceivedEvent;
  'update:completed': UpdateCompletedEvent;
  'checkpoint:size-warning': CheckpointSizeWarningEvent;
  'development:warning': DevelopmentWarningEvent;
  'storage:size-reported': StorageSizeReportedEvent;
  'alert:fired': AlertFiredEvent;
  'alert:resolved': AlertResolvedEvent;
  'constraint:violated': ConstraintViolatedEvent;
}
```

### `WeftAgentEventMap`

The agent-specific subset of the event map.

```ts
interface WeftAgentEventMap {
  'agent:turn:started': AgentTurnStartedEvent;
  'agent:turn:completed': AgentTurnCompletedEvent;
  'agent:tool:called': AgentToolCalledEvent;
  'agent:tool:returned': AgentToolReturnedEvent;
  'agent:budget:warning': AgentBudgetWarningEvent;
  'agent:budget:exceeded': AgentBudgetExceededEvent;
  'agent:context:compacted': AgentContextCompactedEvent;
  'agent:checkpoint:resumed': AgentCheckpointResumedEvent;
  'agent:model:fallback': AgentModelFallbackEvent;
  'agent:provider:circuit-open': AgentProviderCircuitOpenEvent;
  'human-review:requested': HumanReviewRequestedEvent;
  'human-review:completed': HumanReviewCompletedEvent;
}
```

### `TypedEventTarget`

A utility type that narrows `addEventListener` and `removeEventListener` to accept only known event types with their correct event class.

```ts
interface TypedEventTarget<TEventMap extends Record<string, Event>> {
  addEventListener<K extends keyof TEventMap & string>(
    type: K,
    listener: (event: TEventMap[K]) => void,
    options?: boolean | AddEventListenerOptions,
  ): void;
  removeEventListener<K extends keyof TEventMap & string>(
    type: K,
    listener: (event: TEventMap[K]) => void,
    options?: boolean | EventListenerOptions,
  ): void;
}
```

### Listening to Events

```ts
engine.addEventListener('workflow:completed', (event) => {
  // event is WorkflowCompletedEvent
  console.log(`Workflow ${event.workflowId} completed in ${event.duration}ms`);
});

engine.addEventListener('activity:failed', (event) => {
  // event is ActivityFailedEvent
  console.error(`Activity ${event.activityName} failed on attempt ${event.attempt}:`, event.error);
});
```
