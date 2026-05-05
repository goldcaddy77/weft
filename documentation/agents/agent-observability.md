# Agent Observability

**Agent events:** The narrow event surface answers operational questions about turns, tools, checkpoint recovery, and human review. Subscribe through the `EventTarget` passed to `executeAgentLoop()` or the engine integration that dispatches agent events.

## Turn events

### `AgentTurnStartedEvent`

Fired before a provider call starts.

| Field                | Type     | Description                                     |
| -------------------- | -------- | ----------------------------------------------- |
| `workflowId`         | `string` | Workflow that owns the agent loop               |
| `agentId`            | `string` | Agent instance identifier                       |
| `turnIndex`          | `number` | Zero-based turn index                           |
| `model`              | `string` | Model identifier passed to the provider         |
| `inputTokenEstimate` | `number` | Estimated input tokens for the current turn     |
| `conversationLength` | `number` | Number of messages in the conversation snapshot |

```typescript
import { AgentTurnStartedEvent } from 'weft';

const events = new EventTarget();

events.addEventListener(AgentTurnStartedEvent.type, (event) => {
  const turn = event as AgentTurnStartedEvent;
  console.log(`turn ${turn.turnIndex} started on ${turn.model}`);
});
```

### `AgentTurnCompletedEvent`

Fired after a provider call completes.

| Field           | Type                 | Description                                 |
| --------------- | -------------------- | ------------------------------------------- |
| `workflowId`    | `string`             | Workflow that owns the agent loop           |
| `agentId`       | `string`             | Agent instance identifier                   |
| `turnIndex`     | `number`             | Zero-based turn index                       |
| `model`         | `string`             | Model that produced the response            |
| `inputTokens`   | `number`             | Input tokens reported for the turn          |
| `outputTokens`  | `number`             | Output tokens reported for the turn         |
| `duration`      | `number`             | Provider call duration in milliseconds      |
| `toolCallCount` | `number`             | Number of tool calls requested by the model |
| `messages`      | `readonly Message[]` | Size-bounded conversation snapshot          |

```typescript
import { AgentTurnCompletedEvent } from 'weft';

events.addEventListener(AgentTurnCompletedEvent.type, (event) => {
  const turn = event as AgentTurnCompletedEvent;
  console.log(`turn ${turn.turnIndex}: ${turn.toolCallCount} tool call(s)`);
});
```

## Tool events

### `AgentToolCalledEvent`

Fired immediately before a tool executes.

| Field         | Type      | Description                                       |
| ------------- | --------- | ------------------------------------------------- |
| `workflowId`  | `string`  | Workflow that owns the agent loop                 |
| `agentId`     | `string`  | Agent instance identifier                         |
| `turnIndex`   | `number`  | Turn that requested the tool                      |
| `toolName`    | `string`  | Tool definition name                              |
| `toolInput`   | `unknown` | Raw input supplied by the model                   |
| `operationId` | `string`  | Correlates the call with `AgentToolReturnedEvent` |

### `AgentToolReturnedEvent`

Fired after a tool finishes.

| Field         | Type      | Description                                       |
| ------------- | --------- | ------------------------------------------------- |
| `workflowId`  | `string`  | Workflow that owns the agent loop                 |
| `agentId`     | `string`  | Agent instance identifier                         |
| `turnIndex`   | `number`  | Turn that requested the tool                      |
| `toolName`    | `string`  | Tool definition name                              |
| `duration`    | `number`  | Tool execution duration in milliseconds           |
| `success`     | `boolean` | Whether the tool returned successfully            |
| `operationId` | `string`  | Correlates the result with `AgentToolCalledEvent` |

## Checkpoint event

### `AgentCheckpointResumedEvent`

Fired after an agent loop resumes and the effect log prevents one or more duplicate tool executions.

| Field                 | Type     | Description                                                 |
| --------------------- | -------- | ----------------------------------------------------------- |
| `workflowId`          | `string` | Workflow that owns the agent loop                           |
| `agentId`             | `string` | Agent instance identifier                                   |
| `duplicatesPrevented` | `number` | Tool calls replayed from committed records, not re-executed |

```typescript
import { AgentCheckpointResumedEvent } from 'weft';

events.addEventListener(AgentCheckpointResumedEvent.type, (event) => {
  const resumed = event as AgentCheckpointResumedEvent;
  console.log(`replayed ${resumed.duplicatesPrevented} committed tool result(s)`);
});
```

## Human review events

### `HumanReviewRequestedEvent`

| Field        | Type       | Description                         |
| ------------ | ---------- | ----------------------------------- |
| `workflowId` | `string`   | Workflow requesting review          |
| `reviewId`   | `string`   | Durable review request identifier   |
| `reviewType` | `string`   | Application-defined review category |
| `reviewers`  | `string[]` | Requested reviewer identifiers      |

### `HumanReviewCompletedEvent`

| Field        | Type     | Description                         |
| ------------ | -------- | ----------------------------------- |
| `workflowId` | `string` | Workflow that received the decision |
| `reviewId`   | `string` | Durable review request identifier   |
| `decision`   | `string` | Application-defined decision value  |
| `reviewer`   | `string` | Reviewer identifier                 |
| `duration`   | `number` | Time from request to completion     |

## Practical patterns

**Tool performance monitoring:** Pair `AgentToolCalledEvent` and `AgentToolReturnedEvent` by `operationId`. Record `duration`, `success`, `toolName`, `workflowId`, and `agentId` so slow tools are visible without inspecting provider traces.

```typescript
import { AgentToolReturnedEvent } from 'weft';

events.addEventListener(AgentToolReturnedEvent.type, (event) => {
  const result = event as AgentToolReturnedEvent;
  metrics.histogram('agent.tool.duration', result.duration, {
    tool: result.toolName,
    success: String(result.success),
  });
});
```

**Checkpoint resume monitoring:** Count `AgentCheckpointResumedEvent` occurrences and `duplicatesPrevented`. A nonzero count is usually good news: recovery happened and committed effects were not duplicated.

```typescript
import { AgentCheckpointResumedEvent } from 'weft';

events.addEventListener(AgentCheckpointResumedEvent.type, (event) => {
  const resumed = event as AgentCheckpointResumedEvent;
  metrics.counter('agent.checkpoint.duplicates_prevented', resumed.duplicatesPrevented);
});
```

Seven event types, each answering a specific operational question: _which turn is running?_ (turn events), _what tools are called and how fast?_ (tool events), _did a checkpoint restore replay any effects?_ (checkpoint event), _are humans in the loop?_ (review events). Subscribe to what you need.
