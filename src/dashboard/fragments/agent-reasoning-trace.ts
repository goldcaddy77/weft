import type { AgentTurnData } from './agent-turn-types.ts';

/** A single reasoning/thinking trace entry, keyed by turn. */
export type ReasoningEntry = {
  turnIndex: number;
  model: string;
  trace: string;
};

/**
 * Collect reasoning traces from the given turns, filtering out empty and
 * whitespace-only traces. The `reasoningTrace` field is a pre-concatenated
 * string emitted by the provider adapters; we do not attempt to parse it
 * into structured thinking blocks.
 */
export function buildReasoningEntries(turns: readonly AgentTurnData[]): ReasoningEntry[] {
  const entries: ReasoningEntry[] = [];
  for (const turn of turns) {
    const trace = turn.reasoningTrace;
    if (trace.trim().length === 0) {
      continue;
    }
    entries.push({
      turnIndex: turn.turnIndex,
      model: turn.model,
      trace,
    });
  }
  return entries;
}
