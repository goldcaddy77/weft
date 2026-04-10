import { describe, expect, it } from 'bun:test';

import {
  BudgetExceededError,
  BudgetTracker,
  type BudgetOptions,
  type BudgetState,
  type ModelPricing,
} from './budget.ts';

const TEST_MODELS: Record<string, ModelPricing> = {
  'gpt-4': { inputCostPer1K: 0.03, outputCostPer1K: 0.06 },
  'gpt-3.5': { inputCostPer1K: 0.001, outputCostPer1K: 0.002 },
};

function createOptions(overrides?: Partial<BudgetOptions>): BudgetOptions {
  return {
    maxTokens: 100_000,
    maxCost: 10,
    models: TEST_MODELS,
    ...overrides,
  };
}

describe('BudgetTracker', () => {
  describe('fresh budget has full remaining capacity', () => {
    it('reports full tokens and cost remaining', () => {
      const tracker = new BudgetTracker(createOptions());
      const state = tracker.budgetRemaining();

      expect(state.tokensUsed).toBe(0);
      expect(state.costUsed).toBe(0);
      expect(state.tokensRemaining).toBe(100_000);
      expect(state.costRemaining).toBe(10);
      expect(state.breakdown).toEqual([]);
    });
  });

  describe('recordUsage reduces remaining tokens', () => {
    it('subtracts total tokens from remaining', () => {
      const tracker = new BudgetTracker(createOptions());

      tracker.recordUsage('gpt-4', 500, 200);
      const state = tracker.budgetRemaining();

      expect(state.tokensUsed).toBe(700);
      expect(state.tokensRemaining).toBe(99_300);
    });
  });

  describe('recordUsage reduces remaining cost', () => {
    it('subtracts computed cost from remaining', () => {
      const tracker = new BudgetTracker(createOptions());

      // cost = (1000 / 1000 * 0.03) + (500 / 1000 * 0.06) = 0.03 + 0.03 = 0.06
      tracker.recordUsage('gpt-4', 1000, 500);
      const state = tracker.budgetRemaining();

      expect(state.costUsed).toBeCloseTo(0.06, 10);
      expect(state.costRemaining).toBeCloseTo(9.94, 10);
    });
  });

  describe('cost calculation is correct', () => {
    it('computes cost using known pricing for gpt-4', () => {
      const tracker = new BudgetTracker(createOptions());

      // input: 2000 tokens at $0.03/1K = $0.06
      // output: 1000 tokens at $0.06/1K = $0.06
      // total = $0.12
      tracker.recordUsage('gpt-4', 2000, 1000);
      const state = tracker.budgetRemaining();

      expect(state.costUsed).toBeCloseTo(0.12, 10);
    });

    it('computes cost using known pricing for gpt-3.5', () => {
      const tracker = new BudgetTracker(createOptions());

      // input: 5000 tokens at $0.001/1K = $0.005
      // output: 3000 tokens at $0.002/1K = $0.006
      // total = $0.011
      tracker.recordUsage('gpt-3.5', 5000, 3000);
      const state = tracker.budgetRemaining();

      expect(state.costUsed).toBeCloseTo(0.011, 10);
    });
  });

  describe('warning callback fires at 80% threshold', () => {
    it('fires onWarning when tokens reach 80%', () => {
      const warnings: BudgetState[] = [];
      const tracker = new BudgetTracker(createOptions({ maxTokens: 1000, maxCost: 100 }), {
        onWarning: (state) => warnings.push(state),
      });

      // 800 tokens = exactly 80% of 1000
      tracker.recordUsage('gpt-4', 400, 400);

      expect(warnings).toHaveLength(1);
      expect(warnings[0]!.tokensUsed).toBe(800);
    });

    it('fires onWarning when cost reaches 80%', () => {
      const warnings: BudgetState[] = [];
      const tracker = new BudgetTracker(createOptions({ maxTokens: 1_000_000, maxCost: 1 }), {
        onWarning: (state) => warnings.push(state),
      });

      // Need cost >= 0.80
      // gpt-4 input: 0.03/1K, so 27_000 input tokens = $0.81
      tracker.recordUsage('gpt-4', 27_000, 0);

      expect(warnings).toHaveLength(1);
      expect(warnings[0]!.costUsed).toBeGreaterThanOrEqual(0.8);
    });

    it('uses custom warningThreshold', () => {
      const warnings: BudgetState[] = [];
      const tracker = new BudgetTracker(
        createOptions({ maxTokens: 1000, maxCost: 100, warningThreshold: 0.5 }),
        { onWarning: (state) => warnings.push(state) },
      );

      // 500 tokens = 50% of 1000
      tracker.recordUsage('gpt-4', 250, 250);

      expect(warnings).toHaveLength(1);
    });
  });

  describe('warning fires only once', () => {
    it('does not re-fire onWarning on subsequent calls', () => {
      const warnings: BudgetState[] = [];
      const tracker = new BudgetTracker(createOptions({ maxTokens: 1000, maxCost: 100 }), {
        onWarning: (state) => warnings.push(state),
      });

      tracker.recordUsage('gpt-4', 450, 450); // 900 tokens = 90%
      tracker.recordUsage('gpt-4', 50, 0); // 950 tokens = 95%

      expect(warnings).toHaveLength(1);
    });
  });

  describe('BudgetExceededError thrown when maxTokens exceeded', () => {
    it('recordUsage returns false and onExceeded fires', () => {
      const exceeded: BudgetState[] = [];
      const tracker = new BudgetTracker(createOptions({ maxTokens: 500, maxCost: 100 }), {
        onExceeded: (state) => exceeded.push(state),
      });

      const first = tracker.recordUsage('gpt-4', 200, 200); // 400 tokens
      expect(first).toBe(true);

      const second = tracker.recordUsage('gpt-4', 100, 100); // 600 tokens, exceeds 500
      expect(second).toBe(false);
      expect(exceeded).toHaveLength(1);
    });

    it('checkBudget throws BudgetExceededError', () => {
      const tracker = new BudgetTracker(createOptions({ maxTokens: 500, maxCost: 100 }));

      tracker.recordUsage('gpt-4', 300, 300); // 600 tokens, exceeds 500

      expect(() => tracker.checkBudget()).toThrow(BudgetExceededError);
    });
  });

  describe('BudgetExceededError thrown when maxCost exceeded', () => {
    it('recordUsage returns false and onExceeded fires', () => {
      const exceeded: BudgetState[] = [];
      const tracker = new BudgetTracker(createOptions({ maxTokens: 1_000_000, maxCost: 0.05 }), {
        onExceeded: (state) => exceeded.push(state),
      });

      // cost = (1000/1000 * 0.03) + (500/1000 * 0.06) = 0.03 + 0.03 = 0.06 > 0.05
      const result = tracker.recordUsage('gpt-4', 1000, 500);
      expect(result).toBe(false);
      expect(exceeded).toHaveLength(1);
    });

    it('checkBudget throws BudgetExceededError', () => {
      const tracker = new BudgetTracker(createOptions({ maxTokens: 1_000_000, maxCost: 0.05 }));

      tracker.recordUsage('gpt-4', 1000, 500);

      expect(() => tracker.checkBudget()).toThrow(BudgetExceededError);
    });
  });

  describe('AbortController aborted on exceeded', () => {
    it('aborts the signal when budget exceeded', () => {
      const controller = new AbortController();
      const tracker = new BudgetTracker(createOptions({ maxTokens: 100, maxCost: 100 }));
      tracker.setAbortController(controller);

      expect(controller.signal.aborted).toBe(false);

      tracker.recordUsage('gpt-4', 60, 60); // 120 > 100

      expect(controller.signal.aborted).toBe(true);
    });

    it('exposes signal via getter', () => {
      const controller = new AbortController();
      const tracker = new BudgetTracker(createOptions());
      tracker.setAbortController(controller);

      expect(tracker.signal).toBe(controller.signal);
    });

    it('returns undefined signal when no controller set', () => {
      const tracker = new BudgetTracker(createOptions());

      expect(tracker.signal).toBeUndefined();
    });
  });

  describe('budgetRemaining returns correct breakdown per model', () => {
    it('tracks per-model usage separately', () => {
      const tracker = new BudgetTracker(createOptions());

      tracker.recordUsage('gpt-4', 1000, 500);
      tracker.recordUsage('gpt-3.5', 2000, 1000);
      tracker.recordUsage('gpt-4', 500, 250);

      const state = tracker.budgetRemaining();
      expect(state.breakdown).toHaveLength(2);

      const gpt4 = state.breakdown.find((entry) => entry.model === 'gpt-4');
      expect(gpt4).toBeDefined();
      expect(gpt4!.inputTokens).toBe(1500);
      expect(gpt4!.outputTokens).toBe(750);
      // cost = (1500/1000*0.03) + (750/1000*0.06) = 0.045 + 0.045 = 0.09
      expect(gpt4!.cost).toBeCloseTo(0.09, 10);

      const gpt35 = state.breakdown.find((entry) => entry.model === 'gpt-3.5');
      expect(gpt35).toBeDefined();
      expect(gpt35!.inputTokens).toBe(2000);
      expect(gpt35!.outputTokens).toBe(1000);
      // cost = (2000/1000*0.001) + (1000/1000*0.002) = 0.002 + 0.002 = 0.004
      expect(gpt35!.cost).toBeCloseTo(0.004, 10);
    });
  });

  describe('budgetProjection estimates remaining turns', () => {
    it('projects based on average cost per usage', () => {
      // Use only maxCost so cost is the sole limiting factor
      const tracker = new BudgetTracker(createOptions({ maxTokens: undefined, maxCost: 10 }));

      // Each call costs $0.06: (1000/1000*0.03) + (500/1000*0.06)
      tracker.recordUsage('gpt-4', 1000, 500);
      tracker.recordUsage('gpt-4', 1000, 500);

      const projection = tracker.budgetProjection();
      // Total cost so far: $0.12, remaining: $9.88
      // Average per turn: $0.06
      // Estimated turns: floor(9.88 / 0.06) = 164
      expect(projection.estimatedTurnsRemaining).toBe(Math.floor(9.88 / 0.06));
      // 0.12 already used + 164 turns * $0.06 = $9.96
      expect(projection.estimatedCostAtCompletion).toBeCloseTo(9.96, 2);
    });

    it('returns zero turns when no usage recorded', () => {
      const tracker = new BudgetTracker(createOptions());

      const projection = tracker.budgetProjection();

      expect(projection.estimatedTurnsRemaining).toBe(0);
      expect(projection.estimatedCostAtCompletion).toBe(0);
    });

    it('returns zero turns when budget already exceeded', () => {
      const tracker = new BudgetTracker(createOptions({ maxTokens: 100, maxCost: 100 }));

      tracker.recordUsage('gpt-4', 60, 60); // 120 > 100

      const projection = tracker.budgetProjection();
      expect(projection.estimatedTurnsRemaining).toBe(0);
    });
  });

  describe('toJSON and fromJSON round-trips correctly', () => {
    it('serializes and restores full state', () => {
      const options = createOptions();
      const warnings: BudgetState[] = [];
      const tracker = new BudgetTracker(options, {
        onWarning: (state) => warnings.push(state),
      });

      tracker.recordUsage('gpt-4', 1000, 500);
      tracker.recordUsage('gpt-3.5', 2000, 1000);

      const serialized = tracker.toJSON();
      const restored = BudgetTracker.fromJSON(serialized, options, {
        onWarning: (state) => warnings.push(state),
      });

      const originalState = tracker.budgetRemaining();
      const restoredState = restored.budgetRemaining();

      expect(restoredState.tokensUsed).toBe(originalState.tokensUsed);
      expect(restoredState.costUsed).toBeCloseTo(originalState.costUsed, 10);
      expect(restoredState.tokensRemaining).toBe(originalState.tokensRemaining);
      expect(restoredState.costRemaining).toBeCloseTo(originalState.costRemaining, 10);
      expect(restoredState.breakdown).toHaveLength(originalState.breakdown.length);
    });

    it('preserves warningFired state', () => {
      const options = createOptions({ maxTokens: 1000, maxCost: 100 });
      const warnings: BudgetState[] = [];
      const callbacks = { onWarning: (state: BudgetState) => warnings.push(state) };

      const tracker = new BudgetTracker(options, callbacks);
      tracker.recordUsage('gpt-4', 450, 450); // 900 = 90%, fires warning

      expect(warnings).toHaveLength(1);

      const serialized = tracker.toJSON();
      expect(serialized.warningFired).toBe(true);

      const restored = BudgetTracker.fromJSON(serialized, options, callbacks);
      // Further usage past threshold should NOT re-fire warning
      restored.recordUsage('gpt-4', 10, 10);

      expect(warnings).toHaveLength(1); // still just 1
    });
  });

  describe('clone', () => {
    it('preserves projections and isolates later mutations', () => {
      const tracker = new BudgetTracker(createOptions({ maxTokens: undefined, maxCost: 10 }));
      tracker.recordUsage('gpt-4', 1000, 500);
      tracker.recordUsage('gpt-4', 500, 250);

      const originalProjection = tracker.budgetProjection();
      const clone = tracker.clone();

      expect(clone.budgetRemaining()).toEqual(tracker.budgetRemaining());
      expect(clone.budgetProjection()).toEqual(originalProjection);

      clone.recordUsage('gpt-3.5', 2000, 1000);

      expect(tracker.budgetRemaining().tokensUsed).toBe(2250);
      expect(clone.budgetRemaining().tokensUsed).toBe(5250);
      expect(tracker.budgetRemaining().breakdown).toHaveLength(1);
      expect(clone.budgetRemaining().breakdown).toHaveLength(2);
    });
  });

  describe('checkBudget passes when budget available', () => {
    it('does not throw when under budget', () => {
      const tracker = new BudgetTracker(createOptions());

      tracker.recordUsage('gpt-4', 100, 50);

      expect(() => tracker.checkBudget()).not.toThrow();
    });
  });

  describe('checkBudget throws when exceeded', () => {
    it('throws BudgetExceededError with correct properties', () => {
      const tracker = new BudgetTracker(createOptions({ maxTokens: 500, maxCost: 100 }));

      tracker.recordUsage('gpt-4', 300, 300); // 600 > 500

      try {
        tracker.checkBudget();
        expect.unreachable('should have thrown');
      } catch (error) {
        expect(error).toBeInstanceOf(BudgetExceededError);
        const budgetError = error as BudgetExceededError;
        expect(budgetError.tokensUsed).toBe(600);
        expect(budgetError.maxTokens).toBe(500);
        expect(budgetError.maxCost).toBe(100);
      }
    });
  });

  describe('BudgetExceededError', () => {
    it('has correct name and properties', () => {
      const state: BudgetState = {
        tokensUsed: 600,
        costUsed: 0.12,
        tokensRemaining: -100,
        costRemaining: 9.88,
        breakdown: [],
      };

      const error = new BudgetExceededError(state, 500, 10);

      expect(error).toBeInstanceOf(Error);
      expect(error.name).toBe('BudgetExceededError');
      expect(error.tokensUsed).toBe(600);
      expect(error.costUsed).toBe(0.12);
      expect(error.maxTokens).toBe(500);
      expect(error.maxCost).toBe(10);
      expect(error.message).toContain('exceeded');
    });
  });

  describe('unlimited budgets', () => {
    it('works when maxTokens is not set', () => {
      const tracker = new BudgetTracker(
        createOptions({ maxTokens: undefined, maxCost: undefined }),
      );

      tracker.recordUsage('gpt-4', 1_000_000, 500_000);
      const state = tracker.budgetRemaining();

      expect(state.tokensRemaining).toBe(Infinity);
      expect(() => tracker.checkBudget()).not.toThrow();
    });

    it('works when maxCost is not set', () => {
      const tracker = new BudgetTracker(
        createOptions({ maxTokens: undefined, maxCost: undefined }),
      );

      tracker.recordUsage('gpt-4', 1_000_000, 500_000);
      const state = tracker.budgetRemaining();

      expect(state.costRemaining).toBe(Infinity);
      expect(() => tracker.checkBudget()).not.toThrow();
    });
  });
});
