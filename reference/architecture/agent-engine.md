# Agent-Native Engine

This companion document was split out of [../architecture.md](../architecture.md) so the roadmap can stay checklist-first. It preserves the agent-runtime model, streaming, budgeting, human review, MCP integration, multi-agent coordination, and agent observability material.

### 12. Agent-Native Engine

The current `ctx.agent()` could be mistaken for "a durable LLM API call with some options." That is agent-_compatible_, not agent-_native_. Agent execution has a fundamentally different shape (dynamic loops, not static DAGs), a different output mode (streams, not values), a different cost model (tokens, not compute), a different interaction model (human conversation, not fire-and-forget), and a different coordination model (handoff and debate, not just fan-out/fan-in). This section describes how each of these differences is reflected in the engine's primitives, storage model, event system, and observability layer.

#### Why AI Agents Cannot Be Bolted Onto Temporal

Temporal's determinism constraint creates a fundamental tension with LLM-based agent loops. LLM API calls must be activities (since they are non-deterministic network calls). But activities are opaque to the workflow — the workflow dispatches an activity and waits for the result. This forces agent loops into one of two bad choices:

1. **Fully in-activity.** The entire ReAct loop (LLM call → tool selection → tool execution → LLM call) runs as a single activity. Tool calls within it are not individually checkpointed. If the process crashes mid-loop after executing 5 of 10 tool calls, the entire agent conversation restarts from scratch — including re-executing all tool calls with their side effects.

2. **Fully in-workflow.** Each LLM call is a separate activity. But Temporal's replay model requires every activity result to be deterministically reproducible from the event history. LLM APIs are inherently non-deterministic — the same prompt can produce different outputs. Storing and replaying every LLM response defeats the purpose of having a live model and creates enormous event histories.

Weft's generator model avoids this dilemma entirely. Each tool call within an agent loop is a separate `yield*` checkpoint boundary. Token streaming flows through the standard `EventTarget` and `WebSocket` systems in real time. The agent loop is simultaneously durable (each tool call is individually checkpointed) and live (tokens stream as they arrive). No other durable execution engine offers this combination.

---

#### 12.1 Dynamic Execution Shape

Traditional workflows are **static DAGs** — you know the steps at compile time. "Charge card, reserve inventory, send email." The graph is fixed. Temporal was designed for this: you define the sequence, it executes it durably.

Agent loops are **dynamic, emergent graphs**. The LLM decides what to do next based on what it learned from the last step. You don't know at workflow-definition time whether the agent will make 3 tool calls or 30. You don't know which tools it will call. The "workflow" is a loop where the control flow is determined at runtime by a probabilistic model.

Weft's generator model handles this naturally. A `while` loop with `yield*` inside it creates checkpoints at each tool call without declaring the graph shape upfront:

```typescript
async function* researchAgent(ctx: Context, topic: string) {
  let findings: string[] = [];
  let confidence = 0;

  // The loop runs until the agent is confident enough.
  // We don't know how many iterations this will take.
  while (confidence < 0.8) {
    const result = yield* ctx.agent({
      model: 'claude-sonnet-4-20250514',
      prompt: `Research "${topic}". Current findings:\n${findings.join('\n')}`,
      tools: [webSearch, readDocument, analyzeData],
      maxTurns: 5,
    });

    findings.push(result.summary);
    confidence = result.confidence;

    // Each iteration creates checkpoints at every tool call.
    // If we crash after 7 iterations, we resume at iteration 7 — not restart from 0.
    // The checkpoint contains only: { findings, confidence } — bounded size.
  }

  return { findings, confidence };
}
```

**Storage implications.** The checkpoint stores only the current state — `wf:{id}:ckpt` is a single key containing the generator's local variables at the pause point. Whether the agent executed 3 tool calls or 300, the checkpoint size depends only on what's in scope, not on execution history. The step index is a monotonic counter that increments with each `yield*` regardless of origin — no step-count pre-declaration required.

This is the fundamental advantage over static DAG engines (Airflow, Prefect, Step Functions) where the graph shape must be known at declaration time. Agent workloads are inherently dynamic, and the engine must embrace that dynamism rather than forcing agents into a fixed structure.

**Going further: bounded checkpoint growth.** Even though checkpoint size is independent of step count, the conversation history accumulated by an agent loop grows linearly with turns. The engine monitors this: `CheckpointSizeWarningEvent` fires when an agent's checkpoint exceeds a configurable threshold (default: 64KB). The [Context Window Management](#126-context-window-management) strategy determines how old conversation history is compacted or archived. `ctx.offload()` and `ctx.archive()` let the workflow explicitly move large intermediate state out of the checkpoint.

---

#### 12.2 First-Class Streaming

In traditional workflows, the result is a structured object returned at the end. In agent workflows, the result is **a stream of tokens being generated in real-time**, and users need to see them as they're generated. This is not "nice to have" — it is the core UX. An interface that waits 45 seconds for a complete response and then dumps it all at once is unusable.

The engine treats `ReadableStream` as a first-class data type — not just a convenience bridge to WebSocket observers.

**Stream multiplexer.** A single LLM response stream fans out to multiple consumers without duplicating the API call:

```typescript
// Inside the engine's agent runner:
// One LLM API call, multiple consumers.
const llmStream = await provider.stream(messages, { signal });

// Fan out to: checkpoint accumulator, EventTarget, all WebSocket subscribers
const [checkpointStream, observerStream] = llmStream.tee();

// Checkpoint accumulator: builds up the turn's text for crash recovery
const turnText = await accumulateStream(checkpointStream);

// Observer stream: bridges to EventTarget and WebSocket
observerStream.pipeTo(
  new WritableStream({
    write(token) {
      // Dispatch to EventTarget (local listeners)
      handle.dispatchEvent(new TokenEvent(workflowId, token, model));
      // Publish to WebSocket subscribers (remote observers)
      server.publish(`workflow:${workflowId}:stream`, JSON.stringify({ type: 'token', token }));
    },
  }),
);
```

**Crash recovery mid-stream.** When a process crashes while tokens are streaming, the engine resumes from the last completed tool call or turn boundary — not the beginning of the agent loop. The partial token output from the interrupted turn is discarded, and the LLM call is re-issued for that turn only. Clients reconnect and receive the accumulated output from prior turns:

```typescript
// Client reconnection protocol:
// 1. Client connects to WS /v1/workflows/:id/stream
// 2. Server sends accumulated output from completed turns (replay buffer)
// 3. Server streams live tokens from the current turn

ws.addEventListener('message', (event) => {
  const msg = JSON.parse(event.data);
  switch (msg.type) {
    case 'replay':
      // Accumulated output from turns completed before the crash/reconnect
      appendToUI(msg.content);
      break;
    case 'token':
      // Live token from the current turn
      appendToUI(msg.token);
      break;
    case 'turn:completed':
      // A full turn finished — tool calls, results, everything
      updateTurnUI(msg.turn);
      break;
  }
});
```

**Backpressure.** `ReadableStream`'s built-in backpressure mechanism propagates from slow consumers. If a WebSocket client cannot keep up, the stream's `desiredSize` on the controller drops to zero, signaling the producer to slow down. The engine buffers up to a configurable limit (default: 64KB). If the buffer fills, the slow client is disconnected with a `stream:backpressure` close frame rather than allowing unbounded memory growth:

```typescript
const engine = new Engine({
  streaming: {
    maxBufferSize: 64 * 1024, // 64KB per client
    replayBufferTurns: 5, // Keep last 5 turns for reconnecting clients
  },
});
```

**SSE fallback.** For environments where WebSocket is unavailable, `GET /v1/workflows/:id/stream` with `Accept: text/event-stream` returns a Server-Sent Events stream. Same multiplexer, different transport. The SSE stream supports `Last-Event-ID` for reconnection.

**Going further: accumulated turn text in checkpoint.** The text generated so far in the current turn is included in the checkpoint state. On recovery, the engine knows exactly what has been streamed to clients, enabling seamless replay without re-requesting completed content from the LLM.

---

#### 12.3 Cost as Execution Constraint

In traditional workflows, "cost" is compute time — linear, predictable, and cheap. In agent workflows, cost is **token consumption**: non-linear (a single bad tool call can trigger a 50,000-token context window), unpredictable (the LLM decides how many turns to take), expensive (a single agent run can cost $5–50), and per-model (different models in the same workflow have different pricing).

Cost is not a metric to observe after the fact. It is an **execution constraint** enforced in the hot path of every LLM call.

**Workflow-level budgets** span all agent calls within a single workflow execution, including child workflows:

```typescript
async function* analysisWorkflow(ctx: Context, input: Input) {
  // Budget spans ALL agent calls in this workflow
  ctx.setBudget({
    maxTokens: 200_000,
    maxCost: 10.0,
    warningThreshold: 0.8, // AgentBudgetWarningEvent at 80%
    models: {
      'claude-sonnet-4-20250514': { inputCostPer1K: 0.003, outputCostPer1K: 0.015 },
      'claude-haiku-4-5-20251001': { inputCostPer1K: 0.0008, outputCostPer1K: 0.004 },
    },
  });

  const research = yield* ctx.agent({
    model: 'claude-sonnet-4-20250514',
    prompt: 'Research the market...',
    tools: [webSearch],
  });

  // Check remaining budget before expensive analysis
  const remaining = ctx.budgetRemaining();
  // { tokensRemaining: 142_000, costRemaining: 7.31, breakdown: [...] }

  if (remaining.costRemaining < 2.0) {
    // Switch to cheaper model for remaining work
    return yield* ctx.agent({
      model: 'claude-haiku-4-5-20251001',
      prompt: `Summarize: ${research}`,
    });
  }

  return yield* ctx.agent({
    model: 'claude-sonnet-4-20250514',
    prompt: `Deep analysis: ${research}`,
    tools: [dataQuery, chartGenerator],
  });
}
```

**Organization-level budgets** enforce daily and monthly limits per namespace across all workflows:

```typescript
engine.setBudgetPolicy({
  namespace: 'production',
  daily: { maxCost: 500.0 }, // $500/day across all workflows
  monthly: { maxCost: 10_000.0 }, // $10K/month cap
  enforcement: 'real-time', // Checked on every LLM call, not just on agent start
});
```

Organization budget counters are stored at `budget:{namespace}:daily:{YYYY-MM-DD}` and `budget:{namespace}:monthly:{YYYY-MM}`. They are kept in memory for fast enforcement and flushed to storage atomically with each agent turn checkpoint via `batch()`. Exceeding the limit rejects new `ctx.agent()` calls with `OrganizationBudgetExceededError` before the LLM API call is made.

**Cost-aware retry.** Retry policies include cost constraints alongside attempt limits:

```typescript
const analysis =
  yield *
  ctx.agent({
    model: 'claude-sonnet-4-20250514',
    prompt: 'Analyze...',
    retry: {
      maxAttempts: 3,
      maxCost: 2.0, // Stop retrying if cumulative retry cost exceeds $2
      backoff: 'exponential',
    },
  });
```

Before retrying a failed agent call, the engine checks `ctx.budgetRemaining()`. If the estimated retry cost (based on the previous turn's token count) exceeds the remaining budget, the retry is skipped and `BudgetExceededError` is thrown instead.

**Cost events** flow through the standard `EventTarget` system:

```typescript
engine.addEventListener(AgentBudgetWarningEvent.type, (event) => {
  console.warn(
    `Budget warning: workflow ${event.workflowId} at ${event.budgetUsedPercent}%`,
    `($${event.costRemaining} remaining)`,
  );
});

engine.addEventListener(AgentBudgetExceededEvent.type, (event) => {
  console.error(
    `Budget exceeded: workflow ${event.workflowId}`,
    `spent $${event.costUsed} (limit: $${event.maxCost})`,
  );
});
```

**Cost projection.** `ctx.budgetProjection()` estimates remaining capacity based on the current burn rate:

```typescript
const projection = ctx.budgetProjection();
// {
//   estimatedTurnsRemaining: 12,
//   estimatedCostAtCompletion: 8.50,
//   averageCostPerTurn: 0.42,
//   burnRate: { tokensPerMinute: 3200, costPerMinute: 0.14 },
// }
```

**Cost as search attribute.** Each `ctx.agent()` call automatically updates a `weft:tokenCost` search attribute with cumulative USD cost, enabling cross-workflow cost queries: `engine.list({ filter: "weft:tokenCost > 5.0" })`.

**Going further: cost tracking uses AbortController for budget enforcement.** The same `AbortController` pattern used for workflow cancellation and timeouts enforces budgets:

```typescript
// Inside ctx.agent() implementation:
const budgetController = new AbortController();

onTokenUsage((usage) => {
  if (usage.totalTokens > options.tokenBudget) {
    budgetController.abort(new BudgetExceededError(usage));
  }
});

// Compose with workflow cancellation and timeout signals
const combined = AbortSignal.any([
  budgetController.signal,
  workflowCancellation.signal,
  AbortSignal.timeout(options.turnTimeout),
]);

const response = await fetch('https://api.anthropic.com/v1/messages', {
  signal: combined, // Web standard cancellation!
  // ...
});
```

---

#### 12.4 Human-in-the-Loop Interaction Protocol

The current plan models human review as `ctx.waitForSignal("human_review")`. That is the right _primitive_ but the wrong _abstraction level_. Real human-in-the-loop in agent workflows involves structured approval UIs, multi-turn conversation, escalation, and partial approval. `ctx.humanReview()` is a higher-level primitive built on signals and updates that provides all of this.

**Structured review requests:**

```typescript
const decision =
  yield *
  ctx.humanReview({
    // What the human is reviewing
    artifact: {
      type: 'report',
      content: agentOutput,
      sections: ['executive-summary', 'methodology', 'findings', 'recommendations'],
    },

    // Who reviews and how they're notified
    reviewers: ['legal-team'],
    notify: {
      webhook: 'https://slack.com/api/chat.postMessage',
      payload: { channel: '#reviews', text: `Review needed: ${topic}` },
    },

    // Escalation chain with timeouts
    escalation: [
      { after: '4 hours', to: 'manager-queue' },
      { after: '24 hours', action: 'auto-approve', auditReason: 'timeout' },
    ],

    // Allow partial approval (per section)
    allowPartial: true,
  });
```

The return type is richly structured:

```typescript
interface ReviewDecision {
  decision: 'approved' | 'rejected' | 'partial';
  reviewer: string;
  timestamp: Date;
  // Per-section decisions when allowPartial: true
  sections?: Record<
    string,
    {
      decision: 'approved' | 'rejected';
      feedback?: string;
    }
  >;
  // Overall feedback
  feedback?: string;
}
```

**Multi-turn conversation threading.** A reviewer might reject the agent's output with feedback, the agent revises, the reviewer reviews again. This is modeled as a series of updates within the review wait period:

```typescript
const decision =
  yield *
  ctx.humanReview({
    artifact: report,
    reviewers: ['editor'],
    conversation: true, // Enable multi-turn review

    // Called when the reviewer sends a message during review
    *onMessage(ctx, message) {
      // The agent can respond to reviewer questions
      const response = yield* ctx.agent({
        model: 'claude-sonnet-4-20250514',
        prompt: `The reviewer asks: "${message.text}"\n\nContext: ${report}`,
      });
      return { text: response }; // Sent back to the reviewer
    },
  });
```

**Review state is durable.** The review request is stored at `review:{workflowId}:{reviewId}` in storage. If the process crashes while waiting for human review, recovery loads the pending review and continues waiting. The reviewer's partial conversation history is preserved in the checkpoint.

**Dashboard integration.** Pending reviews are listed at `GET /v1/reviews?status=pending` and displayed in the built-in dashboard. Reviewers can approve, reject, comment, or provide section-level feedback directly from the UI. The `POST /v1/workflows/:id/review/:reviewId` endpoint accepts the review decision.

**Going further: review notifications.** The `notify` field supports webhooks (Slack, PagerDuty, any HTTP endpoint) and email. Notifications are fire-and-forget `fetch()` calls with configurable retry. The engine does not depend on notification delivery — the review is always accessible via the dashboard and API regardless of whether the notification was received.

---

#### 12.5 MCP-Native Tool Execution

The ecosystem has converged on **MCP (Model Context Protocol)** as the standard for tool integration. Tools should not be hardcoded function arrays — they should be discoverable from MCP server URLs.

**MCP server URLs as tool sources.** `ctx.agent()` accepts a mix of local functions and MCP server URLs:

```typescript
const analysis =
  yield *
  ctx.agent({
    model: 'claude-sonnet-4-20250514',
    prompt: 'Analyze the codebase...',
    tools: [
      { mcp: 'http://localhost:3000/mcp' }, // Local MCP server: filesystem tools
      { mcp: 'https://api.example.com/mcp', auth: { type: 'bearer', token: apiKey } }, // Remote MCP server
      localSearchTool, // Local function — same as before
    ],
  });
```

**Dynamic tool discovery.** At agent start, the engine calls `tools/list` on each MCP server to discover available tools. The tool definitions (name, description, input schema) are fetched once and cached for the duration of the agent loop. New tools added to an MCP server are available on the next `ctx.agent()` call without code changes.

**Tool schema validation at the engine level.** MCP tool input schemas (JSON Schema) are validated before dispatching tool calls. If the LLM produces invalid tool arguments, the error is caught before the tool call executes:

```typescript
// The engine validates BEFORE sending to the MCP server:
ToolSchemaValidationError: Invalid arguments for tool "readFile"

  Schema expects: { path: string, encoding?: string }
  Received:       { filename: "/etc/hosts" }

  Missing required field: "path"
  Unknown field: "filename" (did you mean "path"?)
```

**Checkpoint at MCP call boundary.** Each MCP tool invocation is a `yield*` checkpoint boundary — identical durability to local tool calls. If the process crashes after the MCP server processes the tool call but before the agent sees the result, recovery loads the result from the checkpoint. MCP tool results are annotated with `source: "mcp"` in the conversation history and in `AgentToolCalledEvent`.

**Tool registry merges local and MCP sources.** The engine builds a unified tool list from all sources. Name collisions between local functions and MCP server tools produce a `ToolNameConflictError` at agent initialization — not at the first conflicting call.

**Going further: MCP server health checking.** Before starting the agent loop, the engine pings each MCP server. Unreachable servers produce `MCPServerUnavailableError` immediately rather than failing silently on the first tool call. Individual MCP tool calls respect a configurable timeout (default: 30 seconds) enforced via `AbortSignal.timeout()`.

**Going further: MCP transports.** The MCP client supports both transports defined by the protocol: stdio (for local process tools like language servers) and HTTP+SSE (for remote servers). The transport is inferred from the URL scheme or explicitly configured:

```typescript
tools: [
  { mcp: 'stdio:///usr/local/bin/mcp-filesystem' }, // Local process via stdio
  { mcp: 'https://tools.example.com/mcp' }, // Remote server via HTTP (default)
  { mcp: 'https://tools.example.com/mcp', transport: 'sse' }, // Remote server via HTTP+SSE
];
```

---

#### 12.6 Context Window Management

LLMs have finite context windows. A 10-turn agent loop with verbose tool results will exceed the context window. Today, developers handle this themselves — truncating old messages, summarizing history, using RAG. This is complex, error-prone, and repeated by every team. An agent-native engine handles it transparently.

**Automatic token tracking.** The engine counts tokens in the conversation history before each LLM call using the provider's tokenizer. The count is recorded in `AgentTurnStartedEvent` and used to determine whether the context strategy needs to trigger.

**Pluggable context strategies.** The `ContextStrategy` interface has a single method:

```typescript
interface ContextStrategy {
  compact(
    messages: Message[],
    options: {
      tokenBudget: number; // How many tokens the compacted result should fit within
      systemMessage: Message; // Always preserved (never compacted)
      model: string; // Current model (affects tokenizer)
    },
  ): AsyncGenerator<Message[]>; // Generator because strategies like "summarize" need yield*
}
```

Three built-in strategies:

```typescript
// Sliding window: drop oldest messages to fit within budget.
// System prompt and most recent N messages are always preserved.
const agent = weft.agent({
  contextStrategy: slidingWindow({
    preserveRecent: 10, // Always keep last 10 messages
    compactAt: 0.85, // Trigger when context reaches 85% of window
  }),
});

// Summarize: call a cheaper model to compress older messages.
// The summarization call is itself a checkpointed durable operation.
const agent = weft.agent({
  contextStrategy: summarize({
    summarizeModel: 'claude-haiku-4-5-20251001',
    preserveRecent: 5,
    compactAt: 0.8,
    summaryPrompt: 'Summarize this conversation, preserving key facts and decisions.',
  }),
});

// RAG: move older messages to a vector store, retrieve relevant ones per turn.
const agent = weft.agent({
  contextStrategy: rag({
    vectorStore: pineconeStore,
    retrievalCount: 10,
    preserveRecent: 3,
  }),
});
```

**Context state is part of the checkpoint.** The current conversation history — after strategy application — is stored in the checkpoint. On recovery, the compacted context is restored directly. The engine does not re-run the context strategy on recovery; the result is already persisted.

**`AgentContextCompactedEvent`** is dispatched when any strategy triggers, including the strategy name, tokens before and after, and messages dropped. This flows through the standard `EventTarget` system.

**Going further: composable strategies.** Strategies can be composed: `compose(slidingWindow({ preserveRecent: 20 }), summarize({ compactAt: 0.9 }))` applies the sliding window first, then summarizes if still over budget. Each strategy in the chain is a generator, so intermediate checkpoints are created between strategy applications.

---

#### 12.7 Multi-Agent Coordination

Real agent systems involve multiple agents collaborating, competing, or delegating. The existing `ctx.all()` handles parallel fan-out, but agent workloads require additional coordination primitives.

**`ctx.handoff()` — sequential delegation with context transfer.** One agent decides it needs another agent's expertise and transfers the task, including relevant context:

```typescript
async function* researchPipeline(ctx: Context, topic: string) {
  // Researcher gathers raw data
  const rawData = yield* ctx.agent({
    model: 'claude-sonnet-4-20250514',
    prompt: `Gather comprehensive data on: ${topic}`,
    tools: [webSearch, documentLookup, dataQuery],
  });

  // Hand off to analyst with selective context forwarding
  const analysis = yield* ctx.handoff({
    agent: 'analyst',
    input: { topic, data: rawData },
    forwardContext: 'summary', // Send a summary of the researcher's conversation, not the full history
  });

  // Hand off to writer for the final report
  const report = yield* ctx.handoff({
    agent: 'writer',
    input: { topic, analysis },
    forwardContext: 'none', // Writer only needs the structured analysis, not the full conversation
  });

  return report;
}
```

The delegating agent pauses at the `yield*` boundary. A child workflow runs the target agent. The result returns when the child completes. OpenTelemetry span links connect the parent and child traces.

**`ctx.debate()` — adversarial review.** Two agents argue opposing positions for N rounds, then a judge decides:

```typescript
const review =
  yield *
  ctx.debate({
    agents: [
      { name: 'advocate', system: 'Argue for the proposal...' },
      { name: 'critic', system: 'Find weaknesses in the proposal...' },
    ],
    judge: { name: 'editor', system: 'Evaluate both arguments and decide...' },
    rounds: 3,
    topic: proposedStrategy,
  });
// review.verdict: the judge's decision
// review.transcript: full debate history (all rounds)
```

Each round is a checkpoint boundary. If the process crashes mid-debate, recovery resumes from the last completed round.

**`ctx.supervise()` — supervisor pattern.** A supervisor agent manages a pool of worker agents, routing tasks based on capability:

```typescript
const results =
  yield *
  ctx.supervise({
    workers: [
      weft.agent({ name: 'legal-reviewer', tools: [legalDatabase] }),
      weft.agent({ name: 'technical-reviewer', tools: [codeAnalyzer] }),
      weft.agent({ name: 'financial-reviewer', tools: [financialModels] }),
    ],
    strategy: 'consensus', // All workers must agree. Alternatives: 'best-of-n', 'merge'
    input: documentToReview,
  });
```

**Execution state — concurrent mutable state.** When multiple agents run in parallel via `ctx.all()`, they may need shared, mutable state. `ctx.state.execution()` provides a CAS (compare-and-swap) primitive backed by storage:

```typescript
async function* collaborativeResearch(ctx: Context, topics: string[]) {
  // Execution state for concurrent agents in this execution tree.
  const findings = ctx.state.execution('research-findings', {
    initial: { articles: [], totalCost: 0 },
  });

  // Multiple agents run in parallel, writing to shared state
  yield* ctx.all(
    topics.map((topic) =>
      ctx.agent({
        model: 'claude-sonnet-4-20250514',
        prompt: `Research: ${topic}`,
        tools: [webSearch],
        hooks: {
          async *afterToolCall(ctx, tool, result) {
            if (tool.name === 'webSearch') {
              // CAS update: read-modify-write with automatic retry on conflict
              yield* findings.update((state) => ({
                ...state,
                articles: [...state.articles, ...result.articles],
              }));
            }
          },
        },
      }),
    ),
  );

  return yield* findings.get();
}
```

Execution state writes are serialized via optimistic concurrency control. On conflict (another agent wrote between read and write), the update function is retried with the latest state. Writes are committed through a conditional storage batch.

**Agent-to-agent messaging.** Agents running in parallel can communicate through their workflow handles via `ctx.signal()`. A supervisor agent can signal a worker to change strategy mid-execution.

**Budget across parallel agents.** Multi-agent fan-out via `ctx.all()` respects the workflow-level budget. The total token cost across all parallel branches counts against the budget set by `ctx.setBudget()`. If any branch exhausts the shared budget, all branches receive the abort signal via `AbortSignal.any()`.

---

#### 12.8 Agent-Specific Observability

A traditional workflow dashboard shows: "step 1 completed, step 2 running, step 3 pending." An agent-native dashboard needs to show the agent's reasoning trace, token usage per turn as a cost waterfall, tool call results in context, the full conversation history, and real-time streaming output.

**Agent-specific event types.** All agent events extend the standard `Event` class and are registered in `WeftEventMap` for typed `addEventListener`:

```typescript
// Listen to individual agent turns
handle.addEventListener(AgentTurnCompletedEvent.type, (event) => {
  console.log(
    `Turn ${event.turnIndex}: ${event.inputTokens}in + ${event.outputTokens}out`,
    `= $${event.cost.toFixed(4)} (cumulative: $${event.cumulativeCost.toFixed(4)})`,
    `[${event.toolCallCount} tool calls, ${event.duration}ms]`,
  );
});

// Listen to tool calls
handle.addEventListener(AgentToolCalledEvent.type, (event) => {
  console.log(`Tool: ${event.toolName} (${event.source}) — op:${event.operationId}`);
});

// Listen to budget warnings
engine.addEventListener(AgentBudgetWarningEvent.type, (event) => {
  console.warn(`Budget ${event.budgetUsedPercent}% used for workflow ${event.workflowId}`);
});
```

The full event taxonomy:

| Event                           | Type String                   | When                                              |
| ------------------------------- | ----------------------------- | ------------------------------------------------- |
| `AgentTurnStartedEvent`         | `agent:turn:started`          | Before each LLM call                              |
| `AgentTurnCompletedEvent`       | `agent:turn:completed`        | After each LLM response + tool calls              |
| `AgentToolCalledEvent`          | `agent:tool:called`           | Before each tool invocation                       |
| `AgentToolReturnedEvent`        | `agent:tool:returned`         | After each tool returns                           |
| `AgentBudgetWarningEvent`       | `agent:budget:warning`        | At configurable threshold (default 80%)           |
| `AgentBudgetExceededEvent`      | `agent:budget:exceeded`       | When budget is exhausted                          |
| `AgentContextCompactedEvent`    | `agent:context:compacted`     | When context strategy triggers                    |
| `AgentModelFallbackEvent`       | `agent:model:fallback`        | When a model fails and the next in chain is tried |
| `AgentProviderCircuitOpenEvent` | `agent:provider:circuit-open` | When a provider is temporarily excluded           |
| `HumanReviewRequestedEvent`     | `human:review:requested`      | When `ctx.humanReview()` creates a review         |
| `HumanReviewCompletedEvent`     | `human:review:completed`      | When a reviewer submits a decision                |

**Reasoning trace.** When the model returns `thinking` blocks (extended thinking), they are stored in the checkpoint alongside the conversation history and included in `AgentTurnCompletedEvent` as `reasoningTrace`. The dashboard renders reasoning traces in an expandable accordion per turn.

**Queryable data.** Agent-specific state is queryable via workflow handles:

```typescript
// Cost waterfall: per-turn cost breakdown
const costWaterfall = await handle.query('agentCostWaterfall');
// [{ turn: 0, inputTokens: 1200, outputTokens: 450, cost: 0.0103, model: "claude-sonnet-4-20250514", tools: ["webSearch"] }, ...]

// Full conversation history
const conversation = await handle.query('agentConversation');
// [{ role: "system", content: "..." }, { role: "user", content: "..." }, { role: "assistant", content: "...", toolCalls: [...] }, ...]

// Cost projection
const projection = await handle.query('agentCostProjection');
// { estimatedTurnsRemaining: 8, estimatedTotalCost: 4.20, confidence: 0.7 }
```

**OTel span hierarchy.** The observability interceptor creates spans for agent execution:

```
workflow:research (root span)
├── agent (agent span)
│   ├── agent:turn:0 (turn span)
│   │   ├── agent:tool:webSearch (tool span)
│   │   └── agent:tool:readDocument (tool span)
│   ├── agent:turn:1 (turn span)
│   │   └── agent:tool:analyzeData (tool span)
│   └── agent:turn:2 (turn span)
└── sleep:1h (sleep span)
```

Each span includes attributes: `weft.agent.model`, `weft.agent.turn_index`, `weft.agent.input_tokens`, `weft.agent.output_tokens`, `weft.agent.cost`, `weft.agent.tool_count`.

**Dashboard agent view.** The built-in dashboard at `/ui` includes an agent-specific panel showing: conversation timeline with tool calls highlighted inline, token usage per turn as a bar chart, cumulative cost curve, budget remaining gauge, reasoning trace accordion, and real-time streaming output.

---

#### 12.9 Model Routing and Fallback

In production agent workflows, you do not always want the same model for every turn. You want: the best model for complex reasoning, a cheaper model for summarization, automatic fallback when a provider is down, and A/B testing for quality comparison.

**`ModelRouter` interface.** A pluggable component that selects the model for each turn:

```typescript
interface ModelRouter {
  select(context: RoutingContext): ModelSelection;
}

interface RoutingContext {
  turnIndex: number;
  conversationLength: number;
  toolCallsThisTurn: number;
  budgetRemaining: { tokens: number; cost: number };
  previousTurns: TurnSummary[];
  metadata: Record<string, unknown>;
}

interface ModelSelection {
  model: string;
  fallback?: string[]; // Ordered fallback chain
  reason?: string; // For observability
}
```

**Static fallback chain.** The simplest configuration — try the primary model, fall back on failure:

```typescript
const agent = weft.agent({
  model: 'claude-sonnet-4-20250514',
  fallback: ['gpt-4o', 'claude-haiku-4-5-20251001'],
  // If Claude Sonnet fails (rate limit, timeout, outage), try GPT-4o.
  // If GPT-4o also fails, try Haiku.
  // Each fallback attempt is a separate checkpoint boundary.
});
```

**Dynamic model routing based on turn characteristics:**

```typescript
const smartRouter: ModelRouter = {
  select(context) {
    // Complex reasoning turns → best model
    if (context.toolCallsThisTurn > 3 || context.conversationLength > 50) {
      return { model: 'claude-sonnet-4-20250514', reason: 'complex-reasoning' };
    }
    // Low budget remaining → cheapest model
    if (context.budgetRemaining.cost < 1.0) {
      return { model: 'claude-haiku-4-5-20251001', reason: 'budget-conservation' };
    }
    // Default with fallback
    return {
      model: 'claude-sonnet-4-20250514',
      fallback: ['gpt-4o'],
      reason: 'default',
    };
  },
};

const agent = weft.agent({
  modelRouter: smartRouter,
});
```

**Cost-tier routing.** Declare cost tiers and the engine selects the cheapest adequate model:

```typescript
const agent = weft.agent({
  modelRouter: costTierRouter({
    tiers: {
      premium: 'claude-sonnet-4-20250514',
      standard: 'gpt-4o-mini',
      economy: 'claude-haiku-4-5-20251001',
    },
    // Start with premium, switch to economy when 70% of budget is consumed
    budgetThresholds: { standard: 0.5, economy: 0.7 },
  }),
});
```

**A/B testing.** Route a percentage of agent invocations to different models for quality comparison:

```typescript
const agent = weft.agent({
  modelRouter: abTestRouter({
    control: { model: 'claude-sonnet-4-20250514', weight: 0.8 },
    variant: { model: 'gpt-4o', weight: 0.2 },
    // Selection is deterministic per workflow ID (seeded hash) for reproducibility
    // Results tagged with model attribution in AgentTurnCompletedEvent.selectedModel
  }),
});
```

**Provider health tracking.** The engine tracks error rates per provider over a sliding window. Providers exceeding a configurable error threshold are temporarily excluded (circuit breaker):

```typescript
engine.configure({
  providerHealth: {
    windowDuration: 60_000, // 60-second sliding window
    errorThreshold: 0.5, // 50% error rate triggers circuit open
    cooldownDuration: 300_000, // 5-minute cooldown before retrying
  },
});
```

When a circuit opens, `AgentProviderCircuitOpenEvent` is dispatched. When it closes (after cooldown), agents resume routing to that provider.

**Model selection is checkpointed.** The model chosen for each turn is recorded in the checkpoint. On recovery, the same model is used for the retried turn — no re-routing. This ensures deterministic retry behavior even when the model router would now select a different model due to changed conditions.

---

#### 12.10 Agent-First Workflow Declaration

This is the most fundamental shift. In the current architecture, `ctx.agent()` is something a workflow _calls_ — it is a step in a workflow. But for many workloads, the agent loop IS the entire workflow. There is no "step 1: agent, step 2: something else." The whole thing is an agent.

`weft.agent()` is a top-level declaration that says: this workflow is an agent.

```typescript
const researchAgent = weft.agent({
  name: 'research',
  model: 'claude-sonnet-4-20250514',
  system:
    'You are a research analyst. Gather comprehensive data, verify facts, and produce actionable insights.',
  tools: [
    { mcp: 'http://localhost:3000/mcp' }, // MCP server: filesystem tools
    webSearch,
    factCheck,
    dataQuery,
  ],
  maxTurns: 50,

  // Context window management
  contextStrategy: summarize({
    summarizeModel: 'claude-haiku-4-5-20251001',
    preserveRecent: 10,
    compactAt: 0.85,
  }),

  // Model routing
  modelRouter: costTierRouter({
    tiers: { premium: 'claude-sonnet-4-20250514', economy: 'claude-haiku-4-5-20251001' },
    budgetThresholds: { economy: 0.8 },
  }),

  // Cost constraints
  budget: {
    maxCost: 10.0,
    warningThreshold: 0.8,
  },

  // Durable lifecycle hooks — these run at checkpoint boundaries
  hooks: {
    *beforeTurn(ctx, turn) {
      // Inject real-time context before each LLM call
      ctx.setAttribute('agent:turn', turn.index);
      if (turn.index > 10) {
        yield* ctx.waitForSignal('continue_approval', { timeout: '1 hour' });
      }
    },

    *afterToolCall(ctx, toolCall) {
      // Audit dangerous tool calls
      if (toolCall.name === 'executeCode') {
        yield* ctx.humanReview({
          artifact: { tool: toolCall.name, input: toolCall.input, result: toolCall.result },
          reviewers: ['security-team'],
          escalation: [{ after: '30 minutes', action: 'auto-reject' }],
        });
      }
    },

    onBudgetWarning(ctx, remaining) {
      // Switch to cheaper model when budget is running low
      ctx.setModelRouter(
        costTierRouter({
          tiers: { economy: 'claude-haiku-4-5-20251001' },
          budgetThresholds: {},
        }),
      );
    },
  },
});
```

**Registering and starting an agent workflow:**

```typescript
engine.register(researchAgent);

// Start it like any workflow
const handle = await engine.start('research', {
  prompt: 'Analyze the competitive landscape for durable execution engines in 2026.',
});

// Observe it like any workflow
for await (const event of handle) {
  if (event instanceof AgentTurnCompletedEvent) {
    console.log(`Turn ${event.turnIndex}: $${event.cost.toFixed(4)}`);
  }
}

const result = await handle.result();
```

**Relationship to `ctx.agent()`.** `weft.agent()` is the standalone form — the agent IS the workflow. `ctx.agent()` is the embedded form — the agent is a step inside a larger workflow. They share the same underlying implementation. A `weft.agent()` definition can be used as either:

```typescript
// As a standalone workflow
engine.register(researchAgent);
await engine.start('research', { prompt: '...' });

// As a step in a larger workflow
async function* pipeline(ctx: Context, input: Input) {
  const research = yield* ctx.agent(researchAgent, { prompt: input.topic });
  const report = yield* ctx.agent(writerAgent, { data: research });
  return report;
}
```

**Type-safe agent registry.** Agent definitions carry their input and output types:

```typescript
const researcher = weft.agent<{ prompt: string }, ResearchResult>({
  name: 'research',
  // ...
});

// Compile-time type checking on start
const handle = await engine.start('research', { prompt: 'topic' }); // OK
const handle = await engine.start('research', { wrong: 'field' }); // Type error

// Compile-time type checking on result
const result: ResearchResult = await handle.result();
```

**Engine optimization.** When the engine detects an agent-typed workflow (registered via `weft.agent()`), it applies optimizations specific to conversation-shaped data: pre-warming LLM provider connections, larger checkpoint buffers for conversation history, and priority queuing for tool call execution. These optimizations are transparent — they do not change behavior, only performance.

---

#### 12.11 Storage Key Patterns for Agent-Native Features

The following storage key patterns support the agent-native engine. All follow the existing `prefix:{id}:suffix` convention:

```
review:{workflowId}:{reviewId}           → Pending human review request (JSON: artifact, reviewers, escalation)
review-resp:{reviewId}                    → Human review response (JSON: decision, reviewer, feedback)
budget:{namespace}:daily:{YYYY-MM-DD}    → Organization daily budget counter (number: cumulative cost)
budget:{namespace}:monthly:{YYYY-MM}     → Organization monthly budget counter (number: cumulative cost)
state:execution:{ownerWorkflowId}:{key}  → Execution state data (MessagePack: current state)
state:execution:{ownerWorkflowId}:{key}:version → Execution state version counter (number: CAS version)
state:workflow:{tenantId}:{workflowType}:{key} → Workflow-scoped state data (MessagePack: current state)
state:tenant:{tenantId}:{key}            → Tenant-scoped state data (MessagePack: current state)
mcp-tools:{serverUrl}:{cacheKey}         → Cached MCP tool definitions (JSON: tool schemas, TTL)
provider-health:{provider}:{window}      → Provider error rate tracking (JSON: error count, request count, window start)
```

Review requests and execution-scoped state entries are cleaned up when the owning workflow reaches a terminal state. Workflow- and tenant-scoped state persists until explicitly deleted. Organization budget counters are retained for billing and audit. MCP tool caches expire based on their configured TTL.
