# Agent Observability

A traditional workflow dashboard shows "step 1 completed, step 2 running, step 3 pending." That's not enough for agents. You need to see the reasoning trace, token usage per turn, tool call results in context, cumulative cost, and real-time streaming output. Weft's agent subsystem emits 13 event types that give you all of this through the standard `EventTarget` system.

## The event taxonomy

Every agent event extends the Web `Event` class and has a static `type` string. Register listeners with `addEventListener` on either the engine or a workflow handle.

### AgentTurnStartedEvent

**Type string:** `agent:turn:started`

Fires before each LLM call.

| Field                | Type     | Description                            |
| -------------------- | -------- | -------------------------------------- |
| `workflowId`         | `string` | The workflow this agent belongs to     |
| `agentId`            | `string` | The agent's identifier                 |
| `turnIndex`          | `number` | Zero-based turn counter                |
| `model`              | `string` | The model being used for this turn     |
| `inputTokenEstimate` | `number` | Estimated input tokens                 |
| `conversationLength` | `number` | Number of messages in the conversation |

### AgentTurnCompletedEvent

**Type string:** `agent:turn:completed`

Fires after each LLM response and any tool calls in that turn.

| Field              | Type                  | Description                                                                                                                                        |
| ------------------ | --------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `workflowId`       | `string`              | The workflow this agent belongs to                                                                                                                 |
| `agentId`          | `string`              | The agent's identifier                                                                                                                             |
| `turnIndex`        | `number`              | Zero-based turn counter                                                                                                                            |
| `model`            | `string`              | The default model                                                                                                                                  |
| `selectedModel`    | `string`              | The model actually used (may differ if routed)                                                                                                     |
| `inputTokens`      | `number`              | Input tokens consumed this turn                                                                                                                    |
| `outputTokens`     | `number`              | Output tokens generated this turn                                                                                                                  |
| `cost`             | `number`              | Cost for this turn in USD                                                                                                                          |
| `cumulativeCost`   | `number`              | Total cost across all turns so far                                                                                                                 |
| `duration`         | `number`              | Wall-clock time in milliseconds                                                                                                                    |
| `toolCallCount`    | `number`              | Number of tool calls made this turn                                                                                                                |
| `fallbackAttempts` | `number`              | How many fallback models were tried                                                                                                                |
| `reasoningTrace`   | `string \| undefined` | Extended thinking content, if available                                                                                                            |
| `messages`         | `readonly Message[]`  | Size-bounded snapshot of the conversation at turn completion (truncated per `MAX_MESSAGE_CHARS`, `MAX_TOOL_RESULT_CHARS`, `MAX_SNAPSHOT_MESSAGES`) |

This is the richest event in the system. Use it to build cost waterfalls, latency charts, and per-turn breakdowns.

### AgentToolCalledEvent

**Type string:** `agent:tool:called`

Fires before each tool invocation.

| Field         | Type               | Description                                                |
| ------------- | ------------------ | ---------------------------------------------------------- |
| `workflowId`  | `string`           | The workflow this agent belongs to                         |
| `agentId`     | `string`           | The agent's identifier                                     |
| `turnIndex`   | `number`           | Which turn triggered this tool call                        |
| `toolName`    | `string`           | Name of the tool being called                              |
| `toolInput`   | `unknown`          | The input the model sent to the tool                       |
| `source`      | `'local' \| 'mcp'` | Whether the tool is a local function or from an MCP server |
| `operationId` | `string`           | Unique ID linking this call to its return event            |

### AgentToolReturnedEvent

**Type string:** `agent:tool:returned`

Fires after each tool returns.

| Field         | Type      | Description                                           |
| ------------- | --------- | ----------------------------------------------------- |
| `workflowId`  | `string`  | The workflow this agent belongs to                    |
| `agentId`     | `string`  | The agent's identifier                                |
| `turnIndex`   | `number`  | Which turn this tool call belongs to                  |
| `toolName`    | `string`  | Name of the tool                                      |
| `duration`    | `number`  | Execution time in milliseconds                        |
| `success`     | `boolean` | Whether the tool succeeded                            |
| `operationId` | `string`  | Matches the `operationId` from `AgentToolCalledEvent` |

Pair `AgentToolCalledEvent` and `AgentToolReturnedEvent` by `operationId` to measure per-tool latency and success rates.

### AgentBudgetWarningEvent

**Type string:** `agent:budget:warning`

Fires when the budget warning threshold is crossed (default 80%).

| Field               | Type     | Description                                |
| ------------------- | -------- | ------------------------------------------ |
| `workflowId`        | `string` | The workflow this agent belongs to         |
| `agentId`           | `string` | The agent's identifier                     |
| `budgetUsedPercent` | `number` | Current budget utilization as a percentage |
| `tokensRemaining`   | `number` | Tokens left before the limit               |
| `costRemaining`     | `number` | USD remaining before the limit             |
| `threshold`         | `number` | The warning threshold that was crossed     |

### AgentBudgetExceededEvent

**Type string:** `agent:budget:exceeded`

Fires when the budget is exhausted.

| Field         | Type     | Description                        |
| ------------- | -------- | ---------------------------------- |
| `workflowId`  | `string` | The workflow this agent belongs to |
| `agentId`     | `string` | The agent's identifier             |
| `tokensUsed`  | `number` | Total tokens consumed              |
| `costUsed`    | `number` | Total cost in USD                  |
| `tokenBudget` | `number` | The configured token limit         |
| `maxCost`     | `number` | The configured cost limit          |

### AgentContextCompactedEvent

**Type string:** `agent:context:compacted`

Fires when a [context strategy](./agent-context-window.md) compacts the conversation.

| Field             | Type     | Description                                    |
| ----------------- | -------- | ---------------------------------------------- |
| `workflowId`      | `string` | The workflow this agent belongs to             |
| `agentId`         | `string` | The agent's identifier                         |
| `strategy`        | `string` | Name of the strategy that triggered compaction |
| `tokensBefore`    | `number` | Token count before compaction                  |
| `tokensAfter`     | `number` | Token count after compaction                   |
| `messagesDropped` | `number` | How many messages were removed                 |

### AgentModelFallbackEvent

**Type string:** `agent:model:fallback`

Fires when a model fails and the engine tries the next one in the [fallback chain](./agent-model-routing.md).

| Field          | Type     | Description                              |
| -------------- | -------- | ---------------------------------------- |
| `workflowId`   | `string` | The workflow this agent belongs to       |
| `agentId`      | `string` | The agent's identifier                   |
| `turnIndex`    | `number` | Which turn experienced the failure       |
| `failedModel`  | `string` | The model that failed                    |
| `failedReason` | `string` | Why it failed                            |
| `nextModel`    | `string` | The fallback model being tried           |
| `attemptIndex` | `number` | Which fallback attempt this is (0-based) |

### AgentProviderCircuitOpenEvent

**Type string:** `agent:provider:circuit-open`

Fires when a [provider's circuit breaker](./agent-provider-health.md) trips.

| Field            | Type     | Description                                 |
| ---------------- | -------- | ------------------------------------------- |
| `provider`       | `string` | The provider that was excluded              |
| `errorRate`      | `number` | The error rate that triggered the circuit   |
| `threshold`      | `number` | The configured error threshold              |
| `windowDuration` | `number` | The sliding window duration in milliseconds |

Note that this event doesn't carry `workflowId` or `agentId`—circuit breaker state is per-provider, not per-workflow.

### HumanReviewRequestedEvent

**Type string:** `human-review:requested`

Fires when a [human review](./agent-human-review.md) is created.

| Field        | Type       | Description                                 |
| ------------ | ---------- | ------------------------------------------- |
| `workflowId` | `string`   | The workflow requesting review              |
| `reviewId`   | `string`   | Unique identifier for this review           |
| `reviewType` | `string`   | The type of review (e.g., `'legal-review'`) |
| `reviewers`  | `string[]` | Who was asked to review                     |

### HumanReviewCompletedEvent

**Type string:** `human-review:completed`

Fires when a reviewer submits their decision.

| Field        | Type     | Description                                   |
| ------------ | -------- | --------------------------------------------- |
| `workflowId` | `string` | The workflow that requested review            |
| `reviewId`   | `string` | The review's identifier                       |
| `decision`   | `string` | The reviewer's decision                       |
| `reviewer`   | `string` | Who submitted the decision                    |
| `duration`   | `number` | Time from request to decision in milliseconds |

### AgentCheckpointSizeWarningEvent

**Type string:** `agent:checkpoint-size-warning`

Fires when a checkpoint serializes to an unexpectedly large byte size.

| Field        | Type     | Description                           |
| ------------ | -------- | ------------------------------------- |
| `workflowId` | `string` | The workflow this agent belongs to    |
| `agentId`    | `string` | The agent's identifier                |
| `sizeBytes`  | `number` | Serialized checkpoint size in bytes   |
| `turnIndex`  | `number` | The turn index when the warning fired |

### AgentCheckpointResumedEvent

**Type string:** `agent:checkpoint:resumed`

Fires after an agent loop completes when the effect log replayed at least one committed tool-call result. This occurs during checkpoint restores (the agent re-synthesizes a previously dispatched tool call and the effect log short-circuits it) and when the model emits the same tool call twice within a single run.

| Field                 | Type     | Description                                       |
| --------------------- | -------- | ------------------------------------------------- |
| `workflowId`          | `string` | The workflow this agent belongs to                |
| `agentId`             | `string` | The agent's identifier                            |
| `duplicatesPrevented` | `number` | Number of tool calls replayed from the effect log |

## Listening to events

All agent events flow through the standard `EventTarget` API. Listen on the engine for global events, or on a specific workflow handle for scoped events:

```typescript partial
// Global: all agent budget warnings across all workflows
engine.addEventListener(AgentBudgetWarningEvent.type, (e) => {
  const event = e as AgentBudgetWarningEvent;
  console.warn(`Budget warning: workflow ${event.workflowId} at ${event.budgetUsedPercent}%`);
});

// Scoped: only events from a specific workflow
handle.addEventListener(AgentTurnCompletedEvent.type, (e) => {
  const event = e as AgentTurnCompletedEvent;
  console.log(
    `Turn ${event.turnIndex}: ${event.inputTokens}in + ${event.outputTokens}out`,
    `= $${event.cost.toFixed(4)} (${event.toolCallCount} tool calls, ${event.duration}ms)`,
  );
});
```

The engine's `addEventListener` is typed via `WeftAgentEventMap`, which provides the correct event type for each event string—your IDE will autocomplete fields and catch typos. Inside the callback body, cast `e as AgentBudgetWarningEvent` (or the appropriate type) to access event-specific fields.

## Practical patterns

**Cost waterfall logging.** Track per-turn costs to identify expensive turns:

```typescript partial
engine.addEventListener(AgentTurnCompletedEvent.type, (e) => {
  const event = e as AgentTurnCompletedEvent;
  const entry = {
    workflow: event.workflowId,
    turn: event.turnIndex,
    model: event.selectedModel,
    tokens: event.inputTokens + event.outputTokens,
    cost: event.cost,
    cumulative: event.cumulativeCost,
    tools: event.toolCallCount,
    duration: event.duration,
  };
  costLog.push(entry);
});
```

**Tool performance monitoring.** Pair called/returned events to measure tool latency:

```typescript partial
const pending = new Map<string, number>();

engine.addEventListener(AgentToolCalledEvent.type, (e) => {
  const event = e as AgentToolCalledEvent;
  pending.set(event.operationId, Date.now());
});

engine.addEventListener(AgentToolReturnedEvent.type, (e) => {
  const event = e as AgentToolReturnedEvent;
  const started = pending.get(event.operationId);
  if (started) {
    metrics.recordToolLatency(event.toolName, event.duration, event.success);
    pending.delete(event.operationId);
  }
});
```

**Budget alerting.** Send alerts when budgets are running low:

```typescript partial
engine.addEventListener(AgentBudgetWarningEvent.type, (e) => {
  const event = e as AgentBudgetWarningEvent;
  alerting.send({
    severity: 'warning',
    message: `Workflow ${event.workflowId} budget at ${event.budgetUsedPercent}%`,
    metadata: { costRemaining: event.costRemaining, tokensRemaining: event.tokensRemaining },
  });
});
```

## Composing with core events

Agent events live alongside the core workflow events (`WorkflowStartedEvent`, `ActivityCompletedEvent`, `CheckpointSizeWarningEvent`, and so on) in the same `EventTarget`. You can build unified observability pipelines that handle both:

```typescript partial
import { WorkflowCompletedEvent, AgentTurnCompletedEvent } from 'weft';

engine.addEventListener(WorkflowCompletedEvent.type, (e) => {
  const event = e as WorkflowCompletedEvent;
  logger.info(`Workflow ${event.workflowId} completed`);
});

engine.addEventListener(AgentTurnCompletedEvent.type, (e) => {
  const event = e as AgentTurnCompletedEvent;
  logger.info(`Agent turn ${event.turnIndex} completed in workflow ${event.workflowId}`);
});
```

The typed event map (`WeftAgentEventMap`) ensures type safety when using `addEventListener`—your IDE will autocomplete event fields and catch typos at compile time.

Thirteen event types might seem like a lot, but each one answers a specific operational question: _what model is being used?_ (turn events), _what tools are being called and how fast?_ (tool events), _how much is this costing?_ (budget events), _is the context being managed?_ (compaction events), _are providers healthy?_ (circuit events), _are humans in the loop?_ (review events). Skip the ones you don't need—subscribe only to the events that matter for your monitoring setup.
