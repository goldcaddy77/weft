import type { Message } from '../agent/types.ts';

/** Summarize a conversation to a single string (for context forwarding). */
export function summarizeConversation(messages: Message[]): string {
  if (messages.length === 0) return '';

  const lines: string[] = [];
  for (const message of messages) {
    if (message.role === 'system') continue;
    lines.push(`${message.role}: ${message.content}`);
  }
  return `Conversation summary:\n${lines.join('\n')}`;
}

// ---------------------------------------------------------------------------
// handoff
// ---------------------------------------------------------------------------
