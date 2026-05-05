import type {
  AgentOptions,
  AgentResult,
  AgentTool,
  AgentToolCalledEvent,
  AgentToolReturnedEvent,
  AgentTurnCompletedEvent,
  AgentTurnStartedEvent,
  ChatResponse,
  LLMProvider,
  Message,
  PersistedAgentLoopState,
  TurnUsageEntry,
} from '../../../index.ts';
import { AgentLoopSuspendedError, agent, isAgentDefinition } from '../../../index.ts';

const agentOptions: AgentOptions = {} as AgentOptions;
const agentResult: AgentResult = {} as AgentResult;
const agentTool: AgentTool = {} as AgentTool;
const llmProvider: LLMProvider = {} as LLMProvider;
const chatResponse: ChatResponse = {} as ChatResponse;
const message: Message = {} as Message;
const persistedState: PersistedAgentLoopState = {} as PersistedAgentLoopState;
const usageEntry: TurnUsageEntry = {} as TurnUsageEntry;
const turnStartedEvent: AgentTurnStartedEvent = {} as AgentTurnStartedEvent;
const turnCompletedEvent: AgentTurnCompletedEvent = {} as AgentTurnCompletedEvent;
const toolCalledEvent: AgentToolCalledEvent = {} as AgentToolCalledEvent;
const toolReturnedEvent: AgentToolReturnedEvent = {} as AgentToolReturnedEvent;

void agentOptions;
void agentResult;
void agentTool;
void llmProvider;
void chatResponse;
void message;
void persistedState;
void usageEntry;
void turnStartedEvent;
void turnCompletedEvent;
void toolCalledEvent;
void toolReturnedEvent;
void AgentLoopSuspendedError;
void agent;
void isAgentDefinition;

// @ts-expect-error Removed budget API must not be exported from the public surface.
const removedBudgetTracker = null as unknown as import('../../../index.ts').BudgetTracker;
// @ts-expect-error Removed MCP source descriptors must not be exported from the public surface.
const removedMcpToolSource = null as unknown as import('../../../index.ts').MCPToolSource;
// @ts-expect-error Removed model-routing context must not be exported from the public surface.
const removedRoutingContext = null as unknown as import('../../../index.ts').RoutingContext;
// @ts-expect-error Removed streaming chunks must not be exported from the public surface.
const removedStreamChunk = null as unknown as import('../../../index.ts').StreamChunk;
// @ts-expect-error The public helper is `agent`; the pre-1.0 `defineAgent` name is removed.
const removedDefineAgent = null as unknown as import('../../../index.ts').defineAgent;

void removedBudgetTracker;
void removedMcpToolSource;
void removedRoutingContext;
void removedStreamChunk;
void removedDefineAgent;
