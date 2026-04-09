/**
 * Confidence-weighted voting for multi-agent consensus.
 *
 * Groups worker results by exact content equality; each group's weight is the
 * sum of member confidence values (defaulting to 0.5 for undefined). The
 * highest-weight group wins. On a tie, `winner` is `null` and the caller
 * should fall through to a supervisor.
 *
 * @module confidence-voting
 */

import type { AgentResult } from './agent';

/** Default confidence assumed when a result has no `confidence` field. */
const DEFAULT_CONFIDENCE = 0.5;
const FLOATING_POINT_TIE_TOLERANCE = 1e-12;

export interface VotingResult {
  /** The winning content string, or `null` when there is a tie. */
  winner: string | null;
  /** Total accumulated weight for each unique content string. */
  weights: Map<string, number>;
}

function areWeightsEffectivelyEqual(left: number, right: number): boolean {
  const scale = Math.max(1, Math.abs(left), Math.abs(right));
  return Math.abs(left - right) <= scale * FLOATING_POINT_TIE_TOLERANCE;
}

function normalizeConfidence(confidence: number | undefined): number {
  if (confidence === undefined || !Number.isFinite(confidence)) {
    return DEFAULT_CONFIDENCE;
  }

  return Math.min(Math.max(confidence, 0), 1);
}

/**
 * Select a consensus answer by summing confidence weights per unique response.
 *
 * @param results - Worker results to aggregate.
 * @returns `winner` is the content string of the highest-weight group, or
 *   `null` on a tie. `weights` maps each unique content to its total weight.
 */
export function confidenceWeightedConsensus(results: AgentResult[]): VotingResult {
  const weights = new Map<string, number>();

  for (const result of results) {
    const weight = normalizeConfidence(result.confidence);
    weights.set(result.content, (weights.get(result.content) ?? 0) + weight);
  }

  let topContent: string | null = null;
  let topWeight = -Infinity;
  let tied = false;

  for (const [content, weight] of weights) {
    if (weight > topWeight) {
      topWeight = weight;
      topContent = content;
      tied = false;
    } else if (areWeightsEffectivelyEqual(weight, topWeight)) {
      tied = true;
    }
  }

  return {
    winner: tied ? null : topContent,
    weights,
  };
}
