import type { Message, ToolResult } from './types.ts';

/**
 * Maximum characters retained for a single string `ToolResult.content` value.
 * Output beyond this is replaced with a `[truncated N chars]` marker so that
 * long-running agents cannot push multi-megabyte tool outputs through the
 * dashboard event stream.
 */
export const MAX_TOOL_RESULT_CHARS = 4096;

/**
 * Maximum characters retained for a single `Message.content` string. Matches
 * the truncation marker format used by {@link MAX_TOOL_RESULT_CHARS}.
 */
export const MAX_MESSAGE_CHARS = 8192;

/**
 * Maximum number of messages retained per conversation snapshot. When the
 * cumulative conversation exceeds this cap the helper keeps the first message
 * (typically the system prompt) plus the most recent `N - 1` messages and
 * prepends a synthetic `system` marker noting how many messages were dropped.
 */
export const MAX_SNAPSHOT_MESSAGES = 200;

function truncateString(value: string, cap: number): string {
  if (value.length <= cap) {
    return value;
  }
  // Use an iterative approach: estimate keepLength, build the marker, then
  // recompute. One iteration is sufficient because the marker digit count only
  // changes when the dropped count crosses a power-of-ten boundary, which
  // cannot happen after the first correction (the marker gets shorter, not
  // longer, as kept content shrinks).
  //
  // Computing dropped as `value.length - cap` would undercount by
  // `marker.length` characters — the marker itself occupies space that
  // displaces original content. We need `dropped = value.length - keepLength`.
  let marker = ` [truncated ${value.length - cap} chars]`; // initial estimate
  let keepLength = Math.max(0, cap - marker.length);
  const dropped = value.length - keepLength;
  marker = ` [truncated ${dropped} chars]`;
  keepLength = Math.max(0, cap - marker.length);
  // Keep the total output at exactly `cap` characters so that a second pass
  // over the same string is a no-op (idempotency requirement).
  return `${value.slice(0, keepLength)}${marker}`;
}

function snapshotToolResult(result: ToolResult): ToolResult {
  if (typeof result.content !== 'string' || result.content.length <= MAX_TOOL_RESULT_CHARS) {
    return result;
  }
  return {
    ...result,
    content: truncateString(result.content, MAX_TOOL_RESULT_CHARS),
  };
}

function snapshotMessage(message: Message): Message {
  const nextContent = truncateString(message.content, MAX_MESSAGE_CHARS);
  const nextToolResults = message.toolResults?.map(snapshotToolResult);

  const contentChanged = nextContent !== message.content;
  const toolResultsChanged =
    nextToolResults !== undefined &&
    message.toolResults !== undefined &&
    nextToolResults.some((result, index) => result !== message.toolResults?.[index]);

  if (!contentChanged && !toolResultsChanged) {
    return message;
  }

  return {
    ...message,
    content: nextContent,
    ...(nextToolResults !== undefined ? { toolResults: nextToolResults } : {}),
  };
}

/**
 * Build a size-bounded snapshot of a conversation for embedding into an
 * `AgentTurnCompletedEvent`. The helper:
 *
 * 1. Shallow-copies the input so later mutation of the source array cannot
 *    corrupt the captured snapshot.
 * 2. Truncates individual `Message.content` strings past {@link MAX_MESSAGE_CHARS}
 *    and individual string `ToolResult.content` values past {@link MAX_TOOL_RESULT_CHARS},
 *    marking each truncation with a `[truncated N chars]` suffix.
 * 3. If the conversation exceeds {@link MAX_SNAPSHOT_MESSAGES}, keeps the first
 *    message plus the last `N - 1` messages and prepends a synthetic system
 *    message noting how many earlier messages were dropped.
 *
 * The result is idempotent: applying the helper twice yields a structurally
 * equivalent snapshot (modulo object identity on already-bounded messages).
 */
export function snapshotConversationForEvent(conversation: readonly Message[]): Message[] {
  const sliced = conversation.slice();

  let windowed: Message[];
  if (sliced.length > MAX_SNAPSHOT_MESSAGES) {
    // Reserve slot 0 for the original first message and slot 1 for the
    // truncation marker; fill the remaining `MAX_SNAPSHOT_MESSAGES - 2`
    // slots with the most recent tail messages.
    const first = sliced[0];
    const tailCount = MAX_SNAPSHOT_MESSAGES - 2;
    const tail = sliced.slice(sliced.length - tailCount);
    const droppedCount = sliced.length - 1 - tail.length;
    const marker: Message = {
      role: 'system',
      content: `[${droppedCount} earlier messages truncated]`,
    };
    windowed = first !== undefined ? [first, marker, ...tail] : [marker, ...tail];
  } else {
    windowed = sliced;
  }

  return windowed.map(snapshotMessage);
}
