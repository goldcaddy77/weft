export type MessageRole = 'system' | 'user' | 'assistant' | 'tool';

/**
 * Normalized conversation message used throughout the agent loop. The `role`
 * discriminates `system`, `user`, `assistant`, and `tool` turns. `toolCalls`
 * carries assistant-initiated function requests; `toolResults` carries the
 * execution results sent back to the model.
 *
 * @example Build a minimal two-message conversation
 * ```ts
 * import type { Message } from 'weft';
 *
 * const conversation: Message[] = [
 *   { role: 'system', content: 'You are a helpful assistant.' },
 *   { role: 'user', content: 'What is the speed of light?' },
 * ];
 * ```
 */
export interface Message {
  role: MessageRole;
  content: string;
  toolCalls?: ToolCall[];
  toolResults?: ToolResult[];
  name?: string;
}

export interface ToolCall {
  id: string;
  name: string;
  input: unknown;
}

export interface ToolResult {
  toolCallId: string;
  output: string;
  isError?: boolean;
}

/**
 * Schema descriptor for a callable tool. Consumed by {@link LLMProvider}
 * implementations to build provider-specific tool listings, and by
 * {@link ToolRegistry} to register tools with the agent loop. The `inputSchema`
 * follows JSON Schema Draft 7 conventions; tools with no parameters use
 * `{ type: 'object' }`.
 *
 * @example Define a tool with required and optional parameters
 * ```ts
 * import type { ToolDefinition } from 'weft';
 *
 * const searchTool: ToolDefinition = {
 *   name: 'web_search',
 *   description: 'Search the web for recent information.',
 *   inputSchema: {
 *     type: 'object',
 *     required: ['query'],
 *     properties: {
 *       query: { type: 'string', description: 'Search query' },
 *       limit: { type: 'number', description: 'Max results to return' },
 *     },
 *   },
 * };
 * ```
 */
export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

/**
 * Token consumption summary returned inside {@link ChatResponse.usage} and
 * {@link StreamChunk.usage}. Provides `inputTokens`, `outputTokens`, and their
 * sum `totalTokens`. Used by {@link BudgetTracker} to compute per-turn cost.
 * This interface is produced by providers — callers read it but do not construct it.
 */
export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
}

/**
 * A single chunk emitted by {@link LLMProvider.stream}. The `type` field
 * discriminates content token deltas (`'token'`), tool call lifecycle events,
 * and the terminal `'done'` chunk which carries the final {@link TokenUsage}.
 * Consume via an async `for await` loop on the returned `ReadableStream`.
 *
 * @example Stream a response and accumulate tokens
 * ```ts
 * import { AnthropicProvider, type StreamChunk } from 'weft';
 *
 * const provider = new AnthropicProvider({ apiKey: process.env['ANTHROPIC_API_KEY'] ?? '' });
 * const stream = await provider.stream([{ role: 'user', content: 'Hello' }], { model: 'claude-haiku-3-5' });
 *
 * let text = '';
 * for await (const chunk of stream as AsyncIterable<StreamChunk>) {
 *   if (chunk.type === 'token' && chunk.token) text += chunk.token;
 *   if (chunk.type === 'done') console.log('Usage:', chunk.usage);
 * }
 * console.log(text);
 * ```
 */
export interface StreamChunk {
  type: 'token' | 'tool_call_start' | 'tool_call_delta' | 'tool_call_end' | 'done';
  token?: string;
  toolCall?: Partial<ToolCall>;
  usage?: TokenUsage;
}

/**
 * Normalized response shape returned by {@link LLMProvider.chat}. Contains the
 * generated text `content`, any `toolCalls` requested by the model, cumulative
 * `usage` counts, the model that served the request, the `stopReason`, and an
 * optional `reasoningTrace` from provider-specific thinking blocks. This
 * interface is produced by providers — callers read it but do not construct it.
 */
export interface ChatResponse {
  content: string;
  toolCalls: ToolCall[];
  usage: TokenUsage;
  model: string;
  stopReason: 'end_turn' | 'tool_use' | 'max_tokens' | 'stop_sequence';
  /** Reasoning/thinking text extracted from provider-specific thinking blocks. */
  reasoningTrace?: string | undefined;
}
