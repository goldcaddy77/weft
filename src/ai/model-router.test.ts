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

describe('costTierRouter edge cases', () => {
  it('falls back to the first tier when no tier matches budget thresholds', () => {
    // All tiers have cost thresholds that are above the budget
    const tiers: CostTier[] = [
      { model: 'expensive', maxCostRemaining: 100 },
      { model: 'medium', maxCostRemaining: 50 },
    ];

    const router = costTierRouter(tiers);
    const selection = router.select(
      createContext({
        budgetRemaining: { tokensRemaining: 0, costRemaining: 0 },
      }),
    );

    // Both tiers require more cost than 0, so we hit the fallback on line 142
    expect(selection.model).toBe('expensive');
  });
});

describe('abTestRouter edge cases', () => {
  it('falls back to the last variant when no variant is selected due to floating-point rounding', () => {
    // Weights that don't quite sum to 1.0 due to floating-point representation
    const variants: WeightedVariant[] = [
      { model: 'model-a', weight: 0.1 },
      { model: 'model-b', weight: 0.1 },
      { model: 'model-c', weight: 0.1, fallback: ['model-a'] },
    ];
    // Weights sum to 0.3, so most hashes will exceed cumulative and hit the fallback
    const router = abTestRouter(variants);

    // Use a workflow ID that will produce a hash > 0.3
    // We need to try many IDs to ensure we hit the fallback path
    let hitFallback = false;
    for (let i = 0; i < 100; i++) {
      const selection = router.select(createContext({ workflowId: `wf-test-fallback-${i}` }));
      if (selection.model === 'model-c' && selection.fallback?.includes('model-a')) {
        hitFallback = true;
        break;
      }
    }

    // Since weights sum to 0.3, ~70% of hashes should fall through to the last variant
    expect(hitFallback).toBe(true);
  });

  it('returns the last variant for a hash that exceeds all cumulative weights', () => {
    // Use weights that sum to less than 1 so most hashes fall through
    const variants: WeightedVariant[] = [
      { model: 'rare', weight: 0.01 },
      { model: 'fallback-variant', weight: 0.01, fallback: ['backup'] },
    ];

    const router = abTestRouter(variants);

    // Try enough workflow IDs to find one that falls through all variants
    let foundFallback = false;
    for (let i = 0; i < 200; i++) {
      const selection = router.select(createContext({ workflowId: `find-fallback-${i}` }));
      if (selection.model === 'fallback-variant') {
        foundFallback = true;
        expect(selection.fallback).toEqual(['backup']);
        break;
      }
    }

    expect(foundFallback).toBe(true);
  });
});
