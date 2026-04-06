import { describe, expect, it } from 'bun:test';

import type { Message } from '../providers/types.ts';
import { slidingWindowStrategy } from './sliding-window.ts';

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

const defaultOptions = {
  maxTokens: 1000,
  reservedForOutput: 250,
  currentTokenCount: 500,
};

describe('slidingWindowStrategy', () => {
  describe('preserves system prompt and drops oldest messages', () => {
    it('keeps system prompt and last 10 from 20 non-system messages', async () => {
      const messages = createMessages(20, { withSystem: true });
      const strategy = slidingWindowStrategy({ preserveRecentCount: 10 });

      const generator = strategy.compact(messages, defaultOptions);
      const result = await generator.next();
      const compacted = result.value;

      // System message + last 10 = 11 total
      expect(compacted).toHaveLength(11);
      expect(compacted[0]!.role).toBe('system');
      expect(compacted[0]!.content).toBe('You are a helpful assistant.');

      // Oldest 10 non-system messages dropped
      const droppedCount = messages.length - compacted.length;
      expect(droppedCount).toBe(10);

      // Preserved messages are the last 10 from the original
      const expectedRecent = messages.slice(-10);
      expect(compacted.slice(1)).toEqual(expectedRecent);
    });
  });

  describe('reports dropped message count', () => {
    it('drops correct number of messages', async () => {
      const messages = createMessages(20, { withSystem: true });
      const strategy = slidingWindowStrategy({ preserveRecentCount: 10 });

      const generator = strategy.compact(messages, defaultOptions);
      const result = await generator.next();
      const compacted = result.value;

      // 21 total (1 system + 20 non-system) -> 11 kept (1 system + 10 recent)
      // 10 messages dropped
      const dropped = messages.length - compacted.length;
      expect(dropped).toBe(10);
    });
  });

  describe('edge cases', () => {
    it('returns empty array for empty input', async () => {
      const strategy = slidingWindowStrategy({ preserveRecentCount: 10 });
      const generator = strategy.compact([], defaultOptions);
      const result = await generator.next();
      expect(result.value).toEqual([]);
    });

    it('returns all messages when count is under preserveRecentCount', async () => {
      const messages = createMessages(5, { withSystem: true });
      const strategy = slidingWindowStrategy({ preserveRecentCount: 10 });

      const generator = strategy.compact(messages, defaultOptions);
      const result = await generator.next();
      expect(result.value).toEqual(messages);
    });

    it('works without system message', async () => {
      const messages = createMessages(15);
      const strategy = slidingWindowStrategy({ preserveRecentCount: 5 });

      const generator = strategy.compact(messages, defaultOptions);
      const result = await generator.next();
      const compacted = result.value;

      expect(compacted).toHaveLength(5);
      expect(compacted).toEqual(messages.slice(-5));
    });

    it('can opt out of preserving system message', async () => {
      const messages = createMessages(10, { withSystem: true });
      const strategy = slidingWindowStrategy({
        preserveRecentCount: 3,
        preserveSystemMessage: false,
      });

      const generator = strategy.compact(messages, defaultOptions);
      const result = await generator.next();
      const compacted = result.value;

      // No system message preserved, just last 3 from all messages
      expect(compacted).toHaveLength(3);
      expect(compacted[0]!.role).not.toBe('system');
      expect(compacted).toEqual(messages.slice(-3));
    });

    it('uses defaults when no options provided', async () => {
      const messages = createMessages(20, { withSystem: true });
      const strategy = slidingWindowStrategy();

      const generator = strategy.compact(messages, defaultOptions);
      const result = await generator.next();
      const compacted = result.value;

      // Default: preserveSystemMessage=true, preserveRecentCount=10
      expect(compacted).toHaveLength(11);
      expect(compacted[0]!.role).toBe('system');
    });

    it('handles exactly preserveRecentCount non-system messages', async () => {
      const messages = createMessages(10, { withSystem: true });
      const strategy = slidingWindowStrategy({ preserveRecentCount: 10 });

      const generator = strategy.compact(messages, defaultOptions);
      const result = await generator.next();

      // 10 non-system messages <= preserveRecentCount, so all kept
      expect(result.value).toEqual(messages);
    });
  });
});
