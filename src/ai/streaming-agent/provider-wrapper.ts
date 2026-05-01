import type { ChatOptions, LLMProvider } from '../providers/interface.ts';
import type { ChatResponse, ChatResumeHint, Message } from '../providers/types.ts';
import { createStreamingChatState, handleStreamingChunk } from './chunk-handler.ts';

/**
 * Wraps an LLMProvider's `chat` method to use `stream` instead, collecting
 * tokens through a callback while still returning a full ChatResponse.
 */
export function createStreamingProvider(
  provider: LLMProvider,
  onToken: (token: string) => void,
): LLMProvider {
  return {
    name: provider.name,

    async chat(messages: Message[], options: ChatOptions): Promise<ChatResponse> {
      const stream = await provider.stream(messages, options);
      const reader = stream.getReader();
      const state = createStreamingChatState();

      try {
        while (true) {
          const chunk = await reader.read();
          if (chunk.done) break;
          handleStreamingChunk(chunk.value, state, onToken);
        }
      } finally {
        reader.cancel().catch(() => {});
      }

      return {
        content: state.content,
        toolCalls: state.toolCalls,
        usage: state.usage,
        model: options.model,
        stopReason: state.toolCalls.length > 0 ? 'tool_use' : 'end_turn',
      };
    },

    async stream(messages: Message[], options: ChatOptions) {
      return provider.stream(messages, options);
    },

    async countTokens(messages: Message[]): Promise<number> {
      return provider.countTokens(messages);
    },

    async createChatResumeHint(
      messages: Message[],
      options: ChatOptions,
    ): Promise<ChatResumeHint | undefined> {
      return provider.createChatResumeHint?.(messages, options);
    },

    async warmup(): Promise<void> {
      await provider.warmup?.();
    },
  };
}
