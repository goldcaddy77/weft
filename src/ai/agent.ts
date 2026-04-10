/**
 * Durable ReAct agent loop with tool caching and budget enforcement.
 *
 * Orchestrates multi-turn LLM conversations where the model can invoke
 * tools, receive their results, and continue reasoning until it produces
 * a final answer or an exit condition is reached.
 *
 * @module agent
 */

import type { BudgetTracker } from './budget';
import { BudgetExceededError } from './budget';
import type { ContextWindowManager } from './context-window';
import type { ToolIdentityResult } from './declaration';
import { snapshotConversationForEvent } from './event-message-snapshot';
import {
  AgentCheckpointResumedEvent,
  AgentCheckpointSizeWarningEvent,
  AgentContextCompactedEvent,
  AgentModelFallbackEvent,
  AgentToolCalledEvent,
  AgentToolReturnedEvent,
  AgentTurnCompletedEvent,
  AgentTurnStartedEvent,
} from './events';
import type { AgentHooks } from './hooks';
import type { MCPAuthConfig } from './mcp/authentication';
import { MCPClient, MCPServerUnavailableError } from './mcp/client';
import type { RegistryTool } from './mcp/registry';
import { ToolRegistry } from './mcp/registry';
import { ToolSchemaValidationError, validateSchema } from './mcp/schema-validator';
import type { TransportKind } from './mcp/transport';
import { createTransportForSource } from './mcp/transport-factory';
import type { ModelRouter, RoutingContext } from './model-router';
import type { ProviderHealthTracker } from './provider-health';
import type { LLMProvider } from './providers/interface';
import type {
  ChatResponse,
  Message,
  TokenUsage,
  ToolCall,
  ToolDefinition,
  ToolResult,
} from './providers/types';
import type { CacheEntry } from './tool-cache';
import {
  setToolCacheEntry,
  sweepExpiredCacheEntries,
  TOOL_CACHE_SWEEP_THRESHOLD,
} from './tool-cache';
import type { ToolEffectLog } from './tool-effect-log';
import { computeSemanticHash, ToolCallReplayConflictError } from './tool-effect-log';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** An MCP server URL to discover tools from at agent initialization. */
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

/** Type guard: is the tools entry an MCP server URL source? */
function isMCPToolSource(entry: AgentTool | MCPToolSource): entry is MCPToolSource {
  return 'mcp' in entry && typeof entry.mcp === 'string';
}

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
  toolEffectLog?: ToolEffectLog | undefined;
  /**
   * Internal hook used by speculative execution to defer tool-result
   * verification until the enclosing speculative branch drains.
   */
  verificationRecorder?: VerificationRecorder | undefined;
}

export interface AgentTool {
  definition: ToolDefinition;
  execute: (input: unknown) => Promise<unknown>;
  verify?: (result: unknown) => Promise<boolean> | boolean;
  /** See {@link AgentToolDefinition.identity}. */
  identity?: (input: unknown) => ToolIdentityResult;
}

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

/** Per-turn cost breakdown entry returned as part of the agent result. */
export interface TurnCostEntry {
  turn: number;
  inputTokens: number;
  outputTokens: number;
  cost: number;
  model: string;
  tools: string[];
}

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

interface ResolvedAgentOptions {
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
  toolEffectLog?: ToolEffectLog | undefined;
  verificationRecorder?: VerificationRecorder | undefined;
}

interface AgentLoopState {
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

interface AgentRuntime {
  options: ResolvedAgentOptions;
  toolMap: Map<string, RegistryTool>;
  toolDefinitions: ToolDefinition[];
  state: AgentLoopState;
  /** Dispose MCP transports and their child processes/connections. */
  dispose: () => void;
}

type PreparedTurn = ActiveTurn | SkippedTurn;

interface ActiveTurn {
  currentModel: string;
  originalModel: string;
  fallbackModels: string[];
  messagesToSend: Message[];
  turnStart: number;
  costBefore: number;
}

interface SkippedTurn {
  skippedResult: string;
}

interface ChatTurnResult {
  response: ChatResponse;
  currentModel: string;
  originalModel: string;
  fallbackAttempts: number;
  turnCost: number;
  turnDuration: number;
}

interface ToolExecutionOutcome {
  output: string;
  success: boolean;
}

// ---------------------------------------------------------------------------
// Tool result cache
// ---------------------------------------------------------------------------

function buildCacheKey(toolName: string, input: unknown): string {
  return `${toolName}:${JSON.stringify(input)}`;
}

/**
 * Estimate the serialized size of a conversation in bytes.
 * Uses JSON.stringify as a reasonable approximation of the size
 * the conversation would occupy in a checkpoint blob.
 */
function estimateConversationSizeBytes(conversation: Message[]): number {
  return new TextEncoder().encode(JSON.stringify(conversation)).byteLength;
}

// ---------------------------------------------------------------------------
// Tool initialization
// ---------------------------------------------------------------------------

type InitializeToolsResult = {
  registry: ToolRegistry;
  /** Dispose all MCP clients and their underlying transports. */
  dispose: () => void;
};

/**
 * Factory that constructs an MCP client for a given tool source. Injectable
 * so tests can substitute a stub that records lifecycle calls.
 *
 * @internal
 */
export type MCPClientFactory = (source: MCPToolSource) => MCPClient;

const defaultMCPClientFactory: MCPClientFactory = (source) => {
  const transport = createTransportForSource(source);
  return new MCPClient({ transport, timeout: source.timeout });
};

/**
 * Process a mixed tools array (local `AgentTool` + `MCPToolSource` entries).
 *
 * For each MCP source: health check, discover tools, register in the registry.
 * For each local tool: register in the registry.
 * Finally, validate for name conflicts and return the populated registry.
 *
 * @internal
 */
export async function initializeTools(
  tools: (AgentTool | MCPToolSource)[],
  signal?: AbortSignal,
  createClient: MCPClientFactory = defaultMCPClientFactory,
): Promise<InitializeToolsResult> {
  const registry = new ToolRegistry();
  const clients: MCPClient[] = [];

  try {
    for (const entry of tools) {
      signal?.throwIfAborted();
      if (isMCPToolSource(entry)) {
        const client = createClient(entry);
        clients.push(client);

        // Health check — fail fast if the server is unreachable
        const healthy = await client.healthCheck();
        if (!healthy) {
          throw new MCPServerUnavailableError(entry.mcp);
        }

        // Discover tools
        const discovered = await client.discoverTools();

        // Pre-index discovered tools by name for O(1) schema lookup
        const schemaIndex = new Map(discovered.map((t) => [t.name, t]));

        // Register MCP tools with a dispatch function that validates input
        // and invokes through the client
        registry.registerMCP(discovered, entry.mcp, async (toolName: string, input: unknown) => {
          const toolDef = schemaIndex.get(toolName);
          if (toolDef && Object.keys(toolDef.inputSchema).length > 0) {
            const validation = validateSchema(input, toolDef.inputSchema);
            if (!validation.valid) {
              throw new ToolSchemaValidationError(toolName, validation.errors);
            }
          }

          return client.invokeTool(toolName, input, signal);
        });
      } else {
        registry.registerLocal(entry.definition, entry.execute, entry.identity, entry.verify);
      }
    }

    // Validate for name conflicts before the agent loop starts. Must stay
    // inside the try block so that a ToolNameConflictError (or any other
    // validation failure) triggers the catch-block disposal of already-
    // created MCP clients.
    registry.validate();
  } catch (error) {
    // Dispose all clients on any initialization failure
    for (const client of clients) client[Symbol.dispose]();
    throw error;
  }

  const dispose = () => {
    for (const client of clients) client[Symbol.dispose]();
  };

  return { registry, dispose };
}

// ---------------------------------------------------------------------------
// executeAgentLoop
// ---------------------------------------------------------------------------

function resolveAgentOptions(options: AgentOptions): ResolvedAgentOptions {
  return {
    defaultModel: options.model,
    provider: options.provider,
    systemPrompt: options.systemPrompt,
    maxTurns: options.maxTurns ?? 10,
    budget: options.budget,
    modelRouter: options.modelRouter,
    contextManager: options.contextManager,
    healthTracker: options.healthTracker,
    toolCacheTTL: options.toolCacheTTL ?? 300_000,
    toolCacheMaxSize: options.toolCacheMaxSize ?? 1000,
    signal: options.signal,
    hooks: options.hooks,
    eventTarget: options.eventTarget,
    workflowId: options.workflowId ?? '',
    agentId: options.agentId ?? '',
    onTurnStarted: options.onTurnStarted,
    onTurnCompleted: options.onTurnCompleted,
    onToolCalled: options.onToolCalled,
    onToolReturned: options.onToolReturned,
    checkpointSizeWarningThreshold: options.checkpointSizeWarningThreshold ?? 65_536,
    toolEffectLog: options.toolEffectLog,
    verificationRecorder: options.verificationRecorder,
  };
}

function createToolLookups(registryTools: RegistryTool[]): {
  toolMap: Map<string, RegistryTool>;
  toolDefinitions: ToolDefinition[];
} {
  const toolMap = new Map<string, RegistryTool>();
  const toolDefinitions: ToolDefinition[] = [];

  for (const tool of registryTools) {
    toolMap.set(tool.definition.name, tool);
    toolDefinitions.push(tool.definition);
  }

  return { toolMap, toolDefinitions };
}

function createInitialConversation(systemPrompt: string | undefined, input: string): Message[] {
  const conversation: Message[] = [];
  if (systemPrompt !== undefined) {
    conversation.push({ role: 'system', content: systemPrompt });
  }
  conversation.push({ role: 'user', content: input });
  return conversation;
}

async function createAgentRuntime(options: AgentOptions, input: string): Promise<AgentRuntime> {
  const resolvedOptions = resolveAgentOptions(options);
  const { registry, dispose } = await initializeTools(options.tools ?? [], resolvedOptions.signal);
  const { toolMap, toolDefinitions } = createToolLookups(registry.getAll());

  return {
    options: resolvedOptions,
    toolMap,
    toolDefinitions,
    dispose,
    state: {
      conversation: createInitialConversation(resolvedOptions.systemPrompt, input),
      toolCache: new Map<string, CacheEntry>(),
      totalTokens: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
      totalCost: 0,
      turnCount: 0,
      lastContent: '',
      sizeWarningFired: false,
      budgetWarningFired: false,
      previousModels: [],
      reasoningTraces: [],
      turnCosts: [],
    },
  };
}

function buildAgentResult(state: AgentLoopState): AgentResult {
  return {
    content: state.lastContent,
    conversation: state.conversation,
    totalTokens: state.totalTokens,
    totalCost: state.totalCost,
    turnCount: state.turnCount,
    reasoningTraces: state.reasoningTraces,
    turnCosts: state.turnCosts,
  };
}

function shouldStopBeforeTurn(runtime: AgentRuntime): boolean {
  if (runtime.options.signal?.aborted) {
    return true;
  }

  if (!runtime.options.budget) {
    return false;
  }

  try {
    runtime.options.budget.checkBudget();
    return false;
  } catch (error: unknown) {
    if (error instanceof BudgetExceededError) {
      return true;
    }
    throw error;
  }
}

function selectModelForTurn(
  runtime: AgentRuntime,
  turnIndex: number,
): { currentModel: string; fallbackModels: string[] } {
  if (!runtime.options.modelRouter) {
    return { currentModel: runtime.options.defaultModel, fallbackModels: [] };
  }

  const budgetRemaining = runtime.options.budget?.budgetRemaining();
  const routingContext: RoutingContext = {
    workflowId: runtime.options.workflowId,
    turnIndex,
    conversationLength: runtime.state.conversation.length,
    budgetRemaining: budgetRemaining
      ? {
          tokensRemaining: budgetRemaining.tokensRemaining,
          costRemaining: budgetRemaining.costRemaining,
        }
      : undefined,
    previousModels: [...runtime.state.previousModels],
  };
  const selection = runtime.options.modelRouter.select(routingContext);
  return {
    currentModel: selection.model,
    fallbackModels: selection.fallback ?? [],
  };
}

async function prepareMessagesForTurn(runtime: AgentRuntime): Promise<Message[]> {
  let messagesToSend = [...runtime.state.conversation];
  if (!runtime.options.contextManager) {
    return messagesToSend;
  }

  const tokenCount = await runtime.options.provider.countTokens(messagesToSend);
  if (!runtime.options.contextManager.shouldCompact(tokenCount)) {
    return messagesToSend;
  }

  const compacted = await runtime.options.contextManager.compact(messagesToSend);
  messagesToSend = compacted.messages;
  if (runtime.options.eventTarget && runtime.options.workflowId) {
    runtime.options.eventTarget.dispatchEvent(
      new AgentContextCompactedEvent(
        runtime.options.workflowId,
        runtime.options.agentId,
        runtime.options.contextManager.strategyName,
        compacted.tokensBefore,
        compacted.tokensAfter,
        compacted.messagesDropped,
      ),
    );
  }

  return messagesToSend;
}

async function applyBeforeTurnHook(
  runtime: AgentRuntime,
  turnIndex: number,
  messagesToSend: Message[],
  model: string,
): Promise<PreparedTurn> {
  if (!runtime.options.hooks?.beforeTurn) {
    return {
      currentModel: model,
      originalModel: model,
      fallbackModels: [],
      messagesToSend,
      turnStart: Date.now(),
      costBefore: runtime.options.budget?.budgetRemaining().costUsed ?? 0,
    };
  }

  const hookResult = await runtime.options.hooks.beforeTurn({
    turnIndex,
    messages: messagesToSend,
    model,
  });

  if (hookResult.action === 'skip') {
    return { skippedResult: hookResult.result ?? '' };
  }

  return {
    currentModel: model,
    originalModel: model,
    fallbackModels: [],
    messagesToSend: hookResult.messages ?? messagesToSend,
    turnStart: Date.now(),
    costBefore: runtime.options.budget?.budgetRemaining().costUsed ?? 0,
  };
}

function dispatchTurnStarted(
  runtime: AgentRuntime,
  turnIndex: number,
  currentModel: string,
  conversationLength: number,
): void {
  if (runtime.options.eventTarget && runtime.options.workflowId) {
    runtime.options.eventTarget.dispatchEvent(
      new AgentTurnStartedEvent(
        runtime.options.workflowId,
        runtime.options.agentId,
        turnIndex,
        currentModel,
        0,
        conversationLength,
      ),
    );
  }

  runtime.options.onTurnStarted?.({
    turnIndex,
    model: currentModel,
    conversationLength,
  });
}

async function prepareTurn(runtime: AgentRuntime, turnIndex: number): Promise<PreparedTurn> {
  const { currentModel, fallbackModels } = selectModelForTurn(runtime, turnIndex);
  const messagesToSend = await prepareMessagesForTurn(runtime);
  const preparedTurn = await applyBeforeTurnHook(runtime, turnIndex, messagesToSend, currentModel);
  if ('skippedResult' in preparedTurn) {
    return preparedTurn;
  }

  preparedTurn.fallbackModels = fallbackModels;
  dispatchTurnStarted(runtime, turnIndex, currentModel, preparedTurn.messagesToSend.length);
  return preparedTurn;
}

function createChatOptions(
  runtime: AgentRuntime,
  model: string,
): import('./providers/interface').ChatOptions {
  const chatOptions: import('./providers/interface').ChatOptions = { model };
  if (runtime.toolDefinitions.length > 0) {
    chatOptions.tools = runtime.toolDefinitions;
  }
  if (runtime.options.signal) {
    chatOptions.signal = runtime.options.signal;
  }
  return chatOptions;
}

function isAbortError(signal: AbortSignal | undefined, error: unknown): boolean {
  return signal?.aborted === true || (error instanceof DOMException && error.name === 'AbortError');
}

function dispatchFallbackEvent(
  runtime: AgentRuntime,
  turnIndex: number,
  attemptModel: string,
  nextModel: string,
  fallbackAttempts: number,
  error: unknown,
): void {
  if (!(runtime.options.eventTarget && runtime.options.workflowId)) {
    return;
  }

  const reason = error instanceof Error ? error.message : String(error);
  runtime.options.eventTarget.dispatchEvent(
    new AgentModelFallbackEvent(
      runtime.options.workflowId,
      runtime.options.agentId,
      turnIndex,
      attemptModel,
      reason,
      nextModel,
      fallbackAttempts,
    ),
  );
}

async function maybeTriggerBudgetWarning(runtime: AgentRuntime): Promise<void> {
  if (!runtime.options.budget || !runtime.options.hooks?.onBudgetWarning) {
    return;
  }

  if (runtime.state.budgetWarningFired) {
    return;
  }

  const state = runtime.options.budget.budgetRemaining();
  const tokenBudgetTotal = state.tokensUsed + state.tokensRemaining;
  const costBudgetTotal = state.costUsed + state.costRemaining;
  const tokenFraction =
    tokenBudgetTotal > 0 && isFinite(tokenBudgetTotal) ? state.tokensUsed / tokenBudgetTotal : 0;
  const costFraction =
    costBudgetTotal > 0 && isFinite(costBudgetTotal) ? state.costUsed / costBudgetTotal : 0;
  const budgetUsedPercent = Math.max(tokenFraction, costFraction) * 100;

  if (budgetUsedPercent < 80) {
    return;
  }

  runtime.state.budgetWarningFired = true;
  await runtime.options.hooks.onBudgetWarning({
    tokensRemaining: state.tokensRemaining,
    costRemaining: state.costRemaining,
    budgetUsedPercent,
  });
}

function createAssistantMessage(response: ChatResponse): Message {
  const assistantMessage: Message = {
    role: 'assistant',
    content: response.content,
  };
  if (response.toolCalls.length > 0) {
    assistantMessage.toolCalls = response.toolCalls;
  }
  return assistantMessage;
}

async function recordTurnResponse(
  runtime: AgentRuntime,
  currentModel: string,
  response: ChatResponse,
  costBefore: number,
): Promise<number> {
  runtime.state.totalTokens.inputTokens += response.usage.inputTokens;
  runtime.state.totalTokens.outputTokens += response.usage.outputTokens;
  runtime.state.totalTokens.totalTokens += response.usage.totalTokens;

  if (runtime.options.budget) {
    runtime.options.budget.recordUsage(
      currentModel,
      response.usage.inputTokens,
      response.usage.outputTokens,
    );
    await maybeTriggerBudgetWarning(runtime);
  }

  const turnCost = (runtime.options.budget?.budgetRemaining().costUsed ?? 0) - costBefore;
  runtime.state.totalCost += turnCost;
  runtime.state.turnCount++;
  runtime.state.lastContent = response.content;
  runtime.state.conversation.push(createAssistantMessage(response));

  if (response.reasoningTrace) {
    runtime.state.reasoningTraces.push(response.reasoningTrace);
  }

  return turnCost;
}

async function executeChatWithFallbacks(
  runtime: AgentRuntime,
  turnIndex: number,
  preparedTurn: ActiveTurn,
): Promise<ChatTurnResult> {
  const modelsToTry = [preparedTurn.currentModel, ...preparedTurn.fallbackModels];
  let currentModel = preparedTurn.currentModel;
  let response: ChatResponse | undefined;
  let lastError: unknown;
  let fallbackAttempts = 0;

  for (let attempt = 0; attempt < modelsToTry.length; attempt++) {
    const attemptModel = modelsToTry[attempt]!;
    try {
      response = await runtime.options.provider.chat(
        preparedTurn.messagesToSend,
        createChatOptions(runtime, attemptModel),
      );
      runtime.options.healthTracker?.recordSuccess(runtime.options.provider.name);
      currentModel = attemptModel;
      break;
    } catch (error: unknown) {
      lastError = error;
      if (isAbortError(runtime.options.signal, error)) {
        throw error;
      }

      runtime.options.healthTracker?.recordFailure(runtime.options.provider.name);
      const nextModel = modelsToTry[attempt + 1];
      if (nextModel) {
        fallbackAttempts++;
        dispatchFallbackEvent(runtime, turnIndex, attemptModel, nextModel, fallbackAttempts, error);
      }
    }
  }

  if (response === undefined) {
    throw lastError;
  }

  runtime.state.previousModels.push(currentModel);
  const turnDuration = Date.now() - preparedTurn.turnStart;
  const turnCost = await recordTurnResponse(
    runtime,
    currentModel,
    response,
    preparedTurn.costBefore,
  );

  return {
    response,
    currentModel,
    originalModel: preparedTurn.originalModel,
    fallbackAttempts,
    turnCost,
    turnDuration,
  };
}

function dispatchToolCalled(
  runtime: AgentRuntime,
  turnIndex: number,
  toolCall: ToolCall,
  toolSource: 'local' | 'mcp',
  toolOperationId: string,
): void {
  if (runtime.options.eventTarget && runtime.options.workflowId) {
    runtime.options.eventTarget.dispatchEvent(
      new AgentToolCalledEvent(
        runtime.options.workflowId,
        runtime.options.agentId,
        turnIndex,
        toolCall.name,
        toolCall.input,
        toolSource,
        toolOperationId,
      ),
    );
  }

  runtime.options.onToolCalled?.({
    turnIndex,
    toolName: toolCall.name,
    toolInput: toolCall.input,
  });
}

async function resolveToolExecution(
  runtime: AgentRuntime,
  turnIndex: number,
  toolCall: ToolCall,
  tool: RegistryTool | undefined,
): Promise<ToolExecutionOutcome> {
  const effectLog = runtime.options.toolEffectLog;

  // ---------------------------------------------------------------------------
  // Effect log — durable deduplication across checkpoint-restore cycles
  //
  // Compute the semantic hash and consult the log before any execution.
  // This prevents duplicate tool calls when the agent is restored from a
  // checkpoint mid-turn and the LLM re-synthesizes a semantically different
  // version of an already-dispatched tool call.
  // ---------------------------------------------------------------------------
  if (effectLog) {
    const semanticHash = (() => {
      if (tool?.identity) {
        try {
          const result = tool.identity(toolCall.input);
          // Validate that the custom identity returns a well-formed 16-char hex
          // string. An invalid hash would produce unpredictable storage keys.
          // Fall back to the default hash if validation fails.
          if (/^[0-9a-f]{16}$/.test(result.semanticHash)) {
            return result.semanticHash;
          }
        } catch {
          // identity() threw — fall through to the default hash.
        }
      }
      return computeSemanticHash({ name: toolCall.name, input: toolCall.input });
    })();

    const existing = await effectLog.lookup(semanticHash);

    if (existing?.status === 'committed' && existing.toolName === toolCall.name) {
      // A prior run completed this tool call successfully — replay the result
      // without re-executing the tool. The toolName check guards against
      // cross-tool hash collisions from custom identity() functions that omit
      // the tool name. A mismatched toolName falls through to execute normally.
      effectLog.recordReplay();
      return { output: existing.output, success: true };
    }

    if (existing?.status === 'in-flight' && existing.toolName === toolCall.name) {
      // The process crashed between recording in-flight and receiving the
      // result. Re-executing a non-idempotent tool could cause duplicate
      // effects. Throw so the caller can escalate. The toolName check guards
      // against spurious conflicts from cross-tool hash collisions.
      throw new ToolCallReplayConflictError(semanticHash, toolCall.name);
    }

    // Reaches here when:
    // - No existing record for this hash
    // - existing is `aborted` (retriable — re-execute)
    // - existing is `committed` or `in-flight` for a different tool (hash
    //   collision — proceed but do NOT overwrite the other tool's record)
    const shouldRecord = !existing || existing.toolName === toolCall.name;
    if (shouldRecord) {
      await effectLog.record(semanticHash, toolCall.name);
    }

    // Run the tool and update the log on success or failure.
    // Skip log writes on hash collision (shouldRecord=false) to avoid
    // overwriting a committed record that belongs to a different tool.
    // Use try/finally to abort the in-flight record if resolveToolExecutionInner
    // throws unexpectedly — leaving it in-flight permanently would cause a
    // ToolCallReplayConflictError on every future restore.
    let outcome: Awaited<ReturnType<typeof resolveToolExecutionInner>>;
    try {
      outcome = await resolveToolExecutionInner(runtime, turnIndex, toolCall, tool);
    } catch (error) {
      if (shouldRecord) {
        const reason = error instanceof Error ? error.message : String(error);
        await effectLog.abort(semanticHash, toolCall.name, reason);
      }
      throw error;
    }
    if (shouldRecord) {
      if (outcome.success) {
        await effectLog.commit(semanticHash, toolCall.name, outcome.output);
      } else {
        await effectLog.abort(semanticHash, toolCall.name, outcome.output);
      }
    }
    return outcome;
  }

  // No effect log configured — execute directly (original behaviour).
  return resolveToolExecutionInner(runtime, turnIndex, toolCall, tool);
}

async function resolveToolExecutionInner(
  runtime: AgentRuntime,
  turnIndex: number,
  toolCall: ToolCall,
  tool: RegistryTool | undefined,
): Promise<ToolExecutionOutcome> {
  const cacheKey = buildCacheKey(toolCall.name, toolCall.input);

  // Proactively evict expired entries when the cache grows large. The
  // sweep uses the caller's configured `toolCacheMaxSize` so the proactive
  // read-time eviction agrees with the write-time eviction in
  // `setToolCacheEntry`.
  if (runtime.state.toolCache.size >= TOOL_CACHE_SWEEP_THRESHOLD) {
    sweepExpiredCacheEntries(
      runtime.state.toolCache,
      runtime.options.toolCacheTTL,
      runtime.options.toolCacheMaxSize,
    );
  }

  const cached = runtime.state.toolCache.get(cacheKey);
  const now = Date.now();

  let output: string;
  let success = true;
  if (cached && now - cached.timestamp < runtime.options.toolCacheTTL) {
    output = cached.output;
  } else if (!tool) {
    output = JSON.stringify({ error: `Unknown tool: ${toolCall.name}` });
    success = false;
  } else {
    try {
      const rawOutput = await tool.execute(toolCall.input);
      if (tool.verify) {
        const verification = (async () => {
          const verified = await tool.verify?.(rawOutput);
          if (!verified) {
            throw new Error(`Verification failed for tool "${toolCall.name}"`);
          }
        })();

        if (runtime.options.verificationRecorder) {
          runtime.options.verificationRecorder.recordVerification(verification);
        } else {
          await verification;
        }
      }
      output = typeof rawOutput === 'string' ? rawOutput : JSON.stringify(rawOutput);
      setToolCacheEntry(
        runtime.state.toolCache,
        cacheKey,
        { output, timestamp: Date.now() },
        runtime.options.toolCacheMaxSize,
      );
    } catch (error: unknown) {
      output = JSON.stringify({ error: error instanceof Error ? error.message : String(error) });
      success = false;
    }
  }

  if (!(runtime.options.hooks?.afterToolCall && success)) {
    return { output, success };
  }

  const hookResult = await runtime.options.hooks.afterToolCall({
    turnIndex,
    toolCall,
    result: output,
  });
  if (hookResult.action === 'reject') {
    return {
      output: JSON.stringify({ error: hookResult.reason }),
      success: false,
    };
  }

  if (hookResult.action === 'continue' && hookResult.result !== undefined) {
    return {
      output:
        typeof hookResult.result === 'string'
          ? hookResult.result
          : JSON.stringify(hookResult.result),
      success,
    };
  }

  return { output, success };
}

function dispatchToolReturned(
  runtime: AgentRuntime,
  turnIndex: number,
  toolCall: ToolCall,
  toolDuration: number,
  success: boolean,
  toolOperationId: string,
): void {
  if (runtime.options.eventTarget && runtime.options.workflowId) {
    runtime.options.eventTarget.dispatchEvent(
      new AgentToolReturnedEvent(
        runtime.options.workflowId,
        runtime.options.agentId,
        turnIndex,
        toolCall.name,
        toolDuration,
        success,
        toolOperationId,
      ),
    );
  }

  runtime.options.onToolReturned?.({
    turnIndex,
    toolName: toolCall.name,
    duration: toolDuration,
    success,
  });
}

async function executeToolCall(
  runtime: AgentRuntime,
  turnIndex: number,
  toolCall: ToolCall,
): Promise<ToolResult> {
  const toolOperationId = crypto.randomUUID();
  const tool = runtime.toolMap.get(toolCall.name);
  const toolSource: 'local' | 'mcp' = tool?.source ?? 'local';
  dispatchToolCalled(runtime, turnIndex, toolCall, toolSource, toolOperationId);

  const toolStart = Date.now();
  const outcome = await resolveToolExecution(runtime, turnIndex, toolCall, tool);
  const toolDuration = Date.now() - toolStart;
  dispatchToolReturned(
    runtime,
    turnIndex,
    toolCall,
    toolDuration,
    outcome.success,
    toolOperationId,
  );

  return {
    toolCallId: toolCall.id,
    output: outcome.output,
    isError: !outcome.success,
  };
}

async function executeToolCalls(
  runtime: AgentRuntime,
  turnIndex: number,
  toolCalls: ToolCall[],
): Promise<ToolResult[]> {
  const toolResults: ToolResult[] = [];
  for (const toolCall of toolCalls) {
    toolResults.push(await executeToolCall(runtime, turnIndex, toolCall));
  }
  return toolResults;
}

function recordTurnCostEntry(
  runtime: AgentRuntime,
  turnIndex: number,
  response: ChatResponse,
  currentModel: string,
  turnCost: number,
  toolNames: string[],
): void {
  runtime.state.turnCosts.push({
    turn: turnIndex,
    inputTokens: response.usage.inputTokens,
    outputTokens: response.usage.outputTokens,
    cost: turnCost,
    model: currentModel,
    tools: toolNames,
  });
}

function dispatchTurnCompleted(
  runtime: AgentRuntime,
  turnIndex: number,
  response: ChatResponse,
  turnResult: ChatTurnResult,
  toolCallCount: number,
): void {
  if (runtime.options.eventTarget && runtime.options.workflowId) {
    const messagesSnapshot = snapshotConversationForEvent(runtime.state.conversation);
    runtime.options.eventTarget.dispatchEvent(
      new AgentTurnCompletedEvent(
        runtime.options.workflowId,
        runtime.options.agentId,
        turnIndex,
        turnResult.originalModel,
        turnResult.currentModel,
        response.usage.inputTokens,
        response.usage.outputTokens,
        turnResult.turnCost,
        runtime.state.totalCost,
        turnResult.turnDuration,
        toolCallCount,
        turnResult.fallbackAttempts,
        response.reasoningTrace,
        messagesSnapshot,
      ),
    );
  }

  runtime.options.onTurnCompleted?.({
    turnIndex,
    model: turnResult.currentModel,
    inputTokens: response.usage.inputTokens,
    outputTokens: response.usage.outputTokens,
    cost: turnResult.turnCost,
    duration: turnResult.turnDuration,
    toolCallCount,
  });
}

function maybeDispatchCheckpointWarning(runtime: AgentRuntime, turnIndex: number): void {
  if (!(runtime.options.eventTarget && runtime.options.workflowId)) {
    return;
  }

  if (runtime.state.sizeWarningFired) {
    return;
  }

  const sizeBytes = estimateConversationSizeBytes(runtime.state.conversation);
  if (sizeBytes < runtime.options.checkpointSizeWarningThreshold) {
    return;
  }

  runtime.state.sizeWarningFired = true;
  runtime.options.eventTarget.dispatchEvent(
    new AgentCheckpointSizeWarningEvent(
      runtime.options.workflowId,
      runtime.options.agentId,
      sizeBytes,
      turnIndex,
    ),
  );
}

function finalizeTurn(
  runtime: AgentRuntime,
  turnIndex: number,
  turnResult: ChatTurnResult,
  toolNames: string[],
): void {
  recordTurnCostEntry(
    runtime,
    turnIndex,
    turnResult.response,
    turnResult.currentModel,
    turnResult.turnCost,
    toolNames,
  );
  dispatchTurnCompleted(runtime, turnIndex, turnResult.response, turnResult, toolNames.length);
  maybeDispatchCheckpointWarning(runtime, turnIndex);
}

async function executeAgentTurn(runtime: AgentRuntime, turnIndex: number): Promise<boolean> {
  if (shouldStopBeforeTurn(runtime)) {
    return false;
  }

  const preparedTurn = await prepareTurn(runtime, turnIndex);
  if ('skippedResult' in preparedTurn) {
    runtime.state.lastContent = preparedTurn.skippedResult;
    return false;
  }

  const turnResult = await executeChatWithFallbacks(runtime, turnIndex, preparedTurn);
  if (turnResult.response.toolCalls.length === 0) {
    finalizeTurn(runtime, turnIndex, turnResult, []);
    return false;
  }

  const toolResults = await executeToolCalls(runtime, turnIndex, turnResult.response.toolCalls);
  runtime.state.conversation.push({
    role: 'tool',
    content: '',
    toolResults,
  });
  finalizeTurn(
    runtime,
    turnIndex,
    turnResult,
    turnResult.response.toolCalls.map((toolCall) => toolCall.name),
  );
  return true;
}

/** Execute a durable ReAct agent loop. Returns the final agent result. */
export async function executeAgentLoop(options: AgentOptions, input: string): Promise<AgentResult> {
  const runtime = await createAgentRuntime(options, input);

  try {
    for (let turnIndex = 0; turnIndex < runtime.options.maxTurns; turnIndex++) {
      const shouldContinue = await executeAgentTurn(runtime, turnIndex);
      if (!shouldContinue) {
        break;
      }
    }

    // Dispatch a checkpoint-resumed event when the effect log prevented at
    // least one duplicate tool call. Only fires when replays actually occurred.
    if (
      runtime.options.toolEffectLog &&
      runtime.options.eventTarget &&
      runtime.options.workflowId
    ) {
      const duplicatesPrevented = runtime.options.toolEffectLog.duplicatesPrevented;
      if (duplicatesPrevented > 0) {
        runtime.options.eventTarget.dispatchEvent(
          new AgentCheckpointResumedEvent(
            runtime.options.workflowId,
            runtime.options.agentId,
            duplicatesPrevented,
          ),
        );
      }
    }

    return buildAgentResult(runtime.state);
  } finally {
    runtime.dispose();
  }
}
