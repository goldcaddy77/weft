import type { BudgetOptions, BudgetState } from '../../ai/budget.ts';
import { BudgetTracker } from '../../ai/budget.ts';
import type { ContextInternals } from './internals.ts';

export function setBudget(internals: ContextInternals, options: BudgetOptions): void {
  internals.budgetTracker = new BudgetTracker(options);
}

export function budgetRemaining(internals: ContextInternals): BudgetState | undefined {
  return internals.budgetTracker?.budgetRemaining();
}

export function budgetProjection(internals: ContextInternals):
  | {
      estimatedTurnsRemaining: number;
      estimatedCostAtCompletion: number;
    }
  | undefined {
  return internals.budgetTracker?.budgetProjection();
}
