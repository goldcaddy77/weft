import type { BudgetTracker, SerializedBudgetState } from '../budget.ts';
import type { ContextWindowManager } from '../context-window.ts';
import type { ToolIdentityResult } from '../declaration.ts';
import type { AgentHooks } from '../hooks.ts';
import type { MCPAuthConfig } from '../mcp/authentication.ts';
import type { RegistryTool } from '../mcp/registry.ts';
import type { TransportKind } from '../mcp/transport.ts';
import type { ModelRouter } from '../model-router.ts';
import type { ProviderHealthTracker } from '../provider-health.ts';
import type { LLMProvider } from '../providers/interface.ts';
import type { ChatResponse, Message, TokenUsage, ToolDefinition } from '../providers/types.ts';
import type { CacheEntry } from '../tool-cache.ts';
import type { ToolEffectLogLike } from '../tool-effect-log.ts';

/**
 * An MCP server URL to discover tools from at agent initialization.
 *
 * @example Connect an HTTP MCP server with bearer auth
 * ```ts
 * import { executeAgentLoop, type MCPToolSource } from 'weft';
 * import type { LLMProvider } from 'weft';
 *
 * declare const provider: LLMProvider;
 *
 * const source: MCPToolSource = {
 *   mcp: 'https://tools.example.com/mcp',
 *   auth: { type: 'bearer', token: process.env['MCP_TOKEN'] ?? '' },
 *   timeout: 10_000,
 * };
 *
 * const result = await executeAgentLoop(
 *   { model: 'claude-sonnet-4-5', provider, tools: [source] },
 *   'What tools are available?',
 * );
 * ```
 */
export interface MCPToolSource {
  mcp: string;
  auth?: MCPAuthConfig | undefined;
  timeout?: number | undefined;
  /**
   * Override transport auto-detection.
   * - `'http'` (default for `http(s)://` URLs): plain HTTP request/response
   * - `'sse'`: HTTP POST for requests, Server-Sent Events for responses
   * - `'stdio'` (default for `stdio://` URLs): JSON-RPC over child process stdin/stdout
   */
  transport?: TransportKind | undefined;
}

/**
 * Configuration object passed to {@link executeAgentLoop}. Controls the model,
 * provider, tool list, budget, turn limit, context management, and observability
 * hooks for a single agent invocation.
 *
 * `toolEffectLog` deduplicates tool calls across checkpoint restores.
 * `toolCacheTTL`, `toolCacheMaxSize`, and `checkpointSizeWarningThreshold`
 * tune in-memory caching and conversation-size warnings.
 *
 * @example Run a tool-calling agent with a cost budget
 * ```ts
 * import { executeAgentLoop, BudgetTracker, type AgentOptions } from 'weft';
 * import type { LLMProvider } from 'weft';
 *
 * declare const provider: LLMProvider;
 *
 * const options: AgentOptions = {
 *   model: 'claude-sonnet-4-5',
 *   provider,
 *   systemPrompt: 'You are a helpful assistant.',
 *   maxTurns: 8,
 *   budget: new BudgetTracker({
 *     maxCost: 0.25,
 *     models: { 'claude-sonnet-4-5': { inputCostPer1K: 0.003, outputCostPer1K: 0.015 } },
 *   }),
 * };
 *
 * const result = await executeAgentLoop(options, 'Summarize the latest news.');
 * console.log(result.content);
 * ```
 */
export interface AgentOptions {
  model: string;
  provider: LLMProvider;
  systemPrompt?: string | undefined;
  tools?: (AgentTool | MCPToolSource)[] | undefined;
  /** Maximum number of LLM turns before returning. Defaults to 10. */
  maxTurns?: number | undefined;
  budget?: BudgetTracker | undefined;
  modelRouter?: ModelRouter | undefined;
  contextManager?: ContextWindowManager | undefined;
  healthTracker?: ProviderHealthTracker | undefined;
  /** Tool result cache TTL in milliseconds. Defaults to 300 000 (5 minutes). */
  toolCacheTTL?: number | undefined;
  /**
   * Maximum number of tool result cache entries. When the cache grows past
   * this cap, the oldest entry (by insertion order) is evicted to make room.
   * Defaults to 1000.
   */
  toolCacheMaxSize?: number | undefined;
  signal?: AbortSignal | undefined;
  hooks?: AgentHooks | undefined;
  eventTarget?: EventTarget | undefined;
  workflowId?: string | undefined;
  agentId?: string | undefined;
  onTurnStarted?: ((turn: TurnInfo) => void) | undefined;
  onTurnCompleted?: ((turn: TurnResult) => void) | undefined;
  onToolCalled?: ((call: ToolCallInfo) => void) | undefined;
  onToolReturned?: ((result: ToolReturnInfo) => void) | undefined;
  /**
   * Conversation size in bytes at which an `AgentCheckpointSizeWarningEvent`
   * is dispatched via the eventTarget. Defaults to 65 536 (64 KB).
   */
  checkpointSizeWarningThreshold?: number | undefined;
  /**
   * Durable tool effect log for deduplicating tool calls across
   * checkpoint-restore cycles. When provided, the agent loop consults the log
   * before each tool execution and short-circuits on committed matches.
   */
  toolEffectLog?: ToolEffectLogLike | undefined;
  /**
   * Internal hook used by speculative execution to defer tool-result
   * verification until the enclosing speculative branch drains.
   */
  verificationRecorder?: VerificationRecorder | undefined;
}

/**
 * A locally-defined tool that the agent loop can call during a conversation.
 * Pairs a {@link ToolDefinition} (name, description, and JSON Schema) with an
 * async `execute` function, plus optional `verify` and semantic `identity` callbacks.
 *
 * @example Define a tool that fetches the current UTC time
 * ```ts
 * import type { AgentTool } from 'weft';
 *
 * const currentTimeTool: AgentTool = {
 *   definition: {
 *     name: 'get_current_time',
 *     description: 'Returns the current UTC time as an ISO 8601 string.',
 *     inputSchema: { type: 'object', properties: {} },
 *   },
 *   execute: async (_input: unknown) => new Date().toISOString(),
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
 * Sink that records `Promise<void>` verifications produced by tool execution.
 *
 * The agent runtime uses this to track in-flight verification work that must
 * settle before the agent loop returns its final result. Pass an implementation
 * to `executeAgentLoop` via `AgentOptions.verificationRecorder` to opt into
 * verification tracking.
 *
 * @example
 * ```ts
 * import { type VerificationRecorder } from 'weft';
 *
 * const verifications: Array<Promise<void>> = [];
 * const recorder: VerificationRecorder = {
 *   recordVerification(promise) {
 *     verifications.push(promise);
 *   },
 * };
 * ```
 */
export interface VerificationRecorder {
  recordVerification(verification: Promise<void>): void;
}

export interface TurnInfo {
  turnIndex: number;
  model: string;
  conversationLength: number;
}

export interface TurnResult {
  turnIndex: number;
  model: string;
  inputTokens: number;
  outputTokens: number;
  cost: number;
  duration: number;
  toolCallCount: number;
}

export interface ToolCallInfo {
  turnIndex: number;
  toolName: string;
  toolInput: unknown;
}

export interface ToolReturnInfo {
  turnIndex: number;
  toolName: string;
  duration: number;
  success: boolean;
}

/**
 * Per-turn cost breakdown returned in `AgentResult.turnCosts`. `tools` is an
 * array of tool *names* invoked during this turn (not the calls themselves).
 * `model` is the model that actually responded, which may differ from the
 * requested model when a `ModelRouter` fallback fired.
 */
export interface TurnCostEntry {
  turn: number;
  inputTokens: number;
  outputTokens: number;
  cost: number;
  model: string;
  tools: string[];
}

/**
 * Return value of {@link executeAgentLoop}. Contains the final text response,
 * the full normalized conversation history, cumulative token usage, per-turn
 * cost breakdown, and any reasoning traces captured from the provider.
 * The optional `confidence` field is reserved for provider-surfaced confidence
 * scores and is currently always `undefined` — `buildAgentResult` does not
 * populate it.
 *
 * @example Inspect costs and reasoning after an agent run
 * ```ts
 * import { executeAgentLoop, type AgentResult } from 'weft';
 * import type { LLMProvider } from 'weft';
 *
 * declare const provider: LLMProvider;
 *
 * const result: AgentResult = await executeAgentLoop(
 *   { model: 'claude-sonnet-4-5', provider },
 *   'Explain recursion in one sentence.',
 * );
 *
 * console.log(result.content);
 * console.log('Total cost:', result.totalCost);
 * console.log('Turns:', result.turnCount);
 * result.turnCosts.forEach((t) => console.log(`Turn ${t.turn}: ${t.cost.toFixed(4)}`));
 * ```
 */
export interface AgentResult {
  content: string;
  conversation: Message[];
  totalTokens: TokenUsage;
  totalCost: number;
  turnCount: number;
  /** Reasoning/thinking traces captured from each turn's provider response. */
  reasoningTraces: string[];
  /** Per-turn cost breakdown with token counts, model, and tools used. */
  turnCosts: TurnCostEntry[];
  /**
   * Confidence score surfaced by the provider, if available.
   * A value in [0, 1] where higher means more confident.
   * `undefined` when the provider does not surface a confidence value.
   */
  confidence?: number | undefined;
}

export interface ResolvedAgentOptions {
  defaultModel: string;
  provider: LLMProvider;
  systemPrompt?: string | undefined;
  maxTurns: number;
  budget?: BudgetTracker | undefined;
  modelRouter?: ModelRouter | undefined;
  contextManager?: ContextWindowManager | undefined;
  healthTracker?: ProviderHealthTracker | undefined;
  toolCacheTTL: number;
  toolCacheMaxSize: number;
  signal?: AbortSignal | undefined;
  hooks?: AgentHooks | undefined;
  eventTarget?: EventTarget | undefined;
  workflowId: string;
  agentId: string;
  onTurnStarted?: ((turn: TurnInfo) => void) | undefined;
  onTurnCompleted?: ((turn: TurnResult) => void) | undefined;
  onToolCalled?: ((call: ToolCallInfo) => void) | undefined;
  onToolReturned?: ((result: ToolReturnInfo) => void) | undefined;
  checkpointSizeWarningThreshold: number;
  toolEffectLog?: ToolEffectLogLike | undefined;
  verificationRecorder?: VerificationRecorder | undefined;
}

export interface AgentLoopState {
  conversation: Message[];
  toolCache: Map<string, CacheEntry>;
  totalTokens: TokenUsage;
  totalCost: number;
  turnCount: number;
  lastContent: string;
  sizeWarningFired: boolean;
  budgetWarningFired: boolean;
  previousModels: string[];
  reasoningTraces: string[];
  turnCosts: TurnCostEntry[];
}

/**
 * Snapshot of an agent loop's runtime state, suitable for durable persistence
 * and later resumption.
 *
 * The engine captures this when an agent operation suspends (e.g. on a provider
 * resume hint), writes it to storage, and rehydrates it when the workflow
 * resumes. Workflow authors typically don't construct this directly — it's
 * produced by `snapshotAgentLoopState` and consumed by `executeAgentLoopWithState`.
 *
 * @example
 * ```ts
 * import { type PersistedAgentLoopState } from 'weft';
 *
 * function isFinalState(state: PersistedAgentLoopState): boolean {
 *   return state.turnCount > 0 && state.lastContent.length > 0;
 * }
 * ```
 */
export interface PersistedAgentLoopState {
  conversation: Message[];
  toolCacheEntries: Array<[string, CacheEntry]>;
  totalTokens: TokenUsage;
  totalCost: number;
  turnCount: number;
  lastContent: string;
  sizeWarningFired: boolean;
  budgetWarningFired: boolean;
  previousModels: string[];
  reasoningTraces: string[];
  turnCosts: TurnCostEntry[];
  budgetState?: SerializedBudgetState | undefined;
}

/**
 * State of a pending provider resume that the agent loop is waiting on.
 *
 * When `resumed: false`, the agent has not yet received the resume payload.
 * When `resumed: true`, the payload is attached and the loop is ready to
 * continue. The `turnIndex` field anchors the resume to a specific turn so
 * out-of-order resumes are detectable.
 *
 * @example
 * ```ts
 * import { type PendingProviderResumeState } from 'weft';
 *
 * function describe(state: PendingProviderResumeState): string {
 *   return state.resumed ? `resumed at turn ${state.turnIndex}` : `awaiting turn ${state.turnIndex}`;
 * }
 * ```
 */
export type PendingProviderResumeState =
  | {
      turnIndex: number;
      hint: import('../providers/types.ts').ChatResumeHint;
      resumed: false;
    }
  | {
      turnIndex: number;
      hint: import('../providers/types.ts').ChatResumeHint;
      resumed: true;
      payload: unknown;
    };

/**
 * Thrown by the agent loop when it must suspend before the next provider fetch.
 *
 * The engine catches this error inside the agent operation, persists the
 * attached `loopState` and `pendingResume`, and parks the workflow until the
 * external resume signal arrives. Workflow authors typically don't catch this
 * directly — it flows through the engine's suspension machinery.
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

export interface AgentRuntime {
  options: ResolvedAgentOptions;
  toolMap: Map<string, RegistryTool>;
  toolDefinitions: ToolDefinition[];
  state: AgentLoopState;
  /** Dispose MCP transports and their child processes/connections. */
  dispose: () => void;
}

export type PreparedTurn = ActiveTurn | SkippedTurn;

export interface ActiveTurn {
  currentModel: string;
  originalModel: string;
  fallbackModels: string[];
  messagesToSend: Message[];
  turnStart: number;
  costBefore: number;
}

export interface SkippedTurn {
  skippedResult: string;
}

export interface ChatTurnResult {
  response: ChatResponse;
  currentModel: string;
  originalModel: string;
  fallbackAttempts: number;
  turnCost: number;
  turnDuration: number;
}

export interface ToolExecutionOutcome {
  output: string;
  success: boolean;
}
