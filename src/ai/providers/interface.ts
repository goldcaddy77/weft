import type { ChatResponse, Message, StreamChunk, ToolDefinition } from './types';

export interface LLMProvider {
  readonly name: string;

  chat(messages: Message[], options: ChatOptions): Promise<ChatResponse>;
  stream(messages: Message[], options: ChatOptions): Promise<ReadableStream<StreamChunk>>;
  countTokens(messages: Message[]): Promise<number>;
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
}
