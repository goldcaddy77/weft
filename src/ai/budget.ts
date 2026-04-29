/**
 * Token and cost tracking with AbortController enforcement.
 *
 * Tracks LLM token usage and cost against configurable budgets,
 * fires warning and exceeded callbacks, and aborts an optional
 * AbortController when the budget is exceeded.
 *
 * @module budget
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Configuration object that governs how a {@link BudgetTracker} enforces token
 * and cost limits for an agent loop.
 *
 * @example Cap cost at $0.50 with per-model pricing
 * ```ts
 * import { BudgetTracker, type BudgetOptions } from 'weft';
 *
 * const options: BudgetOptions = {
 *   maxCost: 0.5,
 *   maxTokens: 50_000,
 *   warningThreshold: 0.75,
 *   models: {
 *     'claude-sonnet-4-5': { inputCostPer1K: 0.003, outputCostPer1K: 0.015 },
 *     'claude-haiku-3-5':  { inputCostPer1K: 0.00025, outputCostPer1K: 0.00125 },
 *   },
 * };
 *
 * const tracker = new BudgetTracker(options, {
 *   onWarning: (state) => console.warn('Budget 75 % used', state.costUsed),
 * });
 * ```
 */
export interface BudgetOptions {
  maxTokens?: number | undefined;
  maxCost?: number | undefined;
  /** Fraction (0-1) at which the warning callback fires. Defaults to 0.8. */
  warningThreshold?: number | undefined;
  models: Record<string, ModelPricing>;
}

/**
 * Per-model cost rates used by {@link BudgetTracker} to compute the USD cost
 * of each LLM turn. Specify rates in dollars per 1 000 tokens, matching the
 * provider's published pricing page.
 *
 * @example Define pricing for two Anthropic models
 * ```ts
 * import { BudgetTracker, type ModelPricing } from 'weft';
 *
 * const pricing: Record<string, ModelPricing> = {
 *   'claude-sonnet-4-5': { inputCostPer1K: 0.003, outputCostPer1K: 0.015 },
 *   'claude-haiku-3-5':  { inputCostPer1K: 0.00025, outputCostPer1K: 0.00125 },
 * };
 *
 * const tracker = new BudgetTracker({ maxCost: 1.0, models: pricing });
 * ```
 */
export interface ModelPricing {
  inputCostPer1K: number;
  outputCostPer1K: number;
}

/**
 * Snapshot of token and cost usage returned by {@link BudgetTracker.budgetRemaining}.
 * Provides totals used, remaining capacities (Infinity when no limit is set),
 * and a per-model breakdown array. This interface is read-only at every call site —
 * callers observe it; they do not construct it.
 */
export interface BudgetState {
  tokensUsed: number;
  costUsed: number;
  tokensRemaining: number;
  costRemaining: number;
  breakdown: ModelUsageEntry[];
}

export interface ModelUsageEntry {
  model: string;
  inputTokens: number;
  outputTokens: number;
  cost: number;
}

export interface BudgetCallbacks {
  onWarning?: (state: BudgetState) => void;
  onExceeded?: (state: BudgetState) => void;
}

export interface SerializedBudgetState {
  tokensUsed: number;
  costUsed: number;
  breakdown: ModelUsageEntry[];
  warningFired: boolean;
}

// ---------------------------------------------------------------------------
// Error
// ---------------------------------------------------------------------------

/**
 * Thrown by {@link BudgetTracker.checkBudget} when accumulated token or cost
 * usage exceeds the configured maximums. Carries `tokensUsed`, `costUsed`,
 * and the configured `maxTokens` / `maxCost` limits as properties so callers
 * can surface detailed diagnostics.
 *
 * @example Catch a budget exceeded error and surface remaining info
 * ```ts
 * import { BudgetTracker, BudgetExceededError } from 'weft';
 *
 * const tracker = new BudgetTracker({
 *   maxCost: 0.01,
 *   models: { 'claude-haiku-3-5': { inputCostPer1K: 0.00025, outputCostPer1K: 0.00125 } },
 * });
 *
 * try {
 *   tracker.recordUsage('claude-haiku-3-5', 100_000, 20_000);
 *   tracker.checkBudget();
 * } catch (error) {
 *   if (error instanceof BudgetExceededError) {
 *     console.error(`Cost ${error.costUsed.toFixed(4)} exceeds limit ${error.maxCost}`);
 *   }
 * }
 * ```
 */
export class BudgetExceededError extends Error {
  readonly tokensUsed: number;
  readonly costUsed: number;
  readonly maxTokens: number | undefined;
  readonly maxCost: number | undefined;

  constructor(state: BudgetState, maxTokens?: number, maxCost?: number) {
    super(
      `Budget exceeded: ${String(state.tokensUsed)} tokens used` +
        (maxTokens !== undefined ? ` (max ${String(maxTokens)})` : '') +
        `, $${String(state.costUsed.toFixed(4))} cost` +
        (maxCost !== undefined ? ` (max $${String(maxCost)})` : ''),
    );
    this.name = 'BudgetExceededError';
    this.tokensUsed = state.tokensUsed;
    this.costUsed = state.costUsed;
    this.maxTokens = maxTokens;
    this.maxCost = maxCost;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function computeCost(
  model: string,
  inputTokens: number,
  outputTokens: number,
  models: Record<string, ModelPricing>,
): number {
  const pricing = models[model];
  if (!pricing) {
    return 0;
  }
  return (
    (inputTokens / 1000) * pricing.inputCostPer1K + (outputTokens / 1000) * pricing.outputCostPer1K
  );
}

// ---------------------------------------------------------------------------
// BudgetTracker
// ---------------------------------------------------------------------------

/**
 * Tracks per-model token and cost usage against configurable limits for an agent
 * loop. Records each LLM turn, fires warning and exceeded callbacks at configured
 * thresholds, and optionally aborts an `AbortController` when the budget is
 * exhausted. Supports checkpoint serialization via {@link BudgetTracker.toJSON} and
 * {@link BudgetTracker.fromJSON} for durable agents.
 *
 * @example Cap an agent at $0.50 and warn at 80%
 * ```ts
 * import { BudgetTracker } from 'weft';
 *
 * const tracker = new BudgetTracker(
 *   {
 *     maxCost: 0.5,
 *     maxTokens: 100_000,
 *     models: { 'claude-sonnet-4-5': { inputCostPer1K: 0.003, outputCostPer1K: 0.015 } },
 *   },
 *   {
 *     onWarning: (state) => console.warn('Budget 80% used, remaining:', state.costRemaining),
 *     onExceeded: (state) => console.error('Budget exceeded at cost:', state.costUsed),
 *   },
 * );
 *
 * tracker.recordUsage('claude-sonnet-4-5', 10_000, 2_000);
 * console.log(tracker.budgetRemaining().costUsed);
 * ```
 */
export class BudgetTracker {
  #options: BudgetOptions;
  #tokensUsed: number;
  #costUsed: number;
  #breakdown: Map<string, ModelUsageEntry>;
  #abortController: AbortController | undefined;
  #warningFired: boolean;
  #onWarning: ((state: BudgetState) => void) | undefined;
  #onExceeded: ((state: BudgetState) => void) | undefined;
  #usageCount: number;

  constructor(options: BudgetOptions, callbacks?: BudgetCallbacks) {
    this.#options = options;
    this.#tokensUsed = 0;
    this.#costUsed = 0;
    this.#breakdown = new Map();
    this.#abortController = undefined;
    this.#warningFired = false;
    this.#onWarning = callbacks?.onWarning;
    this.#onExceeded = callbacks?.onExceeded;
    this.#usageCount = 0;
  }

  /** Record token usage from an LLM call. Returns true if budget still available. */
  recordUsage(model: string, inputTokens: number, outputTokens: number): boolean {
    const cost = computeCost(model, inputTokens, outputTokens, this.#options.models);
    const totalTokens = inputTokens + outputTokens;

    this.#tokensUsed += totalTokens;
    this.#costUsed += cost;
    this.#usageCount += 1;

    // Update per-model breakdown
    const existing = this.#breakdown.get(model);
    if (existing) {
      existing.inputTokens += inputTokens;
      existing.outputTokens += outputTokens;
      existing.cost += cost;
    } else {
      this.#breakdown.set(model, {
        model,
        inputTokens,
        outputTokens,
        cost,
      });
    }

    const exceeded = this.#isExceeded();

    // Check warning threshold (fires once, before exceeded)
    if (!this.#warningFired && !exceeded && this.#onWarning) {
      const threshold = this.#options.warningThreshold ?? 0.8;
      const tokenFraction =
        this.#options.maxTokens !== undefined ? this.#tokensUsed / this.#options.maxTokens : 0;
      const costFraction =
        this.#options.maxCost !== undefined ? this.#costUsed / this.#options.maxCost : 0;

      if (tokenFraction >= threshold || costFraction >= threshold) {
        this.#warningFired = true;
        this.#onWarning(this.budgetRemaining());
      }
    }

    // Check exceeded
    if (exceeded) {
      // Fire warning if it hasn't been fired yet
      if (!this.#warningFired && this.#onWarning) {
        this.#warningFired = true;
        this.#onWarning(this.budgetRemaining());
      }
      this.#warningFired = true;

      this.#onExceeded?.(this.budgetRemaining());

      if (this.#abortController && !this.#abortController.signal.aborted) {
        this.#abortController.abort(
          new BudgetExceededError(
            this.budgetRemaining(),
            this.#options.maxTokens,
            this.#options.maxCost,
          ),
        );
      }

      return false;
    }

    return true;
  }

  /** Get remaining budget state. */
  budgetRemaining(): BudgetState {
    const tokensRemaining =
      this.#options.maxTokens !== undefined ? this.#options.maxTokens - this.#tokensUsed : Infinity;
    const costRemaining =
      this.#options.maxCost !== undefined ? this.#options.maxCost - this.#costUsed : Infinity;

    return {
      tokensUsed: this.#tokensUsed,
      costUsed: this.#costUsed,
      tokensRemaining,
      costRemaining,
      breakdown: [...this.#breakdown.values()],
    };
  }

  /** Check if budget has room for another call. Throws BudgetExceededError if not. */
  checkBudget(): void {
    if (this.#isExceeded()) {
      throw new BudgetExceededError(
        this.budgetRemaining(),
        this.#options.maxTokens,
        this.#options.maxCost,
      );
    }
  }

  /** Project remaining capacity based on average burn rate. */
  budgetProjection(): { estimatedTurnsRemaining: number; estimatedCostAtCompletion: number } {
    if (this.#usageCount === 0) {
      return { estimatedTurnsRemaining: 0, estimatedCostAtCompletion: 0 };
    }

    if (this.#isExceeded()) {
      return {
        estimatedTurnsRemaining: 0,
        estimatedCostAtCompletion: this.#costUsed,
      };
    }

    const averageCostPerTurn = this.#costUsed / this.#usageCount;
    const averageTokensPerTurn = this.#tokensUsed / this.#usageCount;

    // Determine the limiting factor
    let turnsRemainingByCost = Infinity;
    let turnsRemainingByTokens = Infinity;

    if (this.#options.maxCost !== undefined && averageCostPerTurn > 0) {
      const costRemaining = this.#options.maxCost - this.#costUsed;
      turnsRemainingByCost = Math.floor(costRemaining / averageCostPerTurn);
    }

    if (this.#options.maxTokens !== undefined && averageTokensPerTurn > 0) {
      const tokensRemaining = this.#options.maxTokens - this.#tokensUsed;
      turnsRemainingByTokens = Math.floor(tokensRemaining / averageTokensPerTurn);
    }

    const estimatedTurnsRemaining = Math.max(
      0,
      Math.min(turnsRemainingByCost, turnsRemainingByTokens),
    );

    // Estimated cost at completion: cost used so far + (remaining turns * average cost)
    const estimatedCostAtCompletion = this.#costUsed + estimatedTurnsRemaining * averageCostPerTurn;

    // Clamp to maxCost if set
    if (this.#options.maxCost !== undefined) {
      return {
        estimatedTurnsRemaining,
        estimatedCostAtCompletion: Math.min(estimatedCostAtCompletion, this.#options.maxCost),
      };
    }

    return { estimatedTurnsRemaining, estimatedCostAtCompletion };
  }

  /** Get the abort signal (fires when budget exceeded). */
  get signal(): AbortSignal | undefined {
    return this.#abortController?.signal;
  }

  /** Set an AbortController that will be aborted on budget exceeded. */
  setAbortController(controller: AbortController): void {
    this.#abortController = controller;
  }

  /** Create an isolated copy that can diverge without mutating this tracker. */
  clone(): BudgetTracker {
    const tracker = new BudgetTracker(this.#options, {
      ...(this.#onWarning ? { onWarning: this.#onWarning } : {}),
      ...(this.#onExceeded ? { onExceeded: this.#onExceeded } : {}),
    });
    tracker.#tokensUsed = this.#tokensUsed;
    tracker.#costUsed = this.#costUsed;
    tracker.#warningFired = this.#warningFired;
    tracker.#usageCount = this.#usageCount;

    for (const [model, entry] of this.#breakdown) {
      tracker.#breakdown.set(model, { ...entry });
    }

    return tracker;
  }

  /** Serialize budget state for checkpoint. */
  toJSON(): SerializedBudgetState {
    return {
      tokensUsed: this.#tokensUsed,
      costUsed: this.#costUsed,
      breakdown: [...this.#breakdown.values()],
      warningFired: this.#warningFired,
    };
  }

  /** Restore from checkpoint. */
  static fromJSON(
    data: SerializedBudgetState,
    options: BudgetOptions,
    callbacks?: BudgetCallbacks,
  ): BudgetTracker {
    const tracker = new BudgetTracker(options, callbacks);
    tracker.#tokensUsed = data.tokensUsed;
    tracker.#costUsed = data.costUsed;
    tracker.#warningFired = data.warningFired;
    tracker.#usageCount = data.breakdown.length;

    for (const entry of data.breakdown) {
      tracker.#breakdown.set(entry.model, { ...entry });
    }

    return tracker;
  }

  // ---------------------------------------------------------------------------
  // Private
  // ---------------------------------------------------------------------------

  #isExceeded(): boolean {
    if (this.#options.maxTokens !== undefined && this.#tokensUsed > this.#options.maxTokens) {
      return true;
    }
    if (this.#options.maxCost !== undefined && this.#costUsed > this.#options.maxCost) {
      return true;
    }
    return false;
  }
}
