/**
 * Per-turn model selection with fallback, cost-tier, and A/B testing strategies.
 *
 * Provides composable routers that choose which LLM model to use for a given
 * conversation turn based on budget, deterministic hashing, or custom logic.
 *
 * @module model-router
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Context provided to a {@link ModelRouter} on each turn. Contains budget,
 * conversation state, and workflow identity so routers can make informed decisions.
 *
 * @example Read routing context inside a custom router
 * ```ts
 * import { customRouter, type RoutingContext } from 'weft';
 *
 * const router = customRouter((ctx: RoutingContext) => ({
 *   model: ctx.budgetRemaining && ctx.budgetRemaining.costRemaining < 0.05
 *     ? 'claude-haiku-3-5'
 *     : 'claude-sonnet-4-5',
 * }));
 * ```
 */
export interface RoutingContext {
  workflowId: string;
  turnIndex: number;
  conversationLength: number;
  budgetRemaining?: { tokensRemaining: number; costRemaining: number } | undefined;
  previousModels: string[];
  metadata?: Record<string, unknown> | undefined;
}

/**
 * Return value from {@link ModelRouter.select}. Carries the chosen `model`
 * identifier, an optional ordered `fallback` list tried on provider errors,
 * and an optional human-readable `reason` for audit logs and observability.
 *
 * @example Provide a fallback chain with an audit reason
 * ```ts
 * import { customRouter, type ModelSelection } from 'weft';
 *
 * const router = customRouter((ctx): ModelSelection => ({
 *   model: 'claude-sonnet-4-5',
 *   fallback: ['claude-haiku-3-5'],
 *   reason: ctx.turnIndex === 0 ? 'first-turn-premium' : 'standard',
 * }));
 * ```
 */
export interface ModelSelection {
  model: string;
  fallback?: string[] | undefined;
  reason?: string | undefined;
}

/**
 * Interface for per-turn LLM model selection within the agent loop. The loop
 * calls `select(context)` once before each turn to choose the model and optional
 * fallback list. Implement this interface for custom routing logic, or use the
 * built-in factories: {@link staticFallbackRouter}, {@link costTierRouter},
 * {@link abTestRouter}, or {@link customRouter}.
 *
 * @example Implement a custom router that uses a large model on the last turn
 * ```ts
 * import type { ModelRouter, ModelSelection, RoutingContext } from 'weft';
 *
 * const finalTurnRouter: ModelRouter = {
 *   select(ctx: RoutingContext): ModelSelection {
 *     const isLastTurn = ctx.turnIndex >= 4;
 *     return { model: isLastTurn ? 'claude-3-opus-20240229' : 'claude-haiku-3-5' };
 *   },
 * };
 * ```
 */
export interface ModelRouter {
  select(context: RoutingContext): ModelSelection;
}

export interface CostTier {
  model: string;
  /** Switch to this tier when cost remaining drops below this threshold. */
  maxCostRemaining?: number | undefined;
  /** Switch to this tier when tokens remaining drops below this threshold. */
  maxTokensRemaining?: number | undefined;
  fallback?: string[] | undefined;
}

export interface WeightedVariant {
  model: string;
  /** Weight between 0 and 1. All weights in a variant list should sum to 1. */
  weight: number;
  fallback?: string[] | undefined;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * FNV-1a 32-bit hash with avalanche finalization.
 *
 * Produces a well-distributed unsigned 32-bit integer from a string.
 * The finalization step improves distribution for sequential inputs
 * (e.g., "workflow-0", "workflow-1", ...) which is important for A/B routing.
 */
function hashString(input: string): number {
  let hash = 0x811c9dc5; // FNV offset basis
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193); // FNV prime
  }
  // Avalanche / finalization mix for better bit distribution
  hash ^= hash >>> 16;
  hash = Math.imul(hash, 0x45d9f3b);
  hash ^= hash >>> 16;
  return hash >>> 0; // ensure unsigned
}

// ---------------------------------------------------------------------------
// Router factories
// ---------------------------------------------------------------------------

/**
 * Creates a router that always returns the primary model with a static fallback list.
 *
 * @example Always use claude-sonnet-4-5 with two fallbacks
 * ```ts
 * import { staticFallbackRouter } from 'weft';
 *
 * const router = staticFallbackRouter('claude-sonnet-4-5', [
 *   'claude-haiku-3-5',
 *   'claude-3-opus-20240229',
 * ]);
 * ```
 */
export function staticFallbackRouter(primary: string, fallbacks: string[]): ModelRouter {
  return {
    select(): ModelSelection {
      return {
        model: primary,
        fallback: fallbacks,
      };
    },
  };
}

/**
 * Creates a router that switches models based on remaining budget.
 *
 * Tiers are sorted by `maxCostRemaining` descending (highest threshold first).
 * A tier is eligible when the remaining budget is **at or above** its threshold.
 * The router picks the first eligible tier. Tiers without a cost or token
 * threshold act as catch-all entries and are always eligible.
 *
 * When no budget info is provided, the first tier is returned as a safe default.
 *
 * @example Downgrade to a cheaper model when budget drops below $0.10
 * ```ts
 * import { costTierRouter } from 'weft';
 *
 * const router = costTierRouter([
 *   { model: 'claude-sonnet-4-5', maxCostRemaining: 0.10 },
 *   { model: 'claude-haiku-3-5' },
 * ]);
 * ```
 */
export function costTierRouter(tiers: CostTier[]): ModelRouter {
  // Sort tiers by threshold descending so the "most expensive" tier comes first.
  // Tiers without a threshold sort to the end (they are the catch-all).
  const sorted = tiers.toSorted((a, b) => {
    const aCost = a.maxCostRemaining ?? -Infinity;
    const bCost = b.maxCostRemaining ?? -Infinity;
    return bCost - aCost;
  });

  return {
    select(context: RoutingContext): ModelSelection {
      const budget = context.budgetRemaining;

      // No budget info: return the first (highest-threshold) tier.
      if (!budget) {
        const tier = sorted[0]!;
        return {
          model: tier.model,
          fallback: tier.fallback,
        };
      }

      // Walk from highest threshold to lowest. The first tier whose threshold
      // the budget *meets or exceeds* is selected.
      for (const tier of sorted) {
        const costThreshold = tier.maxCostRemaining;
        const tokenThreshold = tier.maxTokensRemaining;

        // A tier with no thresholds is a catch-all -- always eligible.
        if (costThreshold === undefined && tokenThreshold === undefined) {
          return { model: tier.model, fallback: tier.fallback };
        }

        const meetsCost = costThreshold === undefined || budget.costRemaining >= costThreshold;
        const meetsTokens =
          tokenThreshold === undefined || budget.tokensRemaining >= tokenThreshold;

        if (meetsCost && meetsTokens) {
          return { model: tier.model, fallback: tier.fallback };
        }
      }

      // Shouldn't happen if tiers are well-formed, but fall back to first tier.
      const fallbackTier = sorted[0]!;
      return { model: fallbackTier.model, fallback: fallbackTier.fallback };
    },
  };
}

/**
 * Creates a deterministic A/B router based on workflow ID hash.
 *
 * The workflow ID is hashed via FNV-1a and normalized to a value in [0, 1).
 * Variants are selected by walking cumulative weights until the hash falls
 * within a variant's range. The same workflow ID always yields the same variant.
 *
 * @example Route 20 % of workflows to a new model
 * ```ts
 * import { abTestRouter } from 'weft';
 *
 * const router = abTestRouter([
 *   { model: 'claude-sonnet-4-5', weight: 0.8 },
 *   { model: 'claude-3-opus-20240229', weight: 0.2 },
 * ]);
 * ```
 */
export function abTestRouter(variants: WeightedVariant[]): ModelRouter {
  return {
    select(context: RoutingContext): ModelSelection {
      const hash = hashString(context.workflowId);
      const normalized = hash / 0x100000000; // map to [0, 1)

      let cumulative = 0;
      for (const variant of variants) {
        cumulative += variant.weight;
        if (normalized < cumulative) {
          return {
            model: variant.model,
            fallback: variant.fallback,
          };
        }
      }

      // Fallback to the last variant in case of floating-point rounding.
      const last = variants[variants.length - 1]!;
      return {
        model: last.model,
        fallback: last.fallback,
      };
    },
  };
}

/**
 * Creates a router from a custom selection function.
 *
 * @example Route to different models based on turn index
 * ```ts
 * import { customRouter } from 'weft';
 *
 * // Use a cheap model for early turns; switch to a powerful one later.
 * const router = customRouter((ctx) => ({
 *   model: ctx.turnIndex < 3 ? 'claude-haiku-3-5' : 'claude-sonnet-4-5',
 * }));
 * ```
 */
export function customRouter(fn: (context: RoutingContext) => ModelSelection): ModelRouter {
  return {
    select(context: RoutingContext): ModelSelection {
      return fn(context);
    },
  };
}
