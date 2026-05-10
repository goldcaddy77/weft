import { initializeTools, type RegistryToolEntry } from './tool-initialization.ts';
import type {
  AgentLoopState,
  AgentOptions,
  AgentResult,
  AgentRuntime,
  Message,
  PersistedAgentLoopState,
  ResolvedAgentOptions,
  ToolDescriptor,
} from './types.ts';

/** Fill defaults in an agent options object. */
export function resolveAgentOptions(options: AgentOptions): ResolvedAgentOptions {
  return {
    defaultModel: options.model,
    provider: options.provider,
    systemPrompt: options.systemPrompt,
    maxTurns: options.maxTurns ?? 10,
    signal: options.signal,
    eventTarget: options.eventTarget,
    workflowId: options.workflowId ?? '',
    agentId: options.agentId ?? '',
    checkpointSizeWarningThreshold: options.checkpointSizeWarningThreshold ?? 65_536,
    toolEffectLog: options.toolEffectLog,
    verificationRecorder: options.verificationRecorder,
  };
}

/** Build lookup structures for resolved local tools. */
export function createToolLookups(registryTools: RegistryToolEntry[]): {
  toolMap: Map<string, RegistryToolEntry>;
  toolDefinitions: ToolDescriptor[];
} {
  const toolMap = new Map<string, RegistryToolEntry>();
  const toolDefinitions: ToolDescriptor[] = [];

  for (const tool of registryTools) {
    toolMap.set(tool.definition.name, tool);
    toolDefinitions.push(tool.definition);
  }

  return { toolMap, toolDefinitions };
}

/** Create the starting conversation for a new agent loop. */
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
    totalTokens: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
    turnCount: 0,
    lastContent: '',
    sizeWarningFired: false,
    reasoningTraces: [],
    turnUsage: [],
  };
}

/** Restore an agent loop from durable state, or create a fresh loop state. */
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
    totalTokens: { ...persistedState.totalTokens },
    turnCount: persistedState.turnCount,
    lastContent: persistedState.lastContent ?? '',
    sizeWarningFired: persistedState.sizeWarningFired,
    reasoningTraces: [...persistedState.reasoningTraces],
    turnUsage: [...persistedState.turnUsage],
  };
}

/** Snapshot the mutable loop state for durable suspension storage. */
export function snapshotAgentLoopState(
  state: AgentLoopState,
  agentId: string,
  workflowId: string,
): PersistedAgentLoopState {
  return {
    schemaVersion: 2,
    conversation: [...state.conversation],
    totalTokens: { ...state.totalTokens },
    turnCount: state.turnCount,
    lastContent: state.lastContent,
    sizeWarningFired: state.sizeWarningFired,
    agentId,
    workflowId,
    reasoningTraces: [...state.reasoningTraces],
    turnUsage: [...state.turnUsage],
  };
}

/** Create the runtime bundle needed to execute an agent loop. */
export async function createAgentRuntime(
  options: AgentOptions,
  input: string,
  persistedState?: PersistedAgentLoopState,
): Promise<AgentRuntime> {
  const resolvedOptions = resolveAgentOptions(options);
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

/** Build the public agent result from the final loop state. */
export function buildAgentResult(state: AgentLoopState): AgentResult {
  return {
    content: state.lastContent,
    conversation: state.conversation,
    totalTokens: state.totalTokens,
    turnCount: state.turnCount,
    reasoningTraces: state.reasoningTraces,
    turnUsage: state.turnUsage,
  };
}

/** Return true when execution should stop before the next turn starts. */
export function shouldStopBeforeTurn(runtime: AgentRuntime): boolean {
  return runtime.options.signal?.aborted === true;
}
