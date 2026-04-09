import { describe, expect, it } from 'bun:test';

import type { AgentResult } from './agent';
import { confidenceWeightedConsensus } from './confidence-voting';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeResult(content: string, confidence?: number): AgentResult {
  return {
    content,
    conversation: [],
    totalTokens: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
    totalCost: 0,
    turnCount: 1,
    reasoningTraces: [],
    turnCosts: [],
    confidence,
  };
}

// ---------------------------------------------------------------------------
// confidenceWeightedConsensus
// ---------------------------------------------------------------------------

describe('confidenceWeightedConsensus', () => {
  it('returns the single result when there is only one', () => {
    const result = confidenceWeightedConsensus([makeResult('hello', 0.9)]);
    expect(result.winner).toBe('hello');
    expect(result.weights.get('hello')).toBeCloseTo(0.9);
  });

  it('picks the group with higher total weight', () => {
    const results = [
      makeResult('correct', 0.9),
      makeResult('correct', 0.9),
      makeResult('wrong', 0.8),
    ];
    const { winner, weights } = confidenceWeightedConsensus(results);
    expect(winner).toBe('correct');
    expect(weights.get('correct')).toBeCloseTo(1.8);
    expect(weights.get('wrong')).toBeCloseTo(0.8);
  });

  it('defaults undefined confidence to 0.5', () => {
    const results = [makeResult('a', undefined), makeResult('a', undefined), makeResult('b', 0.9)];
    // 'a' weight = 0.5 + 0.5 = 1.0; 'b' weight = 0.9
    const { winner, weights } = confidenceWeightedConsensus(results);
    expect(winner).toBe('a');
    expect(weights.get('a')).toBeCloseTo(1.0);
    expect(weights.get('b')).toBeCloseTo(0.9);
  });

  it('returns null winner on a perfect tie', () => {
    const results = [makeResult('a', 0.8), makeResult('b', 0.8)];
    const { winner } = confidenceWeightedConsensus(results);
    expect(winner).toBeNull();
  });

  it('returns null winner when multi-member groups tie', () => {
    const results = [
      makeResult('a', 0.5),
      makeResult('a', 0.5),
      makeResult('b', 0.5),
      makeResult('b', 0.5),
    ];
    const { winner } = confidenceWeightedConsensus(results);
    expect(winner).toBeNull();
  });

  it('treats floating-point-equivalent totals as a tie', () => {
    const results = [
      makeResult('a', 0.1),
      makeResult('a', 0.1),
      makeResult('a', 0.1),
      makeResult('b', 0.3),
    ];

    const { winner, weights } = confidenceWeightedConsensus(results);

    expect(weights.get('a')).toBeCloseTo(0.3);
    expect(weights.get('b')).toBeCloseTo(0.3);
    expect(winner).toBeNull();
  });

  it('includes all unique content strings in weights map', () => {
    const results = [makeResult('x', 0.3), makeResult('y', 0.6), makeResult('z', 0.1)];
    const { weights } = confidenceWeightedConsensus(results);
    expect(weights.size).toBe(3);
    expect(weights.has('x')).toBe(true);
    expect(weights.has('y')).toBe(true);
    expect(weights.has('z')).toBe(true);
  });

  it('handles an empty array gracefully', () => {
    const { winner, weights } = confidenceWeightedConsensus([]);
    expect(winner).toBeNull();
    expect(weights.size).toBe(0);
  });

  it('byzantine minority does not override honest majority', () => {
    // 4 honest (0.9) vs 1 byzantine (0.99 confidence but wrong answer)
    const results = [
      makeResult('correct', 0.9),
      makeResult('correct', 0.9),
      makeResult('correct', 0.9),
      makeResult('correct', 0.9),
      makeResult('wrong', 0.99),
    ];
    const { winner } = confidenceWeightedConsensus(results);
    expect(winner).toBe('correct');
  });
});
