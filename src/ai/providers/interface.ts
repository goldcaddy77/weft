import type {
  ChatResponse,
  ChatResumeContext,
  ChatResumeHint,
  Message,
  StreamChunk,
  ToolDefinition,
} from './types';

/**
 * The normalized provider interface that {@link executeAgentLoop} and other AI
 * utilities depend on. Implementations ({@link AnthropicProvider},
 * {@link OpenAIProvider}) translate this interface to provider-specific HTTP APIs.
 * Implement this interface to add support for additional providers.
 *
 * @example Implement a minimal stub provider for testing
 * ```ts
 * import type { LLMProvider, ChatOptions, ChatResponse, Message, StreamChunk } from 'weft';
 *
 * const stubProvider: LLMProvider = {
 *   name: 'stub',
 *   async chat(_messages: Message[], _options: ChatOptions): Promise<ChatResponse> {
 *     return {
 *       content: 'Hello from stub',
 *       toolCalls: [],
 *       usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
 *       model: 'stub-1.0',
 *       stopReason: 'end_turn',
 *     };
 *   },
 *   async stream(_messages: Message[], _options: ChatOptions): Promise<ReadableStream<StreamChunk>> {
 *     return new ReadableStream();
 *   },
 *   async countTokens(_messages: Message[]): Promise<number> { return 10; },
 * };
 * ```
 */
export interface LLMProvider {
  readonly name: string;

  chat(messages: Message[], options: ChatOptions): Promise<ChatResponse>;
  stream(messages: Message[], options: ChatOptions): Promise<ReadableStream<StreamChunk>>;
  countTokens(messages: Message[]): Promise<number>;
  /**
   * Optional provider hook for asynchronous resume-aware execution.
   *
   * When this returns a hint, the engine may park the workflow until a signal
   * with the matching resume token arrives, then resume the eventual `chat()`
   * or `stream()` call with `options.resumeContext`.
   */
  createChatResumeHint?(
    messages: Message[],
    options: ChatOptions,
  ): Promise<ChatResumeHint | undefined>;
  /**
   * Pre-warm the connection to the LLM provider (TCP+TLS handshake).
   * Called fire-and-forget when an agent workflow starts. Failures are silently
   * swallowed — warmup is best-effort and must never block workflow execution.
   */
  warmup?(): Promise<void>;
}

/**
 * Per-call options passed to {@link LLMProvider.chat} and
 * {@link LLMProvider.stream}. Specifies the model identifier, optional tool
 * list, max output tokens, sampling temperature, abort signal, and system prompt
 * override for this specific call.
 *
 * @example Build chat options for a tool-enabled call
 * ```ts
 * import type { ChatOptions, ToolDefinition } from 'weft';
 *
 * const tools: ToolDefinition[] = [
 *   { name: 'search', description: 'Search the web.', inputSchema: { type: 'object' } },
 * ];
 *
 * const options: ChatOptions = {
 *   model: 'claude-sonnet-4-5',
 *   tools,
 *   maxTokens: 2048,
 *   temperature: 0.7,
 * };
 * ```
 */
export interface ChatOptions {
  model: string;
  tools?: ToolDefinition[];
  maxTokens?: number;
  temperature?: number;
  signal?: AbortSignal;
  systemPrompt?: string;
  /**
   * Zero-based turn index for the current agent turn.
   *
   * Providers can use this to key opt-in asynchronous resume state without
   * inferring turn boundaries from the raw message array.
   */
  turnIndex?: number;
  /**
   * Provider-specific resume context supplied after a parked LLM wait resumes.
   * Undefined during ordinary blocking chat/stream calls.
   */
  resumeContext?: ChatResumeContext;
}
