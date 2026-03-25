# Agent Overview

You've built a workflow that calls an LLM. The model returns a response, you parse it, move on. That works—right up until the model needs to call a tool, read the result, decide what to do next, call another tool, loop five more times, and eventually produce an answer. At that point you don't have a workflow with an LLM step. You have an agent, and agents have a fundamentally different execution shape than traditional workflows.

Weft is built for this from the ground up. Not agent-_compatible_—agent-_native_.

## Why agents are different

Traditional durable workflows are **static DAGs**. You know the steps at compile time: charge the card, reserve inventory, send the email. The graph is fixed. Temporal, Step Functions, and their peers were designed for exactly this shape.

Agent loops are **dynamic, emergent graphs**. The LLM decides what to do next based on what it learned from the last step. You don't know at definition time whether the agent will make 3 tool calls or 30. You don't know _which_ tools it will call. The "workflow" is a loop where control flow is determined at runtime by a probabilistic model.

That's only the first difference. There are four more:

- **Output mode.** Traditional workflows return a structured value at the end. Agents stream tokens in real time—a 45-second wait for a bulk response is unusable. Streaming isn't a nice-to-have; it's the core UX.
- **Cost model.** Traditional workflow cost is compute time—linear, predictable, cheap. Agent cost is token consumption—non-linear (one bad tool call can balloon a 50,000-token context window), unpredictable (the model decides how many turns to take), and expensive (a single run can cost $5–$50).
- **Interaction model.** Traditional workflows are fire-and-forget. Agents need human-in-the-loop review: structured approvals, multi-turn conversation with reviewers, escalation chains, partial approval per section.
- **Coordination model.** Traditional workflows fan out and fan in. Agents need handoff (sequential delegation with context transfer), debate (adversarial multi-agent review), and supervision (a manager agent overseeing workers).

## Why you can't bolt agents onto replay-based systems

Temporal's determinism constraint creates a fundamental tension with LLM-based agent loops. LLM API calls must be activities (they're non-deterministic network calls), but activities are opaque to the workflow. This forces agent loops into one of two bad choices:

The first option is to run the _entire_ ReAct loop—LLM call, tool selection, tool execution, repeat—as a single activity. Tool calls within it aren't individually checkpointed. If the process crashes mid-loop after executing 5 of 10 tool calls, the entire agent conversation restarts from scratch, including re-executing all tool calls with their side effects.

The second option is to make each LLM call a separate activity. But Temporal's replay model requires every activity result to be deterministically reproducible from the event history. LLM APIs are inherently non-deterministic—the same prompt produces different outputs. Storing and replaying every LLM response defeats the purpose of having a live model and creates enormous event histories.

## What agent-native means in practice

Weft's generator model avoids this dilemma entirely. Each tool call within an agent loop is a separate `yield*` checkpoint boundary. Token streaming flows through the standard `EventTarget` and WebSocket systems in real time. The agent loop is simultaneously _durable_ (each tool call is individually checkpointed) and _live_ (tokens stream as they arrive).

The checkpoint stores only the current state—a single key containing the generator's local variables at the pause point. Whether the agent executed 3 tool calls or 300, checkpoint size depends only on what's in scope, not on execution history.

```typescript
async function* researchAgent(ctx: Weft.Context, topic: string) {
  let findings: string[] = [];
  let confidence = 0;

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
    // Crash after 7 iterations? Resume at iteration 7—not restart from 0.
  }

  return { findings, confidence };
}
```

The loop runs until the agent is confident enough. We don't know how many iterations that takes. And it doesn't matter—the engine handles dynamic, emergent control flow natively.

## What the agent subsystem provides

The rest of these guides cover each piece of the agent subsystem:

- [**Agent declaration**](./agent-declaration.md)—`defineAgent()` for reusable agent definitions that work as standalone workflows or embedded steps
- [**Tools and MCP**](./agent-tools-and-mcp.md)—local function tools, MCP server integration, and a unified tool registry
- [**Budget and cost**](./agent-budget-and-cost.md)—token tracking, cost enforcement, warning thresholds, and `AbortController`-based budget limits
- [**Streaming**](./agent-streaming.md)—`TokenBridge`, `StreamMultiplexer`, and `ReconnectionBuffer` for real-time token delivery
- [**Context window**](./agent-context-window.md)—`ContextWindowManager` and composable strategies for keeping conversations within token limits
- [**Model routing**](./agent-model-routing.md)—fallback chains, cost-tier routing, A/B testing, and custom routing logic
- [**Human review**](./agent-human-review.md)—`ReviewCoordinator` for structured human-in-the-loop approval workflows
- [**Multi-agent coordination**](./agent-coordination.md)—`handoff()`, `debate()`, and `supervise()` for orchestrating multiple agents
- [**Provider health**](./agent-provider-health.md)—circuit breaker pattern for tracking and excluding unhealthy LLM providers
- [**Observability**](./agent-observability.md)—11 agent-specific event types for logging, monitoring, and debugging

Every one of these primitives integrates with Weft's core durability model. Tool calls checkpoint. Streams survive crashes. Budgets persist across restarts. That's what agent-native means.
