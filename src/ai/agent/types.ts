/* oxlint-disable max-lines -- ID:ai-agent-types-file-length */
import type { ToolIdentityResult } from '../declaration.ts';
import type { ToolEffectLogLike } from '../tool-effect-log.ts';

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
 * A model-requested tool invocation. Pairs a stable `id` with the tool
 * `name` and the model-supplied `input` payload.
 *
 * @example
 * ```ts
 * import type { ToolCall } from 'weft';
 *
 * const call: ToolCall = { id: 'call-1', name: 'get_time', input: {} };
 * ```
 */
export interface ToolCall {
  id: string;
  name: string;
  input: unknown;
}

/**
 * A normalized tool result sent back into the conversation. `toolCallId`
 * matches the originating {@link ToolCall.id}; `isError` flags an error
 * outcome the model should see.
 *
 * @example
 * ```ts
 * import type { ToolResult } from 'weft';
 *
 * const result: ToolResult = { toolCallId: 'call-1', output: '12:34Z' };
 * ```
 */
export interface ToolResult {
  toolCallId: string;
  output: string;
  isError?: boolean;
}

/**
 * Schema descriptor for a callable tool. Consumed by {@link LLMProvider}
 * implementations to advertise tools to the model. `inputSchema` follows
 * JSON Schema Draft 7 conventions; tools with no parameters use
 * `{ type: 'object' }`.
 *
 * @example
 * ```ts
 * import type { ToolDefinition } from 'weft';
 *
 * const search: ToolDefinition = {
 *   name: 'web_search',
 *   description: 'Search the web for recent information.',
 *   inputSchema: {
 *     type: 'object',
 *     required: ['query'],
 *     properties: { query: { type: 'string' } },
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
  tools?: ToolDefinition[];
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
  toolCalls: ToolCall[];
  usage: TokenUsage;
  model: string;
  stopReason: 'end_turn' | 'tool_use' | 'max_tokens' | 'stop_sequence';
  reasoningTrace?: string | undefined;
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
 *   definition: {
 *     name: 'get_current_time',
 *     description: 'Returns current UTC time.',
 *     inputSchema: { type: 'object', properties: {} },
 *   },
 *   execute: async () => new Date().toISOString(),
 * };
 * ```
 */
export interface AgentTool {
  definition: ToolDefinition;
  execute: (input: unknown) => Promise<unknown>;
  verify?: (result: unknown) => Promise<boolean> | boolean;
  /** Optional semantic identity for idempotent tool-call deduplication. */
  identity?: (input: unknown) => ToolIdentityResult;
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
  /** Plain AgentTool array. */
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
 * Return value of executeAgentLoop.
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
 * console.log('Turns:', result.turnCount);
 * ```
 */
export interface AgentResult {
  content: string;
  conversation: Message[];
  totalTokens: TokenUsage;
  turnCount: number;
  reasoningTraces: string[];
  turnUsage: TurnUsageEntry[];
}

/** Internal runtime bundle used by the agent loop. */
export interface AgentRuntime {
  options: ResolvedAgentOptions;
  toolMap: Map<string, import('./tool-initialization.ts').RegistryToolEntry>;
  toolDefinitions: ToolDefinition[];
  state: AgentLoopState;
  dispose: () => void;
}

/** Metadata returned after one provider chat turn. */
export interface ChatTurnResult {
  response: ChatResponse;
  currentModel: string;
  originalModel: string;
  fallbackAttempts: number;
  turnDuration: number;
}

/** Normalized result of executing one tool call. */
export interface ToolExecutionOutcome {
  output: string;
  success: boolean;
}
