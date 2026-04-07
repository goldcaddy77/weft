import { describe, expect, it } from 'bun:test';

import {
  MAX_MESSAGE_CHARS,
  MAX_SNAPSHOT_MESSAGES,
  MAX_TOOL_RESULT_CHARS,
  snapshotConversationForEvent,
} from './event-message-snapshot';
import type { Message } from './providers/types';

describe('snapshotConversationForEvent', () => {
  it('returns an empty array for an empty conversation', () => {
    expect(snapshotConversationForEvent([])).toEqual([]);
  });

  it('passes short messages through unchanged', () => {
    const conversation: Message[] = [
      { role: 'system', content: 'You are helpful.' },
      { role: 'user', content: 'Hi' },
      { role: 'assistant', content: 'Hello!' },
    ];
    const result = snapshotConversationForEvent(conversation);
    expect(result).toEqual(conversation);
    expect(result.length).toBe(3);
  });

  it('truncates oversized message content with a marker', () => {
    const longContent = 'a'.repeat(MAX_MESSAGE_CHARS + 500);
    const conversation: Message[] = [{ role: 'user', content: longContent }];
    const result = snapshotConversationForEvent(conversation);
    expect(result[0]?.content.length).toBe(MAX_MESSAGE_CHARS);
    expect(result[0]?.content.endsWith('chars]')).toBe(true);
    expect(result[0]?.content).toContain('[truncated 500 chars]');
  });

  it('truncates oversized tool result output strings', () => {
    const longOutput = 'b'.repeat(MAX_TOOL_RESULT_CHARS + 200);
    const conversation: Message[] = [
      {
        role: 'tool',
        content: '',
        toolResults: [{ toolCallId: 'call-1', output: longOutput }],
      },
    ];
    const result = snapshotConversationForEvent(conversation);
    const truncatedOutput = result[0]?.toolResults?.[0]?.output ?? '';
    expect(truncatedOutput.length).toBe(MAX_TOOL_RESULT_CHARS);
    expect(truncatedOutput).toContain('[truncated 200 chars]');
  });

  it('caps long conversations and preserves the first message', () => {
    const conversation: Message[] = [{ role: 'system', content: 'system prompt' }];
    for (let index = 0; index < MAX_SNAPSHOT_MESSAGES + 10; index += 1) {
      conversation.push({ role: 'user', content: `message ${index}` });
    }
    const result = snapshotConversationForEvent(conversation);
    expect(result.length).toBe(MAX_SNAPSHOT_MESSAGES);
    expect(result[0]).toEqual({ role: 'system', content: 'system prompt' });
    expect(result[1]?.role).toBe('system');
    expect(result[1]?.content).toContain('earlier messages truncated');
    // Tail should include the very last user message.
    expect(result[result.length - 1]?.content).toBe(`message ${MAX_SNAPSHOT_MESSAGES + 10 - 1}`);
  });

  it('is idempotent: snapshotting twice yields the same result', () => {
    const longContent = 'c'.repeat(MAX_MESSAGE_CHARS + 1000);
    const longOutput = 'd'.repeat(MAX_TOOL_RESULT_CHARS + 50);
    const conversation: Message[] = [
      { role: 'system', content: 'sys' },
      { role: 'user', content: longContent },
      {
        role: 'tool',
        content: '',
        toolResults: [{ toolCallId: 'tc-1', output: longOutput }],
      },
    ];
    const first = snapshotConversationForEvent(conversation);
    const second = snapshotConversationForEvent(first);
    expect(second).toEqual(first);
  });

  it('shallow-copies so caller mutation does not corrupt the snapshot', () => {
    const conversation: Message[] = [{ role: 'user', content: 'first' }];
    const snapshot = snapshotConversationForEvent(conversation);
    conversation.push({ role: 'assistant', content: 'second' });
    expect(snapshot.length).toBe(1);
  });
});
