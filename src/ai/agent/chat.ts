import { materializeToolCalls } from './tool-materialization.ts';
import type {
  AgentRuntime,
  ChatOptions,
  ChatResponse,
  ChatTurnResult,
  Message,
  NormalizedChatResponse,
} from './types.ts';

/** Build provider chat options for a single turn. */
export function createChatOptions(
  runtime: AgentRuntime,
  model: string,
  turnIndex: number,
): ChatOptions {
  const chatOptions: ChatOptions = { model, turnIndex };
  if (runtime.toolDefinitions.length > 0) {
    chatOptions.tools = runtime.toolDefinitions;
  }
  if (runtime.options.signal) {
    chatOptions.signal = runtime.options.signal;
  }
  return chatOptions;
}

/** Detect AbortError values from DOM or already-aborted signals. */
export function isAbortError(signal: AbortSignal | undefined, error: unknown): boolean {
  return signal?.aborted === true || (error instanceof DOMException && error.name === 'AbortError');
}

/** Convert a provider response into an assistant message. */
export function createAssistantMessage(response: NormalizedChatResponse): Message {
  const assistantMessage: Message = {
    role: 'assistant',
    content: response.content,
  };
  if (response.toolCalls.length > 0) {
    assistantMessage.toolCalls = response.toolCalls;
  }
  return assistantMessage;
}

/** Record token usage, content, conversation, and reasoning for a completed turn. */
export function recordTurnResponse(runtime: AgentRuntime, response: NormalizedChatResponse): void {
  runtime.state.totalTokens.inputTokens += response.usage.inputTokens;
  runtime.state.totalTokens.outputTokens += response.usage.outputTokens;
  runtime.state.totalTokens.totalTokens += response.usage.totalTokens;
  runtime.state.turnCount++;
  runtime.state.lastContent = response.content;
  runtime.state.conversation.push(createAssistantMessage(response));

  if (response.reasoningTrace) {
    runtime.state.reasoningTraces.push(response.reasoningTrace);
  }
}

function normalizeChatResponse(response: ChatResponse): NormalizedChatResponse {
  return {
    ...response,
    toolCalls: materializeToolCalls(response.toolCalls),
  };
}

/** Execute one provider chat call with the configured model. */
export async function executeChatWithFallbacks(
  runtime: AgentRuntime,
  turnIndex: number,
  messagesToSend: Message[],
): Promise<ChatTurnResult> {
  const model = runtime.options.defaultModel;
  const turnStart = Date.now();

  const response = normalizeChatResponse(
    await runtime.options.provider.chat(
      messagesToSend,
      createChatOptions(runtime, model, turnIndex),
    ),
  );

  const turnDuration = Date.now() - turnStart;
  recordTurnResponse(runtime, response);

  return {
    response,
    originalModel: model,
    turnDuration,
  };
}
