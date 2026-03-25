import { describe, expect, it } from 'bun:test';

import {
  abTestRouter,
  costTierRouter,
  customRouter,
  staticFallbackRouter,
  type CostTier,
  type RoutingContext,
  type WeightedVariant,
} from './model-router.ts';

function createContext(overrides?: Partial<RoutingContext>): RoutingContext {
  return {
    workflowId: 'workflow-123',
    turnIndex: 0,
    conversationLength: 1,
    previousModels: [],
    ...overrides,
  };
}

describe('staticFallbackRouter', () => {
  it('returns the primary model', () => {
    const router = staticFallbackRouter('gpt-4', ['gpt-3.5', 'gpt-4-mini']);
    const selection = router.select(createContext());

    expect(selection.model).toBe('gpt-4');
  });

  it('includes the fallback chain', () => {
    const router = staticFallbackRouter('gpt-4', ['gpt-3.5', 'gpt-4-mini']);
    const selection = router.select(createContext());

    expect(selection.fallback).toEqual(['gpt-3.5', 'gpt-4-mini']);
  });
});

describe('costTierRouter', () => {
  const tiers: CostTier[] = [
    { model: 'gpt-4', maxCostRemaining: 5, fallback: ['gpt-3.5'] },
    { model: 'gpt-3.5', maxCostRemaining: 1, fallback: ['gpt-4-mini'] },
    { model: 'gpt-4-mini' },
  ];

  it('returns expensive model when budget is high', () => {
    const router = costTierRouter(tiers);
    const selection = router.select(
      createContext({
        budgetRemaining: { tokensRemaining: 100_000, costRemaining: 10 },
      }),
    );

    expect(selection.model).toBe('gpt-4');
    expect(selection.fallback).toEqual(['gpt-3.5']);
  });

  it('switches to cheap model when budget is low', () => {
    const router = costTierRouter(tiers);
    const selection = router.select(
      createContext({
        budgetRemaining: { tokensRemaining: 100_000, costRemaining: 0.5 },
      }),
    );

    expect(selection.model).toBe('gpt-4-mini');
  });

  it('returns the first tier when no budget info is provided', () => {
    const router = costTierRouter(tiers);
    const selection = router.select(createContext());

    expect(selection.model).toBe('gpt-4');
    expect(selection.fallback).toEqual(['gpt-3.5']);
  });

  it('picks the correct tier among multiple tiers', () => {
    const router = costTierRouter(tiers);
    const selection = router.select(
      createContext({
        budgetRemaining: { tokensRemaining: 100_000, costRemaining: 3 },
      }),
    );

    expect(selection.model).toBe('gpt-3.5');
    expect(selection.fallback).toEqual(['gpt-4-mini']);
  });

  it('handles token-based thresholds', () => {
    const tokenTiers: CostTier[] = [
      { model: 'gpt-4', maxTokensRemaining: 50_000 },
      { model: 'gpt-3.5', maxTokensRemaining: 10_000 },
      { model: 'gpt-4-mini' },
    ];

    const router = costTierRouter(tokenTiers);
    const selection = router.select(
      createContext({
        budgetRemaining: { tokensRemaining: 5_000, costRemaining: 100 },
      }),
    );

    expect(selection.model).toBe('gpt-4-mini');
  });
});

describe('abTestRouter', () => {
  const variants: WeightedVariant[] = [
    { model: 'gpt-4', weight: 0.5, fallback: ['gpt-3.5'] },
    { model: 'gpt-3.5', weight: 0.3 },
    { model: 'gpt-4-mini', weight: 0.2 },
  ];

  it('is deterministic for the same workflowId', () => {
    const router = abTestRouter(variants);

    const first = router.select(createContext({ workflowId: 'stable-id-42' }));
    const second = router.select(createContext({ workflowId: 'stable-id-42' }));

    expect(first.model).toBe(second.model);
    expect(first.fallback).toEqual(second.fallback);
  });

  it('distributes roughly according to weights across many workflow IDs', () => {
    const router = abTestRouter(variants);
    const counts: Record<string, number> = { 'gpt-4': 0, 'gpt-3.5': 0, 'gpt-4-mini': 0 };
    const total = 1000;

    for (let i = 0; i < total; i++) {
      const selection = router.select(createContext({ workflowId: `workflow-${String(i)}` }));
      counts[selection.model] = (counts[selection.model] ?? 0) + 1;
    }

    // Allow generous tolerance for statistical distribution
    // gpt-4: 50% -> expect 350-650
    expect(counts['gpt-4']).toBeGreaterThan(300);
    expect(counts['gpt-4']).toBeLessThan(700);

    // gpt-3.5: 30% -> expect 150-450
    expect(counts['gpt-3.5']).toBeGreaterThan(150);
    expect(counts['gpt-3.5']).toBeLessThan(450);

    // gpt-4-mini: 20% -> expect 50-350
    expect(counts['gpt-4-mini']).toBeGreaterThan(50);
    expect(counts['gpt-4-mini']).toBeLessThan(350);
  });

  it('includes the fallback from the selected variant', () => {
    const router = abTestRouter([{ model: 'gpt-4', weight: 1.0, fallback: ['gpt-3.5'] }]);
    const selection = router.select(createContext());

    expect(selection.model).toBe('gpt-4');
    expect(selection.fallback).toEqual(['gpt-3.5']);
  });
});

describe('customRouter', () => {
  it('calls the provided function', () => {
    const router = customRouter(() => ({ model: 'my-custom-model' }));
    const selection = router.select(createContext());

    expect(selection.model).toBe('my-custom-model');
  });

  it('passes context correctly to the function', () => {
    let capturedContext: RoutingContext | undefined;

    const router = customRouter((context) => {
      capturedContext = context;
      return { model: 'gpt-4' };
    });

    const context = createContext({
      workflowId: 'wf-abc',
      turnIndex: 5,
      conversationLength: 10,
      budgetRemaining: { tokensRemaining: 5000, costRemaining: 2.5 },
      previousModels: ['gpt-4', 'gpt-3.5'],
      metadata: { region: 'us-east' },
    });

    router.select(context);

    expect(capturedContext).toBeDefined();
    expect(capturedContext!.workflowId).toBe('wf-abc');
    expect(capturedContext!.turnIndex).toBe(5);
    expect(capturedContext!.conversationLength).toBe(10);
    expect(capturedContext!.budgetRemaining).toEqual({
      tokensRemaining: 5000,
      costRemaining: 2.5,
    });
    expect(capturedContext!.previousModels).toEqual(['gpt-4', 'gpt-3.5']);
    expect(capturedContext!.metadata).toEqual({ region: 'us-east' });
  });

  it('returns fallback and reason from the custom function', () => {
    const router = customRouter(() => ({
      model: 'gpt-4',
      fallback: ['gpt-3.5'],
      reason: 'User is premium',
    }));

    const selection = router.select(createContext());

    expect(selection.fallback).toEqual(['gpt-3.5']);
    expect(selection.reason).toBe('User is premium');
  });
});
