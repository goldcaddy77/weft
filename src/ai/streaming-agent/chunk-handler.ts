import type { StreamChunk } from '../providers/types.ts';
import type { PendingStreamingToolCall, StreamingChatState } from './types.ts';

export function createStreamingChatState(): StreamingChatState {
  return {
    content: '',
    usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
    toolCalls: [],
    pendingToolCalls: new Map<string, PendingStreamingToolCall>(),
  };
}

export function appendToolCallInput(
  pendingToolCall: PendingStreamingToolCall,
  input: unknown,
): void {
  if (input === undefined) {
    return;
  }

  pendingToolCall.input += typeof input === 'string' ? input : JSON.stringify(input);
}

export function finalizePendingToolCall(toolCallId: string, state: StreamingChatState): void {
  const pendingToolCall = state.pendingToolCalls.get(toolCallId);
  if (!pendingToolCall) {
    return;
  }

  let parsedInput: unknown;
  try {
    parsedInput = JSON.parse(pendingToolCall.input);
  } catch {
    parsedInput = pendingToolCall.input || {};
  }

  state.toolCalls.push({
    id: pendingToolCall.id,
    name: pendingToolCall.name,
    input: parsedInput,
  });
  state.pendingToolCalls.delete(toolCallId);
}

// oxlint-disable-next-line complexity -- ID:ai-streaming-agent-handle-streaming-chunk-complexity
export function handleStreamingChunk(
  chunk: StreamChunk,
  state: StreamingChatState,
  onToken: (token: string) => void,
): void {
  switch (chunk.type) {
    case 'token':
      if (chunk.token !== undefined) {
        state.content += chunk.token;
        onToken(chunk.token);
      }
      return;
    case 'tool_call_start':
      if (chunk.toolCall?.id) {
        state.pendingToolCalls.set(chunk.toolCall.id, {
          id: chunk.toolCall.id,
          name: chunk.toolCall.name ?? '',
          input: '',
        });
      }
      return;
    case 'tool_call_delta':
      if (chunk.toolCall?.id) {
        const pendingToolCall = state.pendingToolCalls.get(chunk.toolCall.id);
        if (pendingToolCall) {
          appendToolCallInput(pendingToolCall, chunk.toolCall.input);
        }
      }
      return;
    case 'tool_call_end':
      if (chunk.toolCall?.id) {
        finalizePendingToolCall(chunk.toolCall.id, state);
      }
      return;
    case 'done':
      if (chunk.usage) {
        state.usage = chunk.usage;
      }
      return;
  }
}
