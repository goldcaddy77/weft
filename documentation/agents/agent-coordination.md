# Multi-Agent Coordination

One agent can research. Another can write. A third can critique. The interesting part isn't what each agent does alone—it's how they work together. Weft provides three coordination primitives: `handoff()` for sequential delegation, `debate()` for adversarial review, and `supervise()` for parallel work with synthesis.

## Handoff: sequential delegation

When one agent finishes its work and another needs to pick up where it left off, `handoff()` transfers the task with optional context forwarding.

```typescript partial
import { handoff } from 'weft';

const result = await handoff({
  agent: analystAgent,
  input: 'Analyze the competitive landscape for durable execution engines.',
  provider,
  forwardContext: 'summary',
  parentConversation: researcherConversation,
});
```

The `HandoffOptions`:

| Field                | Type                   | Description                                                                               |
| -------------------- | ---------------------- | ----------------------------------------------------------------------------------------- |
| `agent`              | `AgentDefinition`      | The agent to hand off to (created via [`defineAgent()`](./agent-declaration.md))          |
| `input`              | `string`               | The task description for the receiving agent                                              |
| `provider`           | `LLMProvider`          | The LLM provider to use                                                                   |
| `forwardContext`     | `ForwardContext`       | How much of the parent's conversation to include                                          |
| `parentConversation` | `Message[]`            | The parent agent's conversation history                                                   |
| `budget`             | `BudgetTracker?`       | Shared budget tracker—child agent usage accumulates here                                  |
| `signal`             | `AbortSignal?`         | Abort signal propagated to the child agent                                                |
| `headers`            | `Map<string, string>?` | Trace context headers for OpenTelemetry propagation (use `createChildHeaders()` to build) |

The `headers` field carries W3C trace context (`traceparent`/`tracestate`) so child agent spans participate in the same OpenTelemetry trace. Use `createChildHeaders(parentHeaders)` to forward trace context from a parent workflow.

The **`forwardContext`** option controls what the receiving agent sees from the handoff:

- `'full'`—the complete conversation transcript is prepended to the input. The receiving agent sees every message from the parent, which can be large but preserves all context.
- `'summary'`—a condensed version of the conversation (role-tagged lines) is prepended. Cheaper on tokens, but lossy.
- `'none'`—the receiving agent only gets the `input` string. Use this when the input is already self-contained (like a structured data object) and the parent's conversation would just be noise.

The result includes the agent's output and which forwarding mode was used:

```typescript partial
interface HandoffResult {
  result: AgentResult;
  contextForwarded: ForwardContext;
}
```

A typical pipeline chains handoffs:

```typescript partial
async function* researchPipeline(ctx: Weft.Context, topic: string) {
  const research = yield* ctx.agent({
    model: researcherAgent.model,
    provider,
    prompt: topic,
    ...(researcherAgent.tools ? { tools: researcherAgent.tools } : {}),
  });

  const analysis = await handoff({
    agent: analystAgent,
    input: `Analyze: ${research.content}`,
    provider,
    forwardContext: 'summary',
    parentConversation: research.conversation,
  });

  const report = await handoff({
    agent: writerAgent,
    input: `Write a report based on: ${analysis.result.content}`,
    provider,
    forwardContext: 'none',
  });

  return report.result.content;
}
```

## Debate: adversarial review

Sometimes you want two agents to argue opposing positions before a third renders judgment. `debate()` runs structured rounds of advocate-critic exchange, then asks a judge to decide.

```typescript partial
import { debate } from 'weft';

const result = await debate({
  advocate: defineAgent({
    name: 'advocate',
    model: 'claude-sonnet-4-20250514',
    systemPrompt: 'Argue in favor of the proposal. Be persuasive and thorough.',
  }),
  critic: defineAgent({
    name: 'critic',
    model: 'claude-sonnet-4-20250514',
    systemPrompt: 'Find weaknesses and flaws. Be rigorous and skeptical.',
  }),
  judge: defineAgent({
    name: 'judge',
    model: 'claude-sonnet-4-20250514',
    systemPrompt: 'Evaluate both arguments fairly and render a verdict.',
  }),
  topic: 'Should we migrate to a microservices architecture?',
  rounds: 3,
  provider,
});
```

The debate runs in rounds. In each round, the advocate argues first, then the critic responds. Both see the full transcript of prior rounds, so the debate builds on itself. After all rounds complete, the judge receives the full transcript and renders a verdict.

The `DebateResult`:

```typescript
interface DebateResult {
  verdict: string;
  rounds: DebateRound[];
  judgeResult: AgentResult;
}

interface DebateRound {
  roundIndex: number;
  advocateResponse: string;
  criticResponse: string;
}
```

Each round is a natural checkpoint boundary. If the process crashes mid-debate after two rounds, recovery resumes from round three—the first two rounds' results are already in the checkpoint.

Debate is particularly useful for high-stakes decisions where you want the system to stress-test its own reasoning before committing to an answer.

## Supervise: parallel work with synthesis

`supervise()` runs multiple worker agents in parallel on the same input, then asks a supervisor to synthesize their outputs.

```typescript partial
import { supervise, defineAgent } from 'weft';

const result = await supervise({
  workers: [
    defineAgent({ name: 'legal', model: 'claude-sonnet-4-20250514', tools: [legalDatabase] }),
    defineAgent({ name: 'technical', model: 'claude-sonnet-4-20250514', tools: [codeAnalyzer] }),
    defineAgent({ name: 'financial', model: 'claude-sonnet-4-20250514', tools: [financialModels] }),
  ],
  supervisor: defineAgent({
    name: 'supervisor',
    model: 'claude-sonnet-4-20250514',
    systemPrompt: 'You synthesize expert analyses into a unified assessment.',
  }),
  input: 'Review this acquisition proposal.',
  strategy: 'consensus',
  provider,
});
```

All workers run via `Promise.all()`—true parallel execution. The supervisor receives all worker results and applies one of three strategies:

**`'consensus'`**—if all workers agree, use their shared answer. If they disagree, the supervisor resolves the disagreement.

**`'best-of-n'`**—the supervisor picks the best worker response and explains why.

**`'merge'`**—the supervisor combines all responses into a single comprehensive answer.

Two additional options let you tune consensus behavior. Set `voting: 'confidence-weighted'` to use weighted consensus (groups worker outputs by content; the group with the highest total confidence weight wins) instead of the default naive string-equality check. Set `n` to override the worker count at runtime: a fixed number trims or round-robin-replicates the `workers` array, or a function `(input: string) => number` that is called with the workflow input and whose return value is used as the count.

The `SuperviseResult`:

```typescript
interface SuperviseResult {
  finalResult: string;
  workerResults: AgentResult[];
  strategy: string;
}
```

You get the final synthesized answer _and_ each worker's individual result, so you can audit what each expert concluded.

## SharedState across parallel agents

When parallel agents need to write to shared mutable state, Weft's `SharedState` provides compare-and-swap semantics backed by storage. Multiple agents can read and update the same state without conflicts—on write collision, the update function retries with the latest value.

```typescript partial
import { SharedState } from 'weft';

const initialFindings = { articles: [], totalCost: 0 };

// SharedState is constructed directly with storage, workflowId, key, and optional options.
const findings = new SharedState<{ articles: string[]; totalCost: number }>(
  storage,
  workflowId,
  'research-findings',
);

// Use get() to read, update() to prepare compare-and-swap writes.
const current = await findings.get(initialFindings);
const next = await findings.update(
  (prev) => ({ ...prev, totalCost: prev.totalCost + cost }),
  initialFindings,
);
await storage.batch(next.operations);
```

See the core [shared state](../guides/workflows.md) documentation for the full API.

## Budget enforcement across parallel agents

When multiple agents run in parallel via `ctx.all()`, they share the workflow-level budget. The total token cost across all parallel branches counts against the budget set by the `BudgetTracker`. If any branch exhausts the shared budget, all branches receive the abort signal via `AbortSignal.any()`.

This prevents runaway cost in fan-out scenarios. If you launch five workers and one of them hits a pathological tool loop that burns through tokens, the budget tracker aborts all five rather than letting the others continue to accumulate cost.

Agents can also communicate mid-execution through signals. A supervisor agent can signal a worker to change strategy if it observes concerning patterns (like escalating token usage).

These coordination patterns compose naturally with Weft's durability model. Each agent turn is checkpointed independently. Handoff boundaries, debate rounds, and worker completions are all checkpoint boundaries. Crash recovery resumes each agent from its last checkpoint—no re-execution of completed work.
