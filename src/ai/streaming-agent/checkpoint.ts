import type { Message } from '../providers/types.ts';
import type { StreamCheckpoint } from './types.ts';

/**
 * Build a checkpoint from a partial agent conversation.
 * Identifies which turns completed (have both assistant and tool messages)
 * and which turn was incomplete at crash time.
 */
// oxlint-disable-next-line complexity -- ID:ai-streaming-agent-build-stream-checkpoint-complexity
export function buildStreamCheckpoint(conversation: Message[]): StreamCheckpoint {
  const checkpoint: StreamCheckpoint = {
    completedTurns: [],
    completedContent: [],
    incompleteTurn: undefined,
  };

  let turnIndex = 0;
  let i = 0;

  // Skip system message
  if (conversation.length > 0 && conversation[0]!.role === 'system') {
    i = 1;
  }

  // Skip initial user message
  if (i < conversation.length && conversation[i]!.role === 'user') {
    i++;
  }

  while (i < conversation.length) {
    const message = conversation[i]!;

    if (message.role === 'assistant') {
      // Check if there's a following tool message (meaning this turn completed)
      const hasToolCalls = message.toolCalls && message.toolCalls.length > 0;

      if (hasToolCalls) {
        // Look for the corresponding tool result
        const nextMessage = i + 1 < conversation.length ? conversation[i + 1] : undefined;
        if (nextMessage?.role === 'tool') {
          // Complete turn with tool calls
          checkpoint.completedTurns.push(turnIndex);
          checkpoint.completedContent.push(message.content);
          i += 2; // Skip past the tool result
          turnIndex++;
          continue;
        }
        // Incomplete turn — assistant sent tool calls but no result came back
        checkpoint.incompleteTurn = turnIndex;
        break;
      }

      // Assistant message without tool calls = final answer turn
      // If it's the last message, it was the final complete turn
      if (i === conversation.length - 1) {
        checkpoint.completedTurns.push(turnIndex);
        checkpoint.completedContent.push(message.content);
      } else {
        checkpoint.incompleteTurn = turnIndex;
      }
      break;
    }

    i++;
    turnIndex++;
  }

  // If we exited the loop without finding an incomplete turn and the last
  // assistant message had no tool calls, the conversation might have been
  // interrupted between turns
  if (
    checkpoint.incompleteTurn === undefined &&
    conversation.length > 0 &&
    conversation[conversation.length - 1]!.role === 'assistant' &&
    !conversation[conversation.length - 1]!.toolCalls?.length
  ) {
    // Last message was a final answer — already captured above
  }

  return checkpoint;
}

/**
 * Build recovery messages from a checkpoint. Returns the conversation
 * prefix that should be sent to the LLM to resume from the incomplete turn.
 */
// oxlint-disable-next-line complexity -- ID:ai-streaming-agent-build-recovery-conversation-complexity
export function buildRecoveryConversation(
  originalConversation: Message[],
  checkpoint: StreamCheckpoint,
): Message[] {
  const recovery: Message[] = [];

  // Copy system and user messages
  for (const message of originalConversation) {
    if (message.role === 'system' || message.role === 'user') {
      recovery.push(message);
    } else {
      break;
    }
  }

  // Add completed turns
  let i = recovery.length;
  let completedCount = 0;

  while (i < originalConversation.length && completedCount < checkpoint.completedTurns.length) {
    const message = originalConversation[i]!;
    recovery.push(message);

    if (message.role === 'assistant') {
      if (message.toolCalls && message.toolCalls.length > 0) {
        // Include the tool result too
        const nextMessage = originalConversation[i + 1];
        if (nextMessage?.role === 'tool') {
          recovery.push(nextMessage);
          i += 2;
          completedCount++;
          continue;
        }
      } else {
        completedCount++;
      }
    }

    i++;
  }

  // The incomplete turn is discarded — the LLM will re-issue it
  return recovery;
}

// ---------------------------------------------------------------------------
// SSE formatting
// ---------------------------------------------------------------------------
