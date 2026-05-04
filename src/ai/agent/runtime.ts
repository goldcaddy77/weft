import { BudgetExceededError, type BudgetTracker } from '../budget.ts';
import type { RegistryTool } from '../mcp/registry.ts';
import type { Message, ToolDefinition } from '../providers/types.ts';
import type { CacheEntry } from '../tool-cache.ts';
import { initializeTools } from './tool-initialization.ts';
import type {
  AgentLoopState,
  AgentOptions,
  AgentResult,
  AgentRuntime,
  PersistedAgentLoopState,
  ResolvedAgentOptions,
} from './types.ts';

export function resolveAgentOptions(options: AgentOptions): ResolvedAgentOptions {
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

export function createToolLookups(registryTools: RegistryTool[]): {
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

export function createInitialConversation(
  systemPrompt: string | undefined,
  input: string,
): Message[] {
  const conversation: Message[] = [];
  if (systemPrompt !== undefined) {
    conversation.push({ role: 'system', content: systemPrompt });
  }
  conversation.push({ role: 'user', content: input });
  return conversation;
}

function createInitialAgentLoopState(
  systemPrompt: string | undefined,
  input: string,
): AgentLoopState {
  return {
    conversation: createInitialConversation(systemPrompt, input),
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
  };
}

export function restoreAgentLoopState(
  persistedState: PersistedAgentLoopState | undefined,
  systemPrompt: string | undefined,
  input: string,
): AgentLoopState {
  if (persistedState === undefined) {
    return createInitialAgentLoopState(systemPrompt, input);
  }

  return {
    conversation: [...persistedState.conversation],
    toolCache: new Map<string, CacheEntry>(persistedState.toolCacheEntries),
    totalTokens: { ...persistedState.totalTokens },
    totalCost: persistedState.totalCost,
    turnCount: persistedState.turnCount,
    lastContent: persistedState.lastContent,
    sizeWarningFired: persistedState.sizeWarningFired,
    budgetWarningFired: persistedState.budgetWarningFired,
    previousModels: [...persistedState.previousModels],
    reasoningTraces: [...persistedState.reasoningTraces],
    turnCosts: [...persistedState.turnCosts],
  };
}

export function snapshotAgentLoopState(
  state: AgentLoopState,
  budgetTracker: BudgetTracker | undefined,
): PersistedAgentLoopState {
  return {
    conversation: [...state.conversation],
    toolCacheEntries: [...state.toolCache.entries()].map(([key, entry]) => [key, { ...entry }]),
    totalTokens: { ...state.totalTokens },
    totalCost: state.totalCost,
    turnCount: state.turnCount,
    lastContent: state.lastContent,
    sizeWarningFired: state.sizeWarningFired,
    budgetWarningFired: state.budgetWarningFired,
    previousModels: [...state.previousModels],
    reasoningTraces: [...state.reasoningTraces],
    turnCosts: [...state.turnCosts],
    ...(budgetTracker ? { budgetState: budgetTracker.toJSON() } : {}),
  };
}

export async function createAgentRuntime(
  options: AgentOptions,
  input: string,
  persistedState?: PersistedAgentLoopState,
): Promise<AgentRuntime> {
  const resolvedOptions = resolveAgentOptions(options);
  if (resolvedOptions.budget && persistedState?.budgetState) {
    const restoredBudget = resolvedOptions.budget.clone();
    restoredBudget.restoreFromJSON(persistedState.budgetState);
    resolvedOptions.budget = restoredBudget;
  }
  const { registry, dispose } = await initializeTools(options.tools ?? [], resolvedOptions.signal);
  const { toolMap, toolDefinitions } = createToolLookups(registry.getAll());

  return {
    options: resolvedOptions,
    toolMap,
    toolDefinitions,
    dispose,
    state: restoreAgentLoopState(persistedState, resolvedOptions.systemPrompt, input),
  };
}

export function buildAgentResult(state: AgentLoopState): AgentResult {
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

export function shouldStopBeforeTurn(runtime: AgentRuntime): boolean {
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
