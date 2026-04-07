import type { AgentTurnData } from './agent-turn-types.ts';

/** A single bar in the per-turn cost waterfall chart. */
export type WaterfallBar = {
  turnIndex: number;
  model: string;
  cost: number;
  /** Bar width as a percentage (0..100), normalized against the maximum turn cost. */
  widthPercentage: number;
  /** Accessible label, e.g. `Turn 3, model claude-sonnet-4, $0.0142`. */
  ariaLabel: string;
};

/**
 * Build a normalized waterfall view of agent turn costs. Bars are sized
 * relative to the most expensive turn in the input. An empty input returns
 * an empty array; a max-cost of zero produces all-zero widths so the chart
 * still renders without divide-by-zero artefacts.
 */
export function computeWaterfallBars(turns: readonly AgentTurnData[]): WaterfallBar[] {
  if (turns.length === 0) {
    return [];
  }

  const maxCost = turns.reduce((accumulator, turn) => Math.max(accumulator, turn.cost), 0);

  return turns.map((turn) => {
    const widthPercentage = maxCost > 0 ? (turn.cost / maxCost) * 100 : 0;
    return {
      turnIndex: turn.turnIndex,
      model: turn.model,
      cost: turn.cost,
      widthPercentage,
      ariaLabel: `Turn ${turn.turnIndex + 1}, model ${turn.model}, $${turn.cost.toFixed(4)}`,
    };
  });
}
