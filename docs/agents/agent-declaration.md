# Agent Declaration

You want to define an agent once and use it in two places: as a standalone workflow (the agent _is_ the entire execution) and as a step inside a larger workflow (the agent is one piece of a pipeline). `defineAgent()` gives you a single declaration that works in both contexts.

## Declaring an agent

The `defineAgent()` function takes an `AgentDefinitionOptions` object and returns an `AgentDefinition`. Think of it as the agent's blueprint—what model it uses, what tools it has, how it behaves.

```typescript
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

```typescript
const simple = defineAgent({
  name: 'summarizer',
  model: 'claude-haiku-4-5-20251001',
});
```

## AgentDefinition fields

Here's the complete set of fields on `AgentDefinition`:

| Field             | Type                     | Description                                                                              |
| ----------------- | ------------------------ | ---------------------------------------------------------------------------------------- |
| `name`            | `string`                 | Unique identifier for the agent                                                          |
| `model`           | `string`                 | Default LLM model identifier                                                             |
| `description`     | `string?`                | Human-readable description                                                               |
| `systemPrompt`    | `string?`                | System message prepended to every conversation                                           |
| `tools`           | `AgentToolDefinition[]?` | Local function tools available to the agent                                              |
| `maxTurns`        | `number?`                | Maximum LLM turns before the loop exits (defaults to 10)                                 |
| `budget`          | `BudgetOptions?`         | Token and cost constraints (see [budget guide](./agent-budget-and-cost.md))              |
| `modelRouter`     | `ModelRouter?`           | Per-turn model selection logic (see [model routing guide](./agent-model-routing.md))     |
| `contextStrategy` | `ContextStrategy?`       | Conversation compaction strategy (see [context window guide](./agent-context-window.md)) |
| `hooks`           | `AgentHooks?`            | Lifecycle callbacks for turns and tool calls                                             |

Each `AgentToolDefinition` pairs a `ToolDefinition` (name, description, input schema) with an `execute` function:

```typescript
interface AgentToolDefinition {
  definition: ToolDefinition;
  execute: (input: unknown) => Promise<unknown>;
}
```

## Lifecycle hooks

The `AgentHooks` interface provides three injection points into the agent loop. These run at checkpoint boundaries, so they participate in Weft's durability guarantees.

**`beforeTurn`** fires before each LLM call. You can inspect or modify the messages being sent, or skip the turn entirely.

```typescript
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

```typescript
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

```typescript
hooks: {
  onBudgetWarning: async ({ tokensRemaining, costRemaining, budgetUsedPercent }) => {
    console.warn(`Budget at ${budgetUsedPercent}%, $${costRemaining} remaining`);
  },
}
```

## Using an agent as a standalone workflow

Register the agent definition with an engine and start it like any workflow:

```typescript
import { Engine } from 'weft';

const engine = new Engine({
  /* ... */
});
engine.register(researcher);

const handle = await engine.start('research', {
  prompt: 'Analyze the competitive landscape for durable execution engines.',
});

const result = await handle.result();
```

The engine treats agent workflows the same as any other—they get durable checkpoints, signals, search attributes, and the full event system.

## Using an agent as a step in a workflow

The same definition works inside a generator workflow via `ctx.agent()`:

```typescript
async function* pipeline(ctx: Weft.Context, input: { topic: string }) {
  // Use the defined agent as a step
  const research = yield* ctx.agent(researcher, { prompt: input.topic });

  // Use another agent for the next step
  const report = yield* ctx.agent(writer, { data: research });

  return report;
}
```

Each `ctx.agent()` call creates checkpoint boundaries at every tool call within the agent loop. If the process crashes during the writer agent's third tool call, recovery resumes from that exact point—not from the beginning of the pipeline.

## Type-safe declarations

`defineAgent()` accepts type parameters for input and output:

```typescript
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
