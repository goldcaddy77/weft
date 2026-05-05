import type {
  AgentOptions,
  AgentResult,
  AgentTool,
  ChatResponse,
  LLMProvider,
  Message,
  PersistedAgentLoopState,
  TurnUsageEntry,
} from '../../agent/index.ts';
import { AgentLoopSuspendedError } from '../../agent/index.ts';
import { defineAgent, isAgentDefinition } from '../../declaration.ts';
import type {
  AgentToolCalledEvent,
  AgentToolReturnedEvent,
  AgentTurnCompletedEvent,
  AgentTurnStartedEvent,
} from '../../events/index.ts';

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
void defineAgent;
void isAgentDefinition;
