import type { AgentTurnData } from './agent-turn-types.ts';

export type TurnUsageEntry = {
  turnNumber: number;
  inputTokens: number | null;
  outputTokens: number | null;
  source: 'provider' | 'unavailable';
};

/**
 * A single row in the per-turn usage table.
 *
 * Tokens are `null` when the provider did not report usage for that turn
 * (`source === 'unavailable'`). The `unavailable` flag drives the "unavailable"
 * badge in the rendered table row.
 */
export type TurnUsageRow = {
  turnNumber: number;
  inputTokens: number | null;
  outputTokens: number | null;
  unavailable: boolean;
};

/**
 * Build turn-usage rows from a list of `TurnUsageEntry` values.
 *
 * Each entry maps 1-to-1 to a `TurnUsageRow`. Entries with
 * `source === 'unavailable'` produce `null` token columns and set the
 * `unavailable` flag so the UI can render an "unavailable" badge.
 */
export function buildTurnUsageRows(entries: readonly TurnUsageEntry[]): TurnUsageRow[] {
  return entries.map((entry) => ({
    turnNumber: entry.turnNumber,
    inputTokens: entry.inputTokens,
    outputTokens: entry.outputTokens,
    unavailable: entry.source === 'unavailable',
  }));
}

/**
 * Build turn-usage rows from a list of `AgentTurnData` values.
 *
 * Used when rendering from per-turn event data rather than from
 * `AgentResult.turnUsage`. Maps `turnIndex` to `turnNumber` and uses
 * token counts directly; marks a turn as unavailable when both
 * `inputTokens` and `outputTokens` are zero (legacy fallback — zero
 * tokens from event data is indistinguishable from unreported usage).
 */
export function buildTurnUsageRowsFromTurnData(turns: readonly AgentTurnData[]): TurnUsageRow[] {
  return turns.map((turn) => ({
    turnNumber: turn.turnIndex,
    inputTokens: turn.inputTokens,
    outputTokens: turn.outputTokens,
    unavailable: turn.inputTokens === 0 && turn.outputTokens === 0,
  }));
}
