import type { AgentBudgetExceededEvent, AgentBudgetWarningEvent } from './budget-events.ts';
import type {
  AgentCheckpointResumedEvent,
  AgentCheckpointSizeWarningEvent,
} from './checkpoint-events.ts';
import type { AgentContextCompactedEvent } from './context-events.ts';
import type { AgentModelFallbackEvent } from './model-events.ts';
import type { AgentProviderCircuitOpenEvent } from './provider-events.ts';
import type { HumanReviewCompletedEvent, HumanReviewRequestedEvent } from './review-events.ts';
import type { AgentToolCalledEvent, AgentToolReturnedEvent } from './tool-events.ts';
import type { AgentTurnCompletedEvent, AgentTurnStartedEvent } from './turn-events.ts';

export * from './budget-events.ts';
export * from './checkpoint-events.ts';
export * from './context-events.ts';
export * from './model-events.ts';
export * from './provider-events.ts';
export * from './review-events.ts';
export * from './tool-events.ts';
export * from './turn-events.ts';

export type WeftAgentEventMap = {
  'agent:turn:started': AgentTurnStartedEvent;
  'agent:turn:completed': AgentTurnCompletedEvent;
  'agent:tool:called': AgentToolCalledEvent;
  'agent:tool:returned': AgentToolReturnedEvent;
  'agent:budget:warning': AgentBudgetWarningEvent;
  'agent:budget:exceeded': AgentBudgetExceededEvent;
  'agent:context:compacted': AgentContextCompactedEvent;
  'agent:checkpoint-size-warning': AgentCheckpointSizeWarningEvent;
  'agent:model:fallback': AgentModelFallbackEvent;
  'agent:provider:circuit-open': AgentProviderCircuitOpenEvent;
  'human-review:requested': HumanReviewRequestedEvent;
  'human-review:completed': HumanReviewCompletedEvent;
  'agent:checkpoint:resumed': AgentCheckpointResumedEvent;
};
