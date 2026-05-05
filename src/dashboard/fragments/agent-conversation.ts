import type { Message } from '../../ai/agent/index.ts';
import type { AgentTurnData } from './agent-turn-types.ts';

/** A slice of the conversation attributed to a single agent turn. */
export type ConversationGroup = {
  turnIndex: number;
  messages: Message[];
};

/**
 * Returns true when `snapshotConversationForEvent` has applied the windowing
 * truncation — i.e. the snapshot has replaced middle messages with a synthetic
 * "[N earlier messages truncated]" marker at index 1. When this happens the
 * per-message indices stored on intermediate turns no longer align with the
 * latest snapshot, so delta slicing is unreliable.
 */
function isWindowedSnapshot(snapshot: readonly Message[]): boolean {
  if (snapshot.length < 2) return false;
  const second = snapshot[1];
  return (
    second !== undefined &&
    second.role === 'system' &&
    typeof second.content === 'string' &&
    second.content.includes('earlier messages truncated')
  );
}

/**
 * Group a conversation into per-turn slices.
 *
 * The `messages` field on each `AgentTurnData` is a **cumulative** snapshot —
 * the last turn carries the full conversation, the previous turn carries the
 * conversation up to its own completion, and so on. We segment by turn
 * boundary using message-count deltas so each group contains only the new
 * messages added during that turn (no duplicated prefixes).
 *
 * Falls back to rendering each turn's messages directly if:
 * - The final turn has an empty snapshot (legacy events without the `messages` field).
 * - The final snapshot has been windowed by `snapshotConversationForEvent`
 *   (conversation exceeded MAX_SNAPSHOT_MESSAGES). In that case the synthetic
 *   truncation marker at index 1 invalidates index-based slicing for earlier turns.
 */
export function groupConversationMessages(turns: readonly AgentTurnData[]): ConversationGroup[] {
  if (turns.length === 0) {
    return [];
  }

  const lastTurn = turns[turns.length - 1];
  const latestSnapshot = lastTurn?.messages ?? [];

  if (latestSnapshot.length === 0 || isWindowedSnapshot(latestSnapshot)) {
    // Legacy event with no snapshot, or windowed snapshot that breaks index
    // alignment — fall back to whatever each turn carries directly.
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
