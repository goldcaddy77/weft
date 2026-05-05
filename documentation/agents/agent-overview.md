# Agent Overview

**Agent durability:** Weft adds durability to your agent loop. Bring your provider, bring your tools, and let Weft drive the ReAct loop through durable checkpoint boundaries.

That sentence is the whole pitch. Weft does not try to be your model platform, tool registry, provider gateway, or prompt operations layer. It gives the runtime shape that agent loops need when model-driven control flow meets real side effects.

## Why agent loops are different

Static workflows are mostly known before they run. You can draw the graph, name the steps, and reason about retry behavior from the code alone.

Agent loops are not like that.

**Dynamic execution graph:** The next node is chosen at runtime. The model may call `search`, then `fetch_page`, then `summarize`, then call `search` again because the previous result changed its plan.

**Probabilistic control flow:** The branch condition is not a deterministic `if` statement. It is a provider response. The same prompt may produce different tool calls after a model upgrade, a tool result change, or a recovered conversation.

**Real side effects:** Tool calls are not just computation. They can send email, charge a card, mutate a ticket, reserve inventory, or write a record. Retrying the wrong boundary can duplicate the effect.

That combination makes the usual "just replay it" answer uncomfortable. The thing you replay is partly controlled by a model, and the model is exactly the part you should avoid treating as a deterministic function.

## The replay dilemma

Replay-based systems usually force one of two shapes for an agent loop.

**One big activity:** Put the whole loop inside one activity. This keeps the model and tool calls outside replay, but it also makes the loop opaque to the workflow runtime. If the process crashes on turn 14, the runtime knows only that the activity failed. You now need custom recovery inside the activity, custom progress storage, and custom idempotency around every tool call.

**Activity per turn:** Make each LLM turn an activity. This gives the runtime more checkpoints, but the awkward boundary remains. A single turn can contain several tool calls, and those calls are the side effects you most need to protect. If a crash happens after tool call 7 and before the turn returns, the runtime still sees an incomplete activity.

Neither option matches the real fault line. The durable boundary is not "the whole loop" and it is not always "one provider turn." The durable boundary is the tool-call edge.

## Tool-call checkpoint boundaries

**Checkpoint boundary:** Every tool call is a durable pause point. In generator workflows, each `yield*` gives Weft a place to persist state before execution continues. The agent loop uses that same idea internally: model response, tool call, effect record, next message.

When the model asks for a tool, Weft computes a semantic identity for that call, checks the effect log, and either:

- returns a previously committed result, or
- executes the tool, records the committed result, and continues the loop.

**Effect log:** The `ToolEffectLog` is the recovery ledger for tool calls. It prevents duplicate execution when a process crashes after the side effect happened but before the surrounding conversation finished.

The practical result is straightforward. If an agent plans 30 tool calls and the process crashes after tool call 7, recovery starts from tool call 8. The first seven committed effects are replayed from the log, not re-executed.

## Minimal workflow usage

Use `ctx.agent()` when the agent loop is one step inside a larger workflow:

```typescript partial
import { Engine, type AgentTool, type LLMProvider, type WorkflowContext } from 'weft';

declare const provider: LLMProvider;
declare const webSearch: AgentTool;
declare const factCheck: AgentTool;

async function* researchWorkflow(ctx: WorkflowContext, topic: string) {
  const result = yield* ctx.agent({
    model: 'claude-sonnet-4-20250514',
    provider,
    systemPrompt: 'You are a careful research analyst.',
    tools: [webSearch, factCheck],
    maxTurns: 20,
    prompt: topic,
  });

  return result.content;
}

const engine = new Engine();
engine.register('research-workflow', researchWorkflow);
```

The agent call is durable like any other workflow operation, but its internal durability is more precise: each tool call creates its own checkpoint boundary.

## What the subsystem provides

**Agent declaration:** [`agent()`](./agent-declaration.md) gives reusable names, prompts, tool lists, and turn limits. Definitions stay thin so workflow authors can make scoping decisions close to the workflow.

**Tools:** [`AgentTool`](./agent-tools.md), `AgentToolDefinition`, `ToolEffectLog`, and `computeSemanticHash` define the structural tool surface and the deduplication mechanism that protects side effects.

**Human review:** [`ReviewCoordinator`](./agent-human-review.md) persists approval requests and decisions so humans can pause a workflow without losing the agent conversation.

**Coordination:** [`handoff()`, `debate()`, and `supervise()`](./agent-coordination.md) compose multiple durable agent loops without turning coordination into a separate orchestration product.

**Observability:** [Agent events](./agent-observability.md) report turn starts and completions, tool calls and returns, checkpoint resume behavior, and human review activity.

**Ownership boundaries:** [What Weft owns](./what-weft-owns.md) spells out the narrow contract: Weft owns durable loop execution, tool-call effect logging, review coordination, and structural interfaces. Your application owns providers, tool discovery, tool scoping, and provider-specific policy.

## The mental model

Think of Weft as the durable frame around an agent loop:

```text
provider response
  -> tool call requested
  -> checkpoint
  -> effect log lookup
  -> execute or replay tool result
  -> append tool result message
  -> next provider response
```

The model remains your model. The tools remain your tools. Weft gives the loop a place to stand when the process disappears halfway through the conversation.
