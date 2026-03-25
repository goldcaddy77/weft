import { describe, expect, it } from 'bun:test';

import { slidingWindowStrategy } from './context-strategies/sliding-window.ts';
import { ContextWindowManager, composeStrategies, noopStrategy } from './context-window.ts';
import type { Message } from './providers/types.ts';

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

/** A deterministic token counter: each message costs exactly content.length / 4. */
async function countTokens(messages: Message[]): Promise<number> {
  return messages.reduce((sum, message) => sum + Math.ceil(message.content.length / 4), 0);
}

describe('ContextWindowManager', () => {
  describe('shouldCompact returns true when over threshold', () => {
    it('returns true when token count exceeds compactAt threshold', () => {
      const manager = new ContextWindowManager({
        maxTokens: 1000,
        compactAt: 0.85,
        countTokens,
      });

      // 85% of available input budget triggers compaction
      // inputBudget = 1000 - 250 (25% reserved) = 750
      // 85% of 750 = 637.5
      expect(manager.shouldCompact(638)).toBe(true);
    });
  });

  describe('shouldCompact returns false when under threshold', () => {
    it('returns false when token count is below compactAt threshold', () => {
      const manager = new ContextWindowManager({
        maxTokens: 1000,
        compactAt: 0.85,
        countTokens,
      });

      // inputBudget = 750, 85% = 637.5
      expect(manager.shouldCompact(637)).toBe(false);
    });
  });

  describe('inputBudget returns maxTokens - reservedForOutput', () => {
    it('calculates budget with default reservedForOutput (25%)', () => {
      const manager = new ContextWindowManager({
        maxTokens: 1000,
        countTokens,
      });

      expect(manager.inputBudget).toBe(750);
    });

    it('calculates budget with custom reservedForOutput', () => {
      const manager = new ContextWindowManager({
        maxTokens: 1000,
        reservedForOutput: 200,
        countTokens,
      });

      expect(manager.inputBudget).toBe(800);
    });
  });

  describe('noopStrategy returns messages unchanged', () => {
    it('yields the same messages back', async () => {
      const strategy = noopStrategy();
      const messages = createMessages(5);

      const generator = strategy.compact(messages, {
        maxTokens: 1000,
        reservedForOutput: 250,
        currentTokenCount: 100,
      });

      const result = await generator.next();
      expect(result.value).toEqual(messages);
    });
  });

  describe('slidingWindowStrategy', () => {
    it('returns empty array when given empty messages', async () => {
      const strategy = slidingWindowStrategy({ preserveRecentCount: 5 });

      const generator = strategy.compact([], {
        maxTokens: 1000,
        reservedForOutput: 250,
        currentTokenCount: 0,
      });

      const result = await generator.next();
      const compacted = result.value;

      expect(compacted).toEqual([]);
      expect(compacted).toHaveLength(0);
    });

    it('keeps system message and last N messages when preserveRecentCount=5', async () => {
      const messages = createMessages(20, { withSystem: true });
      const strategy = slidingWindowStrategy({ preserveRecentCount: 5 });

      const generator = strategy.compact(messages, {
        maxTokens: 1000,
        reservedForOutput: 250,
        currentTokenCount: 500,
      });

      const result = await generator.next();
      const compacted = result.value;

      // System message + last 5 = 6 total
      expect(compacted).toHaveLength(6);
      expect(compacted[0]!.role).toBe('system');
      expect(compacted[0]!.content).toBe('You are a helpful assistant.');

      // Last 5 messages from the original array (index 16-20)
      const lastFive = messages.slice(-5);
      expect(compacted.slice(1)).toEqual(lastFive);
    });

    it('preserves system message by default', async () => {
      const messages = [
        createMessage('system', 'System prompt'),
        createMessage('user', 'Old message 1'),
        createMessage('assistant', 'Old message 2'),
        createMessage('user', 'Old message 3'),
        createMessage('assistant', 'Old message 4'),
        createMessage('user', 'Recent message'),
      ];
      const strategy = slidingWindowStrategy({ preserveRecentCount: 2 });

      const generator = strategy.compact(messages, {
        maxTokens: 1000,
        reservedForOutput: 250,
        currentTokenCount: 500,
      });

      const result = await generator.next();
      const compacted = result.value;

      expect(compacted).toHaveLength(3);
      expect(compacted[0]!.role).toBe('system');
      expect(compacted[0]!.content).toBe('System prompt');
      expect(compacted[1]!.content).toBe('Old message 4');
      expect(compacted[2]!.content).toBe('Recent message');
    });

    it('keeps last N without system message when none present', async () => {
      const messages = createMessages(10); // no system message
      const strategy = slidingWindowStrategy({ preserveRecentCount: 3 });

      const generator = strategy.compact(messages, {
        maxTokens: 1000,
        reservedForOutput: 250,
        currentTokenCount: 500,
      });

      const result = await generator.next();
      const compacted = result.value;

      expect(compacted).toHaveLength(3);
      expect(compacted).toEqual(messages.slice(-3));
    });

    it('still runs when messages are under threshold', async () => {
      const messages = createMessages(3, { withSystem: true });
      const strategy = slidingWindowStrategy({ preserveRecentCount: 10 });

      const generator = strategy.compact(messages, {
        maxTokens: 10000,
        reservedForOutput: 2500,
        currentTokenCount: 10,
      });

      const result = await generator.next();
      const compacted = result.value;

      // preserveRecentCount is larger than message count, so all kept
      expect(compacted).toEqual(messages);
    });
  });

  describe('composeStrategies applies strategies in sequence', () => {
    it('chains two strategies together', async () => {
      // Strategy 1: drop all but last 10
      const first = slidingWindowStrategy({
        preserveRecentCount: 10,
        preserveSystemMessage: false,
      });
      // Strategy 2: drop all but last 5
      const second = slidingWindowStrategy({
        preserveRecentCount: 5,
        preserveSystemMessage: false,
      });

      const composed = composeStrategies(first, second);
      const messages = createMessages(20);

      const generator = composed.compact(messages, {
        maxTokens: 1000,
        reservedForOutput: 250,
        currentTokenCount: 500,
      });

      const result = await generator.next();
      const compacted = result.value;

      // First pass: 20 -> last 10
      // Second pass: 10 -> last 5
      expect(compacted).toHaveLength(5);
      expect(compacted).toEqual(messages.slice(-5));
    });
  });

  describe('compact returns correct metrics', () => {
    it('reports tokensBefore, tokensAfter, and messagesDropped', async () => {
      const messages = createMessages(20, { withSystem: true });
      const strategy = slidingWindowStrategy({ preserveRecentCount: 5 });

      const manager = new ContextWindowManager({
        maxTokens: 1000,
        countTokens,
        strategy,
      });

      const result = await manager.compact(messages);

      // 21 messages total -> 6 after compaction (system + 5 recent)
      expect(result.messagesDropped).toBe(15);
      expect(result.tokensAfter).toBeLessThan(result.tokensBefore);
      expect(result.messages).toHaveLength(6);

      // Verify token counts are computed correctly
      const expectedTokensBefore = await countTokens(messages);
      const expectedTokensAfter = await countTokens(result.messages);
      expect(result.tokensBefore).toBe(expectedTokensBefore);
      expect(result.tokensAfter).toBe(expectedTokensAfter);
    });
  });

  describe('default compactAt is 0.85', () => {
    it('uses 0.85 as the default compactAt threshold', () => {
      const manager = new ContextWindowManager({
        maxTokens: 1000,
        countTokens,
      });

      // inputBudget = 750, 85% of 750 = 637.5
      expect(manager.shouldCompact(637)).toBe(false);
      expect(manager.shouldCompact(638)).toBe(true);
    });
  });

  describe('default countTokens', () => {
    it('uses the built-in token counter when none is provided', async () => {
      const manager = new ContextWindowManager({
        maxTokens: 10000,
      });

      const messages = createMessages(3);
      const result = await manager.compact(messages);

      // The default countTokens uses content.length / 4
      expect(result.tokensBefore).toBeGreaterThan(0);
      expect(result.messages).toHaveLength(3);
    });
  });
});
