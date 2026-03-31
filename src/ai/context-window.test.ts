import { describe, expect, it } from 'bun:test';

import { slidingWindowStrategy } from './context-strategies/sliding-window.ts';
import { createSummarizeStrategy } from './context-strategies/summarize.ts';
import type { CompactOptions, ContextStrategy } from './context-window.ts';
import { ContextWindowManager, composeStrategies, noopStrategy } from './context-window.ts';
import { AgentContextCompactedEvent } from './events.ts';
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

    it('composes sliding window then summarize', async () => {
      // Strategy 1: sliding window keeps system + last 10 non-system
      const sliding = slidingWindowStrategy({
        preserveRecentCount: 10,
        preserveSystemMessage: true,
      });

      // Strategy 2: summarize compresses all but last 3 non-system messages
      const summarize = createSummarizeStrategy({
        provider: {
          summarize: async () => 'Summary of messages 0-6.',
        },
        keepRecent: 3,
      });

      const composed = composeStrategies(sliding, summarize);
      const messages = createMessages(20, { withSystem: true });

      const generator = composed.compact(messages, {
        maxTokens: 1000,
        reservedForOutput: 250,
        currentTokenCount: 500,
      });

      const result = await generator.next();
      const compacted = result.value;

      // First pass (sliding): 21 messages -> system + last 10 = 11
      // Second pass (summarize): 11 messages -> system + summary + last 3 = 5
      expect(compacted).toHaveLength(5);
      expect(compacted[0]!.role).toBe('system');
      expect(compacted[0]!.content).toBe('You are a helpful assistant.');
      expect(compacted[1]!.role).toBe('assistant');
      expect(compacted[1]!.content).toBe('Summary of messages 0-6.');
      // Last 3 non-system messages from the sliding window output
      expect(compacted.slice(-3)).toEqual(messages.slice(-3));
    });

    it('composes with a noop strategy', async () => {
      const noop = noopStrategy();
      const sliding = slidingWindowStrategy({
        preserveRecentCount: 5,
        preserveSystemMessage: false,
      });

      const composed = composeStrategies(noop, sliding);
      const messages = createMessages(20);

      const generator = composed.compact(messages, {
        maxTokens: 1000,
        reservedForOutput: 250,
        currentTokenCount: 500,
      });

      const result = await generator.next();
      const compacted = result.value;

      // Noop passes through, then sliding keeps last 5
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

  describe('checkpoint and recovery', () => {
    it('stores compacted messages that survive checkpoint/restore', async () => {
      const strategy = slidingWindowStrategy({ preserveRecentCount: 3 });
      const manager = new ContextWindowManager({
        maxTokens: 1000,
        compactAt: 0.85,
        strategy,
        countTokens,
      });

      const messages = createMessages(15, { withSystem: true });
      const compacted = await manager.compact(messages);

      // Take a checkpoint
      const checkpoint = manager.checkpoint();
      expect(checkpoint.compactedMessages).toEqual(compacted.messages);

      // Simulate crash: create a new manager and restore
      const restoredManager = new ContextWindowManager({
        maxTokens: 1000,
        compactAt: 0.85,
        strategy,
        countTokens,
      });
      restoredManager.restore(checkpoint);

      // The restored manager should return the compacted messages directly
      expect(restoredManager.getCompactedMessages()).toEqual(compacted.messages);
    });

    it('does not re-run strategy when compacted messages are restored', async () => {
      let strategyCallCount = 0;
      const trackingStrategy: ContextStrategy = {
        name: 'tracking',
        async *compact(
          messages: Message[],
          _options: CompactOptions,
        ): AsyncGenerator<Message[], Message[], unknown> {
          strategyCallCount++;
          const result = messages.slice(-3);
          yield result;
          return result;
        },
      };

      const manager = new ContextWindowManager({
        maxTokens: 1000,
        strategy: trackingStrategy,
        countTokens,
      });

      const messages = createMessages(10);
      await manager.compact(messages);
      expect(strategyCallCount).toBe(1);

      // Checkpoint and restore
      const checkpoint = manager.checkpoint();
      const restoredManager = new ContextWindowManager({
        maxTokens: 1000,
        strategy: trackingStrategy,
        countTokens,
      });
      restoredManager.restore(checkpoint);

      // Compacted messages are available without re-running the strategy
      const restored = restoredManager.getCompactedMessages();
      expect(restored).not.toBeNull();
      expect(strategyCallCount).toBe(1); // Strategy was NOT called again
    });

    it('clears compacted messages after they are consumed', async () => {
      const strategy = slidingWindowStrategy({ preserveRecentCount: 3 });
      const manager = new ContextWindowManager({
        maxTokens: 1000,
        strategy,
        countTokens,
      });

      const messages = createMessages(10, { withSystem: true });
      await manager.compact(messages);

      const checkpoint = manager.checkpoint();
      expect(checkpoint.compactedMessages).not.toBeNull();

      // Consume the compacted messages
      manager.clearCompactedMessages();
      const afterClear = manager.checkpoint();
      expect(afterClear.compactedMessages).toBeNull();
    });

    it('returns null from getCompactedMessages when nothing is checkpointed', () => {
      const manager = new ContextWindowManager({
        maxTokens: 1000,
        countTokens,
      });

      expect(manager.getCompactedMessages()).toBeNull();
    });
  });

  describe('custom strategy integration', () => {
    it('calls custom strategy when token count exceeds threshold', async () => {
      let strategyCalled = false;
      const customStrategy: ContextStrategy = {
        name: 'custom',
        async *compact(
          messages: Message[],
          _options: CompactOptions,
        ): AsyncGenerator<Message[], Message[], unknown> {
          strategyCalled = true;
          // Keep only the last 2 messages
          const result = messages.slice(-2);
          yield result;
          return result;
        },
      };

      const manager = new ContextWindowManager({
        maxTokens: 100,
        reservedForOutput: 25,
        compactAt: 0.5,
        strategy: customStrategy,
        countTokens,
      });

      // inputBudget = 75, 50% of 75 = 37.5 -> need >=38 tokens to trigger
      // 10 messages with ~3 tokens each = 30, not enough
      // Use longer messages to exceed the threshold
      const messages = createMessages(20, { withSystem: true });
      const tokenCount = await countTokens(messages);

      // Verify we are actually over the threshold
      expect(manager.shouldCompact(tokenCount)).toBe(true);

      const result = await manager.compact(messages);
      expect(strategyCalled).toBe(true);
      expect(result.messages).toHaveLength(2);
    });

    it('passes correct options to the strategy', async () => {
      let receivedOptions: CompactOptions | null = null;
      const customStrategy: ContextStrategy = {
        name: 'custom',
        async *compact(
          messages: Message[],
          options: CompactOptions,
        ): AsyncGenerator<Message[], Message[], unknown> {
          receivedOptions = options;
          yield messages;
          return messages;
        },
      };

      const manager = new ContextWindowManager({
        maxTokens: 1000,
        reservedForOutput: 200,
        strategy: customStrategy,
        countTokens,
      });

      const messages = createMessages(5);
      await manager.compact(messages);

      expect(receivedOptions).not.toBeNull();
      expect(receivedOptions!.maxTokens).toBe(1000);
      expect(receivedOptions!.reservedForOutput).toBe(200);
      // currentTokenCount should match what countTokens returns
      const expectedTokenCount = await countTokens(messages);
      expect(receivedOptions!.currentTokenCount).toBe(expectedTokenCount);
    });

    it('returns the strategy output as compacted messages', async () => {
      const summaryMessage = createMessage('system', 'Summary of prior conversation.');
      const customStrategy: ContextStrategy = {
        name: 'custom',
        async *compact(
          _messages: Message[],
          _options: CompactOptions,
        ): AsyncGenerator<Message[], Message[], unknown> {
          const result = [summaryMessage];
          yield result;
          return result;
        },
      };

      const manager = new ContextWindowManager({
        maxTokens: 1000,
        strategy: customStrategy,
        countTokens,
      });

      const messages = createMessages(10);
      const result = await manager.compact(messages);

      expect(result.messages).toHaveLength(1);
      expect(result.messages[0]).toEqual(summaryMessage);
      expect(result.messagesDropped).toBe(9);
    });
  });

  describe('AgentContextCompactedEvent integration', () => {
    it('compact returns fields needed to construct the event', async () => {
      const strategy = slidingWindowStrategy({ preserveRecentCount: 3 });
      const manager = new ContextWindowManager({
        maxTokens: 1000,
        strategy,
        countTokens,
      });

      const messages = createMessages(15, { withSystem: true });
      const result = await manager.compact(messages);

      // Verify the result has all fields needed for the event
      expect(result.tokensBefore).toBeGreaterThan(0);
      expect(result.tokensAfter).toBeGreaterThan(0);
      expect(result.tokensAfter).toBeLessThan(result.tokensBefore);
      expect(result.messagesDropped).toBe(12); // 16 - 4 (system + 3 recent)

      // Construct event from compact result
      const event = new AgentContextCompactedEvent(
        'wf-test',
        'agent-test',
        'sliding-window',
        result.tokensBefore,
        result.tokensAfter,
        result.messagesDropped,
      );

      expect(event.type).toBe('agent:context:compacted');
      expect(event.strategy).toBe('sliding-window');
      expect(event.tokensBefore).toBe(result.tokensBefore);
      expect(event.tokensAfter).toBe(result.tokensAfter);
      expect(event.messagesDropped).toBe(12);
    });

    it('dispatches event via EventTarget when compaction occurs', async () => {
      const strategy = slidingWindowStrategy({ preserveRecentCount: 3 });
      const manager = new ContextWindowManager({
        maxTokens: 1000,
        strategy,
        countTokens,
      });

      const eventTarget = new EventTarget();
      let receivedEvent: AgentContextCompactedEvent | null = null;
      eventTarget.addEventListener(AgentContextCompactedEvent.type, ((event: Event) => {
        receivedEvent = event as AgentContextCompactedEvent;
      }) as EventListener);

      const messages = createMessages(15, { withSystem: true });
      const result = await manager.compact(messages);

      // Simulate what the agent loop does: dispatch event after compaction
      eventTarget.dispatchEvent(
        new AgentContextCompactedEvent(
          'wf-dispatch',
          'agent-dispatch',
          'sliding-window',
          result.tokensBefore,
          result.tokensAfter,
          result.messagesDropped,
        ),
      );

      expect(receivedEvent).not.toBeNull();
      expect(receivedEvent!.workflowId).toBe('wf-dispatch');
      expect(receivedEvent!.strategy).toBe('sliding-window');
      expect(receivedEvent!.tokensBefore).toBe(result.tokensBefore);
      expect(receivedEvent!.tokensAfter).toBe(result.tokensAfter);
      expect(receivedEvent!.messagesDropped).toBe(result.messagesDropped);
    });
  });
});
