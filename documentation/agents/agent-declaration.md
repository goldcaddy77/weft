# Agent Declaration

You want to define an agent once and use it in two places: as a standalone workflow (the agent _is_ the entire execution) and as a step inside a larger workflow (the agent is one piece of a pipeline). `defineAgent()` gives you a single declaration that works in both contexts.

## Declaring an agent

The `defineAgent()` function takes an `AgentDefinitionOptions` object and returns an `AgentDefinition`. Think of it as the agent's blueprint—what model it uses, what tools it has, how it behaves.

```typescript partial
import { defineAgent } from 'weft';

const researcher = defineAgent({
  name: 'research',
  model: 'claude-sonnet-4-20250514',
  description: 'Gathers data and produces research summaries',
  systemPrompt: 'You are a research analyst. Gather data, verify facts, and produce insights.',
  tools: [webSearch, factCheck, dataQuery],
  maxTurns: 25,
  budget: {
    maxTokens: 100_000,
    maxCost: 5.0,
    warningThreshold: 0.8,
    models: {
      'claude-sonnet-4-20250514': { inputCostPer1K: 0.003, outputCostPer1K: 0.015 },
    },
  },
  modelRouter: costTierRouter([
    { model: 'claude-sonnet-4-20250514', maxCostRemaining: 2.0 },
    { model: 'claude-haiku-4-5-20251001' },
  ]),
  contextStrategy: slidingWindowStrategy({ preserveSystemMessage: true, preserveRecentCount: 10 }),
  hooks: {
    beforeTurn: async ({ turnIndex, messages, model }) => {
      console.log(`Turn ${turnIndex} starting with ${model}`);
      return { action: 'continue' };
    },
    afterToolCall: async ({ toolCall, result }) => {
      console.log(`Tool ${toolCall.name} returned`);
      return { action: 'continue' };
    },
  },
});
```

Every field except `name` and `model` is optional. A minimal declaration looks like this:

```typescript partial
const simple = defineAgent({
  name: 'summarizer',
  model: 'claude-haiku-4-5-20251001',
});
```

## AgentDefinition fields

Here's the complete set of fields on `AgentDefinition`:

| Field             | Type                                                                       | Description                                                                              |
| ----------------- | -------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| `name`            | `string`                                                                   | Unique identifier for the agent                                                          |
| `model`           | `string`                                                                   | Default LLM model identifier                                                             |
| `version`         | `string?`                                                                  | Semantic version of this agent definition (defaults to `"0.0.0"`)                        |
| `description`     | `string?`                                                                  | Human-readable description                                                               |
| `systemPrompt`    | `string?`                                                                  | System message prepended to every conversation                                           |
| `tools`           | `AgentToolDefinition[]?`                                                   | Local function tools available to the agent                                              |
| `toolsForTenant`  | `(tenant: TenantContext \| undefined) => AgentToolDefinition[]` (optional) | Per-tenant tool selection callback—return a custom tool list for each tenant             |
| `validateInput`   | `(input: unknown, tenant: TenantContext \| undefined) => void` (optional)  | Per-tenant input validation—throw to reject the workflow before it starts                |
| `maxTurns`        | `number?`                                                                  | Maximum LLM turns before the loop exits (defaults to 10)                                 |
| `budget`          | `BudgetOptions?`                                                           | Token and cost constraints (see [budget guide](./agent-budget-and-cost.md))              |
| `modelRouter`     | `ModelRouter?`                                                             | Per-turn model selection logic (see [model routing guide](./agent-model-routing.md))     |
| `contextStrategy` | `ContextStrategy?`                                                         | Conversation compaction strategy (see [context window guide](./agent-context-window.md)) |
| `hooks`           | `AgentHooks?`                                                              | Lifecycle callbacks for turns and tool calls                                             |

The `toolsForTenant` callback lets you expose different tool sets to different tenants—hide tools a tenant lacks permission to use, or inject tenant-scoped credentials into tool configuration. When present, the engine calls it on each agent invocation and uses the returned list instead of `tools`. Similarly, `validateInput` runs before the agent starts and lets you enforce per-tenant payload schemas without adding logic to the agent handler itself.

Each `AgentToolDefinition` pairs a `ToolDefinition` (name, description, input schema) with an `execute` function:

```typescript partial
interface AgentToolDefinition {
  definition: ToolDefinition;
  execute: (input: unknown) => Promise<unknown>;
  verify?: (result: unknown) => Promise<boolean> | boolean;
  version?: string;
  identity?: (input: unknown) => ToolIdentityResult;
}
```

The `verify` callback runs after `execute` returns—return `false` (or throw) to reject the result and send an error back to the model. The `identity` callback computes a stable semantic hash of the invocation; the engine uses it as the key in the tool effect log for deduplication across checkpoint restores. When `identity` is absent, the engine falls back to hashing the full input with `computeSemanticHash`.

## Lifecycle hooks

The `AgentHooks` interface provides three injection points into the agent loop. These run at checkpoint boundaries, so they participate in Weft's durability guarantees.

**`beforeTurn`** fires before each LLM call. You can inspect or modify the messages being sent, or skip the turn entirely.

```typescript partial
hooks: {
  beforeTurn: async ({ turnIndex, messages, model }) => {
    // Inject fresh context
    if (turnIndex > 0) {
      messages.push({ role: 'user', content: `Current time: ${new Date().toISOString()}` });
      return { action: 'continue', messages };
    }
    return { action: 'continue' };
  },
}
```

Returning `{ action: 'skip', result: 'some value' }` short-circuits the loop—the agent stops and uses your string as the final content. This is useful for early exits based on external conditions.

**`afterToolCall`** fires after each tool execution. You can modify the result before it goes back to the model, or reject it.

```typescript partial
hooks: {
  afterToolCall: async ({ turnIndex, toolCall, result }) => {
    if (toolCall.name === 'executeCode' && containsDangerousPatterns(result)) {
      return { action: 'reject', reason: 'Output contains unsafe patterns' };
    }
    return { action: 'continue', result: sanitize(result) };
  },
}
```

Rejecting a tool call sends an error message back to the model instead of the tool result—the agent can then decide to try a different approach.

**`onBudgetWarning`** fires when the budget warning threshold is crossed (default 80%). This is a notification-only hook; it doesn't return a value.

```typescript partial
hooks: {
  onBudgetWarning: async ({ tokensRemaining, costRemaining, budgetUsedPercent }) => {
    console.warn(`Budget at ${budgetUsedPercent}%, $${costRemaining} remaining`);
  },
}
```

## Using an agent as a standalone workflow

Register the agent definition with an engine and start it like any workflow:

```typescript partial
import { Engine, type LLMProvider } from 'weft';

const engine = new Engine({
  /* ... */
});

declare const provider: LLMProvider;

engine.register(researcher, { provider });

const handle = await engine.start('research', {
  prompt: 'Analyze the competitive landscape for durable execution engines.',
});

const result = await handle.result();
```

The engine treats agent workflows the same as any other—they get durable checkpoints, signals, search attributes, and the full event system.

## Using an agent as a step in a workflow

Inside a generator workflow, call `ctx.agent()` with a single options object that includes the model, provider, prompt, and any tools for that step. If you want to start a separate named agent workflow, use the engine to start the registered agent by name instead.

```typescript
import type { AgentDefinition, Context, LLMProvider } from 'weft';

declare const provider: LLMProvider;
declare const researcherAgent: AgentDefinition;
declare const writerAgent: AgentDefinition;

async function* pipeline(ctx: Context, input: { topic: string }) {
  const research = yield* ctx.agent({
    model: researcherAgent.model,
    provider,
    prompt: input.topic,
    ...(researcherAgent.tools ? { tools: researcherAgent.tools } : {}),
  });

  const report = yield* ctx.agent({
    model: writerAgent.model,
    provider,
    prompt: `Write a report based on: ${JSON.stringify(research)}`,
  });

  return report;
}
```

Each `ctx.agent()` call creates checkpoint boundaries at every tool call within the agent loop. If the process crashes during the writer agent's third tool call, recovery resumes from that exact point—not from the beginning of the pipeline.

## Type-safe declarations

`defineAgent()` accepts type parameters for input and output:

```typescript partial
interface ResearchInput {
  prompt: string;
}

interface ResearchResult {
  summary: string;
  sources: string[];
}

const researcher = defineAgent<ResearchInput, ResearchResult>({
  name: 'research',
  model: 'claude-sonnet-4-20250514',
  tools: [webSearch],
});
```

These types flow through to `engine.start()` and `handle.result()`, giving you compile-time checking on both ends.

The declaration is deliberately lightweight—a plain object with no hidden state. All the runtime behavior (executing the loop, tracking tokens, managing checkpoints) lives in the engine. The definition is just configuration, and that's exactly what makes it composable.
