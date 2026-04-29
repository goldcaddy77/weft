import type {
  ChatResponse,
  ChatResumeContext,
  ChatResumeHint,
  Message,
  StreamChunk,
  ToolDefinition,
} from './types';

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
