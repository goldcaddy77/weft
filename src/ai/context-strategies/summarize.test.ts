import { describe, expect, it } from 'bun:test';

import type { Message } from '../providers/types.ts';
import type { SummarizeProvider } from './summarize.ts';
import { createSummarizeStrategy } from './summarize.ts';

function createMessage(role: Message['role'], content: string): Message {
  return { role, content };
}

function createMessages(count: number, options?: { withSystem?: boolean }): Message[] {
  const messages: Message[] = [];
  if (options?.withSystem) {
    messages.push(createMessage('system', 'You are a helpful assistant.'));
  }
  for (let i = 0; i < count; i++) {
    messages.push(createMessage(i % 2 === 0 ? 'user' : 'assistant', `Message ${i}`));
  }
  return messages;
}

function createMockProvider(summaryText: string): SummarizeProvider {
  return {
    summarize: async (_messages: Message[]) => summaryText,
  };
}

const defaultOptions = {
  maxTokens: 1000,
  reservedForOutput: 250,
  currentTokenCount: 500,
};

describe('createSummarizeStrategy', () => {
  it('compresses old messages into a single summary message', async () => {
    const provider = createMockProvider('Summary of the conversation so far.');
    const strategy = createSummarizeStrategy({ provider, keepRecent: 3 });

    const messages = createMessages(10, { withSystem: true });
    const generator = strategy.compact(messages, defaultOptions);
    const result = await generator.next();
    const compacted = result.value;

    // System prompt + summary message + last 3 non-system messages = 5
    expect(compacted).toHaveLength(5);
    expect(compacted[0]!.role).toBe('system');
    expect(compacted[1]!.role).toBe('assistant');
    expect(compacted[1]!.content).toBe('Summary of the conversation so far.');
  });

  it('preserves the system prompt', async () => {
    const provider = createMockProvider('Summary.');
    const strategy = createSummarizeStrategy({ provider, keepRecent: 2 });

    const messages = createMessages(8, { withSystem: true });
    const generator = strategy.compact(messages, defaultOptions);
    const result = await generator.next();
    const compacted = result.value;

    expect(compacted[0]!.role).toBe('system');
    expect(compacted[0]!.content).toBe('You are a helpful assistant.');
  });

  it('preserves recent messages', async () => {
    const provider = createMockProvider('Summary.');
    const strategy = createSummarizeStrategy({ provider, keepRecent: 4 });

    const messages = createMessages(10, { withSystem: true });
    const generator = strategy.compact(messages, defaultOptions);
    const result = await generator.next();
    const compacted = result.value;

    // Last 4 non-system messages should be preserved exactly
    const expectedRecent = messages.slice(-4);
    expect(compacted.slice(-4)).toEqual(expectedRecent);
  });

  it('calls provider.summarize with the old messages to compress', async () => {
    let receivedMessages: Message[] = [];
    const provider: SummarizeProvider = {
      summarize: async (messages: Message[]) => {
        receivedMessages = messages;
        return 'Summary.';
      },
    };

    const strategy = createSummarizeStrategy({ provider, keepRecent: 3 });
    const messages = createMessages(10, { withSystem: true });

    // Non-system messages: indices 1-10 (10 messages)
    // Old messages to summarize: indices 1-7 (first 7 non-system messages)
    const generator = strategy.compact(messages, defaultOptions);
    await generator.next();

    // The provider should receive the 7 old non-system messages
    expect(receivedMessages).toHaveLength(7);
    expect(receivedMessages[0]!.content).toBe('Message 0');
    expect(receivedMessages[6]!.content).toBe('Message 6');
  });

  it('returns all messages when count is under keepRecent', async () => {
    let summarizeCalled = false;
    const provider: SummarizeProvider = {
      summarize: async () => {
        summarizeCalled = true;
        return 'Summary.';
      },
    };

    const strategy = createSummarizeStrategy({ provider, keepRecent: 20 });
    const messages = createMessages(5, { withSystem: true });

    const generator = strategy.compact(messages, defaultOptions);
    const result = await generator.next();

    // Not enough messages to summarize, return as-is
    expect(result.value).toEqual(messages);
    expect(summarizeCalled).toBe(false);
  });

  it('works without a system prompt', async () => {
    const provider = createMockProvider('Summary of conversation.');
    const strategy = createSummarizeStrategy({ provider, keepRecent: 2 });

    const messages = createMessages(8); // no system message
    const generator = strategy.compact(messages, defaultOptions);
    const result = await generator.next();
    const compacted = result.value;

    // Summary message + last 2 = 3
    expect(compacted).toHaveLength(3);
    expect(compacted[0]!.role).toBe('assistant');
    expect(compacted[0]!.content).toBe('Summary of conversation.');
    expect(compacted.slice(-2)).toEqual(messages.slice(-2));
  });

  it('handles empty messages', async () => {
    const provider = createMockProvider('Summary.');
    const strategy = createSummarizeStrategy({ provider, keepRecent: 5 });

    const generator = strategy.compact([], defaultOptions);
    const result = await generator.next();
    expect(result.value).toEqual([]);
  });
});
