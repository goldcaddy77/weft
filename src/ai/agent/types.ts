/* oxlint-disable max-lines -- ID:ai-agent-types-file-length */
import type { ToolIdentityResult } from '../declaration.ts';
import type { ToolEffectLogLike } from '../tool-effect-log.ts';

/**
 * JSON primitive values that can safely cross provider, tool, and checkpoint
 * boundaries.
 *
 * @example
 * ```ts
 * import type { JSONPrimitive } from 'weft';
 *
 * const value: JSONPrimitive = 'ready';
 * ```
 */
export type JSONPrimitive = string | number | boolean | null;

/**
 * Recursive JSON-safe value used for Agent Bureau-compatible tool calls,
 * tool results, tool actions, and conversation metadata.
 *
 * @example
 * ```ts
 * import type { JSONValue } from 'weft';
 *
 * const value: JSONValue = { count: 1, tags: ['agent'] };
 * ```
 */
export type JSONValue = JSONPrimitive | ReadonlyArray<JSONValue> | { [key: string]: JSONValue };

// ---------------------------------------------------------------------------
// Structural types - canonical home post-shrinkage.
// Phase 0 seam: these were previously in src/ai/providers/types.ts and
// src/ai/providers/interface.ts. They now live here and are re-exported
// through src/ai/agent/index.ts.
// ---------------------------------------------------------------------------

/**
 * Discriminator for the four conversation roles the agent loop normalizes.
 * `system` carries the agent's instructions; `user` is the human input;
 * `assistant` is a model turn; `tool` carries tool-call results back into
 * the conversation.
 *
 * @example
 * ```ts
 * import type { MessageRole } from 'weft';
 *
 * const role: MessageRole = 'assistant';
 * ```
 */
export type MessageRole = 'system' | 'user' | 'assistant' | 'tool';

/**
 * Normalized conversation message used throughout the agent loop.
 *
 * @example Build a minimal two-message conversation
 * ```ts
 * import type { Message } from 'weft';
 *
 * const conversation: Message[] = [
 *   { role: 'system', content: 'You are a helpful assistant.' },
 *   { role: 'user', content: 'What time is it?' },
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

/**
 * Minimal shape of a Conversationalist-style message in an Agent Bureau
 * conversation history. Weft does not interpret this object at runtime; the
 * shape exists so Agent Bureau conversation histories can satisfy Weft's
 * public result contract structurally.
 *
 * @example
 * ```ts
 * import type { ConversationHistoryMessage } from 'weft';
 *
 * const message: ConversationHistoryMessage = {
 *   id: 'message-1',
 *   role: 'assistant',
 *   content: 'Done',
 *   position: 0,
 *   createdAt: '2026-05-08T12:00:00.000Z',
 *   metadata: {},
 *   hidden: false,
 * };
 * ```
 */
export interface ConversationHistoryMessage {
  id: string;
  role: string;
  content: unknown;
  position: number;
  createdAt: string;
  metadata: Readonly<Record<string, JSONValue>>;
  hidden: boolean;
  toolCall?: Readonly<ToolCall> | undefined;
  toolResult?: Readonly<ToolResult> | undefined;
  tokenUsage?:
    | Readonly<{
        prompt: number;
        completion: number;
        total: number;
      }>
    | undefined;
  goalCompleted?: boolean | undefined;
}

/**
 * Agent Bureau-style conversation history object. Weft's built-in loop still
 * stores its provider transcript as `Message[]`, but wrappers can return this
 * richer history object without translation.
 *
 * @example
 * ```ts
 * import type { AgentBureauConversationHistory } from 'weft';
 *
 * const history: AgentBureauConversationHistory = {
 *   schemaVersion: 4,
 *   id: 'conversation-1',
 *   status: 'active',
 *   metadata: {},
 *   ids: [],
 *   messages: {},
 *   createdAt: '2026-05-08T12:00:00.000Z',
 *   updatedAt: '2026-05-08T12:00:00.000Z',
 * };
 * ```
 */
export interface AgentBureauConversationHistory {
  schemaVersion: number;
  id: string;
  title?: string | undefined;
  status: string;
  metadata: Readonly<Record<string, JSONValue>>;
  ids: ReadonlyArray<string>;
  messages: Readonly<Record<string, ConversationHistoryMessage>>;
  createdAt: string;
  updatedAt: string;
}

/**
 * Public conversation result contract. The built-in Weft loop returns a
 * provider transcript, while Agent Bureau can supply its richer conversation
 * history object structurally.
 *
 * @example
 * ```ts
 * import type { ConversationHistory } from 'weft';
 *
 * const history: ConversationHistory = [{ role: 'user', content: 'Hi' }];
 * ```
 */
export type ConversationHistory = Message[] | AgentBureauConversationHistory;

/**
 * Public input shape accepted from providers before Weft materializes a stable
 * call identifier and JSON-safe arguments.
 *
 * @example
 * ```ts
 * import type { ToolCallInput } from 'weft';
 *
 * const call: ToolCallInput = { name: 'web_search', arguments: { query: 'weft' } };
 * ```
 */
export interface ToolCallInput {
  id?: string | undefined;
  name: string;
  arguments?: unknown;
}

/**
 * A model-requested tool invocation. Pairs a stable `id` with the tool `name`
 * and JSON-safe model-supplied `arguments`.
 *
 * @example
 * ```ts
 * import type { ToolCall } from 'weft';
 *
 * const call: ToolCall = { id: 'call-1', name: 'get_time', arguments: {} };
 * ```
 */
export interface ToolCall {
  id: string;
  name: string;
  arguments: JSONValue;
}

/**
 * Agent Bureau-compatible tool error category.
 *
 * @example
 * ```ts
 * import type { ToolErrorCategory } from 'weft';
 *
 * const category: ToolErrorCategory = 'validation';
 * ```
 */
export type ToolErrorCategory =
  | 'validation'
  | 'permission'
  | 'not_found'
  | 'conflict'
  | 'transient'
  | 'timeout'
  | 'cancelled'
  | 'internal';

/**
 * JSON-safe tool error payload.
 *
 * @example
 * ```ts
 * import type { ToolErrorShape } from 'weft';
 *
 * const error: ToolErrorShape = {
 *   code: 'invalid_query',
 *   category: 'validation',
 *   retryable: false,
 *   message: 'Expected a query string.',
 * };
 * ```
 */
export interface ToolErrorShape {
  code: string;
  category: ToolErrorCategory;
  retryable: boolean;
  message: string;
  details?: JSONValue | undefined;
}

/**
 * Tool action payload for approval or extra input requests.
 *
 * @example
 * ```ts
 * import type { ToolActionShape } from 'weft';
 *
 * const action: ToolActionShape = { type: 'approval', message: 'Approve sending email?' };
 * ```
 */
export interface ToolActionShape {
  type: 'approval' | 'input';
  message?: string | undefined;
  schema?: JSONValue | undefined;
}

/**
 * Public tool-result input shape before Weft normalizes `content`, `error`,
 * and `action` to JSON-safe values.
 *
 * @example
 * ```ts
 * import type { ToolResultInput } from 'weft';
 *
 * const result: ToolResultInput = {
 *   callId: 'call-1',
 *   outcome: 'success',
 *   content: { ok: true },
 * };
 * ```
 */
export interface ToolResultInput {
  callId: string;
  outcome: 'success' | 'error' | 'action_required';
  content: unknown;
  error?: (Omit<ToolErrorShape, 'details'> & { details?: unknown }) | undefined;
  action?: (Omit<ToolActionShape, 'schema'> & { schema?: unknown }) | undefined;
  inputDigest?: string | undefined;
  outputDigest?: string | undefined;
}

/**
 * A normalized tool result sent back into the conversation. `callId` matches
 * the originating {@link ToolCall.id}; `outcome` records success, error, or
 * action-required state.
 *
 * @example
 * ```ts
 * import type { ToolResult } from 'weft';
 *
 * const result: ToolResult = { callId: 'call-1', outcome: 'success', content: '12:34Z' };
 * ```
 */
export interface ToolResult {
  callId: string;
  outcome: 'success' | 'error' | 'action_required';
  content: JSONValue;
  error?: ToolErrorShape | undefined;
  action?: ToolActionShape | undefined;
  inputDigest?: string | undefined;
  outputDigest?: string | undefined;
}

/**
 * Schema descriptor for a callable tool. Consumed by {@link LLMProvider}
 * implementations to advertise tools to the model. `input` follows JSON
 * Schema conventions for Weft-local tools; tools with no parameters use
 * `{ type: 'object' }`.
 *
 * @example
 * ```ts
 * import type { ToolDescriptor } from 'weft';
 *
 * const search: ToolDescriptor = {
 *   name: 'web_search',
 *   description: 'Search the web for recent information.',
 *   input: {
 *     type: 'object',
 *     required: ['query'],
 *     properties: { query: { type: 'string' } },
 *   },
 * };
 * ```
 */
export interface ToolDescriptor<InputSchema = unknown> {
  name: string;
  description?: string | undefined;
  input: InputSchema;
}

/**
 * Flat executable tool definition used by the agent loop. The `input` field is
 * intentionally generic so richer Agent Bureau tool configurations can satisfy
 * the shape structurally while Weft still normalizes model arguments and tool
 * results at runtime.
 *
 * @example
 * ```ts
 * import type { ToolDefinition } from 'weft';
 *
 * const tool: ToolDefinition = {
 *   name: 'get_time',
 *   description: 'Returns the current UTC time.',
 *   input: { type: 'object' },
 *   execute: async () => new Date().toISOString(),
 * };
 * ```
 */
export interface ToolDefinition<InputSchema = unknown> extends ToolDescriptor<InputSchema> {
  execute:
    | ((input: unknown, context?: unknown) => Promise<unknown>)
    | Promise<(input: unknown, context?: unknown) => Promise<unknown>>;
  verify?: (result: unknown) => Promise<boolean> | boolean;
  /**
   * Optional tool identity. Weft-local tools can provide a function for
   * idempotent tool-call deduplication; Armorer tools expose a static
   * identity object and remain structurally assignable.
   */
  identity?:
    | ((input: unknown) => ToolIdentityResult)
    | Readonly<{ namespace: string; name: string; version?: string | undefined }>;
  /** Semantic version of this tool. Defaults to `"0.0.0"` at declaration sites that need one. */
  version?: string | undefined;
}

/**
 * Provider-supplied metadata that tells Weft which workflow signal should
 * resume a paused chat turn. Providers may attach provider-specific state
 * that round-trips through durable suspension.
 *
 * @example
 * ```ts
 * import type { ChatResumeHint } from 'weft';
 *
 * const hint: ChatResumeHint = {
 *   resumeToken: 'llm-ready-token',
 *   state: { requestId: 'req-123' },
 * };
 * ```
 */
export interface ChatResumeHint {
  resumeToken: string;
  state?: unknown;
}

/**
 * Resume payload delivered back to the provider after a matching workflow
 * signal arrives. The original {@link ChatResumeHint} is preserved
 * alongside the signal payload so providers can correlate the resumed
 * request.
 *
 * @example
 * ```ts
 * import type { ChatResumeContext } from 'weft';
 *
 * const resumeContext: ChatResumeContext = {
 *   hint: { resumeToken: 'llm-ready-token' },
 *   payload: { approved: true },
 * };
 * ```
 */
export interface ChatResumeContext {
  hint: ChatResumeHint;
  payload: unknown;
}

/**
 * Token consumption summary returned inside {@link ChatResponse.usage}.
 * Produced by providers; callers read it but do not construct it.
 *
 * @example
 * ```ts
 * import type { TokenUsage } from 'weft';
 *
 * function totalTokens(usage: TokenUsage): number {
 *   return usage.totalTokens;
 * }
 * ```
 */
export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
}

/**
 * Per-call options passed to {@link LLMProvider.chat}. Specifies the model
 * identifier, optional tool list, max output tokens, sampling
 * temperature, abort signal, and per-call system prompt.
 *
 * @example
 * ```ts
 * import type { ChatOptions } from 'weft';
 *
 * const options: ChatOptions = {
 *   model: 'claude-sonnet-4-5',
 *   maxTokens: 2048,
 *   temperature: 0.7,
 * };
 * ```
 */
export interface ChatOptions {
  model: string;
  tools?: ToolDescriptor[];
  maxTokens?: number;
  temperature?: number;
  signal?: AbortSignal;
  systemPrompt?: string;
  turnIndex?: number;
  resumeContext?: ChatResumeContext;
}

/**
 * Normalized response shape returned by {@link LLMProvider.chat}. Contains
 * the generated text, any tool calls the model requested, cumulative
 * token usage, the model id that served the request, the stop reason,
 * and an optional reasoning trace.
 *
 * @example
 * ```ts
 * import type { ChatResponse } from 'weft';
 *
 * const response: ChatResponse = {
 *   content: 'Hello',
 *   toolCalls: [],
 *   usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
 *   model: 'claude-sonnet-4-5',
 *   stopReason: 'end_turn',
 * };
 * ```
 */
export interface ChatResponse {
  content: string;
  toolCalls: ToolCallInput[];
  usage: TokenUsage;
  model: string;
  stopReason: 'end_turn' | 'tool_use' | 'max_tokens' | 'stop_sequence';
  reasoningTrace?: string | undefined;
}

/**
 * Provider response after Weft has materialized tool calls.
 *
 * @example
 * ```ts
 * import type { NormalizedChatResponse } from 'weft';
 *
 * const response: NormalizedChatResponse = {
 *   content: '',
 *   toolCalls: [{ id: 'call-1', name: 'get_time', arguments: {} }],
 *   usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
 *   model: 'test-model',
 *   stopReason: 'tool_use',
 * };
 * ```
 */
export interface NormalizedChatResponse extends Omit<ChatResponse, 'toolCalls'> {
  toolCalls: ToolCall[];
}

/**
 * The normalized provider interface that executeAgentLoop depends on.
 * Bring your own provider - Weft does not ship built-in providers.
 *
 * Required: chat(). Optional: createChatResumeHint(), warmup().
 * No stream(), no countTokens() - those are not durability-shaped.
 *
 * @example Minimal stub provider for testing
 * ```ts
 * import type { LLMProvider } from 'weft';
 *
 * const stubProvider: LLMProvider = {
 *   name: 'stub',
 *   async chat(_messages, _options) {
 *     return {
 *       content: 'Hello',
 *       toolCalls: [],
 *       usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
 *       model: 'stub-1.0',
 *       stopReason: 'end_turn',
 *     };
 *   },
 * };
 * ```
 */
export interface LLMProvider {
  readonly name: string;
  chat(messages: Message[], options: ChatOptions): Promise<ChatResponse>;
  createChatResumeHint?(
    messages: Message[],
    options: ChatOptions,
  ): Promise<ChatResumeHint | undefined>;
  warmup?(): Promise<void>;
}

// ---------------------------------------------------------------------------
// Agent types
// ---------------------------------------------------------------------------

/**
 * A locally-defined tool that the agent loop can call.
 *
 * @example Define a tool that returns the current time
 * ```ts
 * import type { AgentTool } from 'weft';
 *
 * const timeTool: AgentTool = {
 *   name: 'get_current_time',
 *   description: 'Returns current UTC time.',
 *   input: { type: 'object', properties: {} },
 *   execute: async () => new Date().toISOString(),
 * };
 * ```
 */
export interface AgentTool {
  name: ToolDefinition['name'];
  description?: ToolDefinition['description'];
  input: ToolDefinition['input'];
  execute: ToolDefinition['execute'];
  verify?: ToolDefinition['verify'];
  identity?: ToolDefinition['identity'];
  version?: ToolDefinition['version'];
}

/**
 * Sink that records Promise<void> verifications produced by tool execution.
 *
 * @example
 * ```ts
 * import type { VerificationRecorder } from 'weft';
 *
 * const verifications: Array<Promise<void>> = [];
 * const recorder: VerificationRecorder = {
 *   recordVerification(promise) { verifications.push(promise); },
 * };
 * ```
 */
export interface VerificationRecorder {
  recordVerification(verification: Promise<void>): void;
}

/**
 * Per-turn token usage entry in {@link AgentResult.turnUsage}. Exactly one
 * entry per completed turn. The discriminator narrows the token fields:
 * `source: 'provider'` carries numeric token counts; `source:
 * 'unavailable'` carries `null` token counts (the provider did not
 * report usage).
 *
 * The built-in `executeAgentLoop` always emits `source: 'provider'`
 * because `LLMProvider.chat` returns a required `TokenUsage` block. The
 * `'unavailable'` variant exists for downstream consumers that wrap the
 * loop or extend the result shape — for example, a wrapper that aggregates
 * usage across providers where some providers omit token counts. Consumers
 * should always check the discriminator before reading the token fields.
 *
 * @example Sum input tokens across the run, ignoring unavailable turns
 * ```ts
 * import type { TurnUsageEntry } from 'weft';
 *
 * function totalInputTokens(usage: TurnUsageEntry[]): number {
 *   let total = 0;
 *   for (const entry of usage) {
 *     if (entry.source === 'provider') total += entry.inputTokens;
 *   }
 *   return total;
 * }
 * ```
 */
export type TurnUsageEntry =
  | {
      /** Zero-based, monotonic across the loop including resumed turns. */
      turnNumber: number;
      source: 'provider';
      inputTokens: number;
      outputTokens: number;
    }
  | {
      /** Zero-based, monotonic across the loop including resumed turns. */
      turnNumber: number;
      source: 'unavailable';
      inputTokens: null;
      outputTokens: null;
    };

/**
 * Configuration object passed to executeAgentLoop.
 *
 * @example Basic agent options
 * ```ts
 * import type { AgentOptions, LLMProvider } from 'weft';
 *
 * declare const provider: LLMProvider;
 *
 * const options: AgentOptions = {
 *   model: 'claude-sonnet-4-5',
 *   provider,
 *   systemPrompt: 'You are a helpful assistant.',
 *   maxTurns: 8,
 * };
 * ```
 */
export interface AgentOptions {
  model: string;
  provider: LLMProvider;
  systemPrompt?: string | undefined;
  /** Plain flat AgentTool array. */
  tools?: AgentTool[] | undefined;
  /** Maximum number of LLM turns before returning. Defaults to 10. */
  maxTurns?: number | undefined;
  signal?: AbortSignal | undefined;
  eventTarget?: EventTarget | undefined;
  workflowId?: string | undefined;
  agentId?: string | undefined;
  /**
   * Durable tool effect log for deduplicating tool calls across
   * checkpoint-restore cycles.
   */
  toolEffectLog?: ToolEffectLogLike | undefined;
  /**
   * Internal hook used by speculative execution to defer tool-result
   * verification until the enclosing speculative branch drains.
   */
  verificationRecorder?: VerificationRecorder | undefined;
  /**
   * Conversation size in bytes at which an AgentCheckpointSizeWarningEvent
   * is dispatched. Defaults to 65536 (64 KB).
   */
  checkpointSizeWarningThreshold?: number | undefined;
}

/** Resolved (defaults filled in) form of AgentOptions. */
export interface ResolvedAgentOptions {
  defaultModel: string;
  provider: LLMProvider;
  systemPrompt?: string | undefined;
  maxTurns: number;
  signal?: AbortSignal | undefined;
  eventTarget?: EventTarget | undefined;
  workflowId: string;
  agentId: string;
  toolEffectLog?: ToolEffectLogLike | undefined;
  verificationRecorder?: VerificationRecorder | undefined;
  checkpointSizeWarningThreshold: number;
}

/** Runtime state of the agent loop. */
export interface AgentLoopState {
  conversation: Message[];
  totalTokens: TokenUsage;
  turnCount: number;
  lastContent: string;
  sizeWarningFired: boolean;
  reasoningTraces: string[];
  turnUsage: TurnUsageEntry[];
}

/**
 * Snapshot of an agent loop's runtime state, suitable for durable persistence.
 *
 * @example
 * ```ts
 * import type { PersistedAgentLoopState } from 'weft';
 *
 * function isFinalState(state: PersistedAgentLoopState): boolean {
 *   return state.turnCount > 0 && state.lastContent !== null;
 * }
 * ```
 */
export interface PersistedAgentLoopState {
  schemaVersion: 2;
  conversation: Message[];
  totalTokens: TokenUsage;
  turnCount: number;
  lastContent: string | null;
  sizeWarningFired: boolean;
  agentId: string;
  workflowId: string;
  reasoningTraces: string[];
  turnUsage: TurnUsageEntry[];
  pendingProviderResume?: PendingProviderResumeState | undefined;
}

/**
 * State of a pending provider resume that the agent loop is waiting on.
 *
 * @example
 * ```ts
 * import type { PendingProviderResumeState } from 'weft';
 *
 * function describe(state: PendingProviderResumeState): string {
 *   return state.resumed ? `resumed at turn ${state.turnIndex}` : `awaiting turn ${state.turnIndex}`;
 * }
 * ```
 */
export type PendingProviderResumeState =
  | {
      turnIndex: number;
      hint: ChatResumeHint;
      resumed: false;
    }
  | {
      turnIndex: number;
      hint: ChatResumeHint;
      resumed: true;
      payload: unknown;
    };

/**
 * Thrown by the agent loop when it must suspend before the next provider fetch.
 *
 * @example
 * ```ts
 * import { AgentLoopSuspendedError } from 'weft';
 *
 * function turnOfSuspension(error: unknown): number | null {
 *   if (error instanceof AgentLoopSuspendedError) {
 *     return error.pendingResume.turnIndex;
 *   }
 *   return null;
 * }
 * ```
 */
export class AgentLoopSuspendedError extends Error {
  readonly loopState: PersistedAgentLoopState;
  readonly pendingResume: PendingProviderResumeState;

  constructor(loopState: PersistedAgentLoopState, pendingResume: PendingProviderResumeState) {
    super(`Agent loop suspended before turn ${String(pendingResume.turnIndex)} provider fetch`);
    this.name = 'AgentLoopSuspendedError';
    this.loopState = loopState;
    this.pendingResume = pendingResume;
  }
}

/**
 * Return value of executeAgentLoop. The built-in Weft loop returns a
 * `Message[]` transcript by default; wrappers can widen the conversation
 * generic to return an Agent Bureau conversation history object.
 *
 * @example
 * ```ts
 * import { executeAgentLoop, type AgentResult } from 'weft';
 * import type { LLMProvider } from 'weft';
 *
 * declare const provider: LLMProvider;
 *
 * const result: AgentResult = await executeAgentLoop(
 *   { model: 'claude-sonnet-4-5', provider },
 *   'Explain recursion.',
 * );
 * console.log(result.content);
 * console.log('Messages:', result.conversation.length);
 * ```
 */
export interface AgentResult<TConversation extends ConversationHistory = Message[]> {
  content: string;
  conversation: TConversation;
  totalTokens: TokenUsage;
  turnCount: number;
  reasoningTraces: string[];
  turnUsage: TurnUsageEntry[];
}

/** Internal runtime bundle used by the agent loop. */
export interface AgentRuntime {
  options: ResolvedAgentOptions;
  toolMap: Map<string, import('./tool-initialization.ts').RegistryToolEntry>;
  toolDefinitions: ToolDescriptor[];
  state: AgentLoopState;
  dispose: () => void;
}

/** Metadata returned after one provider chat turn. */
export interface ChatTurnResult {
  response: NormalizedChatResponse;
  /** The model the loop requested (always equal to options.model post-shrinkage; kept for caller event payloads). */
  originalModel: string;
  turnDuration: number;
}

/** Normalized result of executing one tool call. */
export interface ToolExecutionOutcome {
  content: JSONValue;
  success: boolean;
  error?: ToolErrorShape | undefined;
}
