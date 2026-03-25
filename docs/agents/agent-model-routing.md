# Model Routing

You don't always want the same model for every turn. Maybe you want the flagship model for complex reasoning but a cheaper one for summarization. Maybe you want automatic fallback when Anthropic's API is down. Maybe you're A/B testing two models to compare quality. The `ModelRouter` interface makes all of these composable and pluggable.

## The interface

A `ModelRouter` has one method: `select()`. It receives a `RoutingContext` describing the current turn and returns a `ModelSelection`.

```typescript
interface ModelRouter {
  select(context: RoutingContext): ModelSelection;
}

interface RoutingContext {
  workflowId: string;
  turnIndex: number;
  conversationLength: number;
  budgetRemaining?: { tokensRemaining: number; costRemaining: number };
  previousModels: string[];
  metadata?: Record<string, unknown>;
}

interface ModelSelection {
  model: string;
  fallback?: string[];
  reason?: string;
}
```

The `reason` field is optional but valuable—it shows up in `AgentTurnCompletedEvent` for observability, letting you understand _why_ a particular model was chosen for each turn.

Pass a router to `defineAgent()` or `executeAgentLoop()`:

```typescript
const agent = defineAgent({
  name: 'analyst',
  model: 'claude-sonnet-4-20250514',
  modelRouter: myRouter,
});
```

When a router is present, the `model` field on the definition serves as the default—the router's selection overrides it for each turn.

## Static fallback router

The simplest configuration: always use the primary model, but provide an ordered fallback chain for when it fails.

```typescript
import { staticFallbackRouter } from 'weft';

const router = staticFallbackRouter('claude-sonnet-4-20250514', [
  'gpt-4o',
  'claude-haiku-4-5-20251001',
]);
```

Every call to `select()` returns the same model with the same fallback list. If Claude Sonnet fails (rate limit, timeout, outage), the agent tries GPT-4o. If that also fails, it falls back to Haiku. Each fallback attempt is a separate checkpoint boundary.

## Cost-tier router

When budget is a concern, `costTierRouter` automatically switches to cheaper models as the budget depletes.

```typescript
import { costTierRouter } from 'weft';

const router = costTierRouter([
  { model: 'claude-sonnet-4-20250514', maxCostRemaining: 5.0 },
  { model: 'gpt-4o-mini', maxCostRemaining: 1.0 },
  { model: 'claude-haiku-4-5-20251001' }, // No threshold — catch-all
]);
```

Tiers are sorted internally by `maxCostRemaining` descending. On each turn, the router walks from the most expensive tier to the cheapest and picks the first one whose threshold the remaining budget meets or exceeds. A tier without a threshold acts as a catch-all—it's always eligible.

You can also use `maxTokensRemaining` for token-based thresholds:

```typescript
const router = costTierRouter([
  { model: 'claude-sonnet-4-20250514', maxTokensRemaining: 100_000 },
  { model: 'claude-haiku-4-5-20251001' },
]);
```

Both thresholds can be combined on a single tier—the tier is eligible only when _both_ are met.

When no budget information is available in the routing context (the agent wasn't given a `BudgetTracker`), the first tier is returned as a safe default.

## A/B test router

Compare model quality by routing a fraction of workflows to different models:

```typescript
import { abTestRouter } from 'weft';

const router = abTestRouter([
  { model: 'claude-sonnet-4-20250514', weight: 0.8 },
  { model: 'gpt-4o', weight: 0.2 },
]);
```

Weights should sum to 1. The router hashes the workflow ID using FNV-1a with avalanche finalization, producing a deterministic value in [0, 1). It then walks the cumulative weights and selects the matching variant.

Because the selection is based on a hash of the workflow ID, the same workflow always gets the same model—across turns, across restarts, across process crashes. This gives you reproducible A/B cohorts without external randomization infrastructure.

Each variant can include its own fallback chain:

```typescript
const router = abTestRouter([
  { model: 'claude-sonnet-4-20250514', weight: 0.8, fallback: ['claude-haiku-4-5-20251001'] },
  { model: 'gpt-4o', weight: 0.2, fallback: ['gpt-4o-mini'] },
]);
```

## Custom router

For logic that doesn't fit a built-in pattern, `customRouter()` wraps any function:

```typescript
import { customRouter } from 'weft';

const router = customRouter((context) => {
  // Complex reasoning turns get the best model
  if (context.conversationLength > 50) {
    return { model: 'claude-sonnet-4-20250514', reason: 'complex-reasoning' };
  }

  // Low budget: use the cheapest model
  if (context.budgetRemaining && context.budgetRemaining.costRemaining < 1.0) {
    return { model: 'claude-haiku-4-5-20251001', reason: 'budget-conservation' };
  }

  // Default with fallback
  return {
    model: 'claude-sonnet-4-20250514',
    fallback: ['gpt-4o'],
    reason: 'default',
  };
});
```

Custom routers have access to everything in `RoutingContext`: the turn index, conversation length, budget state, and list of models used in previous turns. The `metadata` field is an open record you can populate with domain-specific routing signals.

## Fallback events

When a model fails and the engine tries the next one in the fallback chain, it dispatches `AgentModelFallbackEvent`:

```typescript
engine.addEventListener('agent:model:fallback', (event) => {
  console.warn(
    `Turn ${event.turnIndex}: ${event.failedModel} failed (${event.failedReason}),`,
    `trying ${event.nextModel} (attempt ${event.attemptIndex})`,
  );
});
```

The event carries the failed model, the reason for failure, the next model being tried, and the attempt index. See the [observability guide](./agent-observability.md) for the full event type reference.

## Checkpointed model selection

The model chosen for each turn is recorded in the checkpoint. On recovery, the same model is used for the retried turn—no re-routing. This ensures deterministic retry behavior even when the router would now select a different model due to changed budget conditions or updated health status.

This is a subtle but important property. Without it, a crash-and-recover cycle could switch models mid-conversation, potentially confusing the agent's reasoning chain.

Model routing is where operational concerns (cost, availability, quality measurement) meet agent execution. Keep your routers simple—the built-in factories cover most production scenarios, and `customRouter()` handles the rest.
