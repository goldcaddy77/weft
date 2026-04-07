import { describe, expect, it } from 'bun:test';

import { computeWaterfallBars } from './agent-cost-waterfall';
import type { AgentTurnData } from './agent-turn-types.ts';

function makeTurn(turnIndex: number, model: string, cost: number): AgentTurnData {
  return {
    turnIndex,
    model,
    inputTokens: 0,
    outputTokens: 0,
    cost,
    toolCalls: [],
    response: '',
    messages: [],
    reasoningTrace: '',
  };
}

describe('computeWaterfallBars', () => {
  it('returns an empty array for no turns', () => {
    expect(computeWaterfallBars([])).toEqual([]);
  });

  it('renders a single turn at 100 percent', () => {
    const bars = computeWaterfallBars([makeTurn(0, 'claude', 0.05)]);
    expect(bars.length).toBe(1);
    expect(bars[0]?.widthPercentage).toBe(100);
    expect(bars[0]?.cost).toBe(0.05);
  });

  it('normalizes multiple turns relative to the maximum cost', () => {
    const bars = computeWaterfallBars([
      makeTurn(0, 'claude', 0.02),
      makeTurn(1, 'claude', 0.04),
      makeTurn(2, 'claude', 0.01),
    ]);
    expect(bars[0]?.widthPercentage).toBeCloseTo(50);
    expect(bars[1]?.widthPercentage).toBeCloseTo(100);
    expect(bars[2]?.widthPercentage).toBeCloseTo(25);
  });

  it('emits zero widths when every turn cost is zero', () => {
    const bars = computeWaterfallBars([makeTurn(0, 'a', 0), makeTurn(1, 'b', 0)]);
    expect(bars.every((bar) => bar.widthPercentage === 0)).toBe(true);
  });

  it('formats the aria label with turn number, model, and four-decimal cost', () => {
    const bars = computeWaterfallBars([makeTurn(2, 'claude-sonnet-4', 0.0142)]);
    expect(bars[0]?.ariaLabel).toBe('Turn 3, model claude-sonnet-4, $0.0142');
  });
});
