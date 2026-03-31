/**
 * Summarization context strategy.
 *
 * Compresses older messages into a single summary while preserving the
 * system prompt and the most recent N messages. The summarization itself
 * is delegated to an injected provider so the caller controls which model
 * and API are used.
 *
 * @module summarize
 */

import type { CompactOptions, ContextStrategy } from '../context-window.ts';
import type { Message } from '../providers/types.ts';

/**
 * Minimal interface for the summarization call. Decoupled from the full
 * LLMProvider so that callers can provide a lightweight wrapper, a mock,
 * or a dedicated summarization endpoint.
 */
export interface SummarizeProvider {
  summarize(messages: Message[]): Promise<string>;
}

export interface SummarizeStrategyOptions {
  /** Provider that performs the summarization call. */
  provider: SummarizeProvider;
  /** Number of recent non-system messages to preserve verbatim. */
  keepRecent: number;
}

/**
 * Create a context strategy that summarizes older messages.
 *
 * Messages are split into three groups:
 * 1. The system prompt (if present) — always preserved.
 * 2. Old messages beyond the `keepRecent` window — compressed into a
 *    single assistant message via `provider.summarize`.
 * 3. Recent messages — preserved verbatim.
 */
export function createSummarizeStrategy(options: SummarizeStrategyOptions): ContextStrategy {
  const { provider, keepRecent } = options;

  return {
    async *compact(
      messages: Message[],
      _compactOptions: CompactOptions,
    ): AsyncGenerator<Message[], Message[], unknown> {
      if (messages.length === 0) {
        yield messages;
        return messages;
      }

      const hasSystemMessage = messages[0]?.role === 'system';
      const systemMessage = hasSystemMessage ? messages[0]! : null;
      const nonSystemMessages = hasSystemMessage ? messages.slice(1) : messages;

      // Nothing to summarize if we have fewer messages than keepRecent
      if (nonSystemMessages.length <= keepRecent) {
        yield messages;
        return messages;
      }

      const oldMessages = nonSystemMessages.slice(0, -keepRecent);
      const recentMessages = nonSystemMessages.slice(-keepRecent);

      const summaryText = await provider.summarize(oldMessages);
      const summaryMessage: Message = {
        role: 'assistant',
        content: summaryText,
      };

      const result: Message[] = [];
      if (systemMessage) {
        result.push(systemMessage);
      }
      result.push(summaryMessage, ...recentMessages);

      yield result;
      return result;
    },
  };
}
