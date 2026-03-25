# Budget and Cost

A single agent run can cost $5–$50 in tokens. One bad tool call can balloon a context window to 50,000 tokens. The model decides how many turns to take, and you can't predict the bill ahead of time. Cost in agent workflows isn't a metric to observe after the fact—it's an execution constraint that needs enforcement in the hot path of every LLM call.

Weft's `BudgetTracker` gives you that enforcement.

## Setting up a budget

Create a `BudgetTracker` with token limits, cost limits, or both:

```typescript
import { BudgetTracker } from 'weft';

const budget = new BudgetTracker({
  maxTokens: 200_000,
  maxCost: 10.0,
  warningThreshold: 0.8,
  models: {
    'claude-sonnet-4-20250514': { inputCostPer1K: 0.003, outputCostPer1K: 0.015 },
    'claude-haiku-4-5-20251001': { inputCostPer1K: 0.0008, outputCostPer1K: 0.004 },
  },
});
```

The `models` field is a record mapping model identifiers to their pricing. You must provide pricing for every model the agent might use—`BudgetTracker` computes cost from `(inputTokens / 1000) * inputCostPer1K + (outputTokens / 1000) * outputCostPer1K`. If a model isn't listed, its cost is treated as zero (which means it won't count toward `maxCost`).

The **`warningThreshold`** is a fraction between 0 and 1. When token usage or cost crosses this fraction of the respective limit, the warning callback fires. It defaults to 0.8 (80%).

## Recording usage

After each LLM call, record how many tokens were consumed:

```typescript
const withinBudget = budget.recordUsage('claude-sonnet-4-20250514', 1200, 450);
// true if budget still has room, false if exceeded
```

`recordUsage()` does three things: updates the running totals, checks whether the warning threshold has been crossed (and fires the callback if so), and checks whether the budget has been exceeded. If exceeded, it fires the exceeded callback, aborts any connected `AbortController`, and returns `false`.

The agent loop calls this automatically after every turn—you typically don't call it yourself unless you're building custom agent infrastructure.

## Checking remaining budget

Call `budgetRemaining()` at any point to see where you stand:

```typescript
const remaining = budget.budgetRemaining();
// {
//   tokensUsed: 15_000,
//   costUsed: 0.072,
//   tokensRemaining: 185_000,
//   costRemaining: 9.928,
//   breakdown: [
//     { model: 'claude-sonnet-4-20250514', inputTokens: 8000, outputTokens: 7000, cost: 0.072 }
//   ]
// }
```

The `breakdown` array shows per-model usage, which is especially useful when your agent switches models mid-run (via [model routing](./agent-model-routing.md)).

## Projecting remaining capacity

Once you have some usage history, `budgetProjection()` estimates how many turns you have left based on average burn rate:

```typescript
const projection = budget.budgetProjection();
// {
//   estimatedTurnsRemaining: 12,
//   estimatedCostAtCompletion: 8.50,
// }
```

The projection is clamped to `maxCost` if set. If no usage has been recorded yet, it returns zeros.

## Enforcing budgets with checkBudget()

`checkBudget()` throws a `BudgetExceededError` if the budget is already exhausted:

```typescript
import { BudgetExceededError } from 'weft';

try {
  budget.checkBudget();
} catch (error) {
  if (error instanceof BudgetExceededError) {
    console.error(`Over budget: ${error.tokensUsed} tokens, $${error.costUsed}`);
  }
}
```

The agent loop calls this at the top of each turn—if the budget is blown, the loop exits cleanly instead of making another LLM call.

## AbortController integration

For real-time enforcement, connect an `AbortController` to the budget tracker:

```typescript
const controller = new AbortController();
budget.setAbortController(controller);

// Pass the signal to the agent loop or LLM provider
const result = await executeAgentLoop(
  {
    model: 'claude-sonnet-4-20250514',
    provider,
    budget,
    signal: controller.signal,
  },
  'Analyze the market...',
);
```

When the budget is exceeded, the tracker calls `controller.abort()` with a `BudgetExceededError` as the reason. This cancels any in-flight `fetch()` call to the LLM provider immediately—you don't wait for the current turn to finish before discovering you're over budget.

The same `AbortSignal` composes with workflow cancellation and timeouts via `AbortSignal.any()`, giving you a single cancellation mechanism for all exit conditions.

## Warning and exceeded callbacks

Pass callbacks when constructing the tracker to react to budget events:

```typescript
const budget = new BudgetTracker(
  {
    maxTokens: 200_000,
    maxCost: 10.0,
    warningThreshold: 0.8,
    models: {
      /* ... */
    },
  },
  {
    onWarning: (state) => {
      console.warn(`Budget warning: ${state.tokensUsed} tokens, $${state.costUsed.toFixed(4)}`);
    },
    onExceeded: (state) => {
      console.error(`Budget exceeded: ${state.tokensUsed} tokens, $${state.costUsed.toFixed(4)}`);
    },
  },
);
```

The warning callback fires at most once per tracker instance. The exceeded callback fires every time `recordUsage()` pushes the budget over the limit (which in practice means once, since the agent loop exits after the first exceeded check).

## Agent event integration

When running inside a Weft engine, the agent loop emits `AgentBudgetWarningEvent` and `AgentBudgetExceededEvent` through the standard `EventTarget` system. See the [observability guide](./agent-observability.md) for the full event payload.

```typescript
engine.addEventListener('agent:budget:warning', (event) => {
  console.warn(
    `Workflow ${event.workflowId}: budget at ${event.budgetUsedPercent}%`,
    `($${event.costRemaining} remaining)`,
  );
});

engine.addEventListener('agent:budget:exceeded', (event) => {
  console.error(
    `Workflow ${event.workflowId}: budget blown`,
    `${event.tokensUsed} tokens (limit: ${event.tokenBudget})`,
  );
});
```

## Checkpoint serialization

Budget state survives process crashes. Call `toJSON()` to serialize and `BudgetTracker.fromJSON()` to restore:

```typescript
// Save
const serialized = budget.toJSON();
// { tokensUsed, costUsed, breakdown, warningFired }

// Restore
const restored = BudgetTracker.fromJSON(serialized, budgetOptions, callbacks);
```

The engine handles this automatically as part of its checkpoint mechanism. When a workflow resumes after a crash, the budget tracker picks up exactly where it left off—no double-counting, no reset.

Token cost is the defining operational concern of agent workloads. Treat it as a first-class constraint, not an afterthought.
