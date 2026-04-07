import type { Message } from '../../ai/providers/types.ts';
import type { AgentTurnData } from './agent-turn-types.ts';

/** A slice of the conversation attributed to a single agent turn. */
export type ConversationGroup = {
  turnIndex: number;
  messages: Message[];
};

/**
 * Group a conversation into per-turn slices.
 *
 * The `messages` field on each `AgentTurnData` is a **cumulative** snapshot —
 * the last turn carries the full conversation, the previous turn carries the
 * conversation up to its own completion, and so on. We segment by turn
 * boundary using message-count deltas so each group contains only the new
 * messages added during that turn (no duplicated prefixes).
 *
 * Falls back to rendering each turn's messages directly if the final turn
 * has an empty snapshot (legacy events without the `messages` field).
 */
export function groupConversationMessages(turns: readonly AgentTurnData[]): ConversationGroup[] {
  if (turns.length === 0) {
    return [];
  }

  const lastTurn = turns[turns.length - 1];
  const latestSnapshot = lastTurn?.messages ?? [];

  if (latestSnapshot.length === 0) {
    // Legacy event with no snapshot — fall back to whatever each turn carries.
    return turns.map((turn) => ({
      turnIndex: turn.turnIndex,
      messages: [...turn.messages],
    }));
  }

  const groups: ConversationGroup[] = [];
  let previousCount = 0;
  for (const turn of turns) {
    const snapshotLength = turn.messages.length;
    if (snapshotLength === 0) {
      // Missing intermediate snapshot: record an empty group so the turn still
      // appears in the UI without silently shifting later deltas.
      groups.push({ turnIndex: turn.turnIndex, messages: [] });
      continue;
    }
    const startIndex = Math.min(previousCount, latestSnapshot.length);
    const endIndex = Math.min(snapshotLength, latestSnapshot.length);
    const slice =
      endIndex > startIndex
        ? latestSnapshot.slice(startIndex, endIndex)
        : turn.messages.slice(Math.min(previousCount, snapshotLength));
    groups.push({ turnIndex: turn.turnIndex, messages: slice });
    previousCount = snapshotLength;
  }

  return groups;
}
