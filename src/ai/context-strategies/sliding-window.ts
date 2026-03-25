import type { CompactOptions, ContextStrategy } from '../context-window.ts';
import type { Message } from '../providers/types.ts';

export interface SlidingWindowOptions {
  preserveSystemMessage?: boolean;
  preserveRecentCount?: number;
}

export function slidingWindowStrategy(options?: SlidingWindowOptions): ContextStrategy {
  const preserveSystemMessage = options?.preserveSystemMessage ?? true;
  const preserveRecentCount = options?.preserveRecentCount ?? 10;

  return {
    async *compact(
      messages: Message[],
      _options: CompactOptions,
    ): AsyncGenerator<Message[], Message[], unknown> {
      if (messages.length === 0) {
        yield messages;
        return messages;
      }

      const hasSystemMessage = preserveSystemMessage && messages[0]?.role === 'system';
      const systemMessage = hasSystemMessage ? messages[0]! : null;
      const nonSystemMessages = hasSystemMessage ? messages.slice(1) : messages;

      if (nonSystemMessages.length <= preserveRecentCount) {
        yield messages;
        return messages;
      }

      const recentMessages = nonSystemMessages.slice(-preserveRecentCount);

      if (systemMessage) {
        const result = [systemMessage, ...recentMessages];
        yield result;
        return result;
      }

      yield recentMessages;
      return recentMessages;
    },
  };
}
