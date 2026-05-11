import type {
  HumanReviewCompletedEvent,
  HumanReviewRequestedEvent,
} from '../../core/review/events.ts';
import type {
  AgentCheckpointResumedEvent,
  AgentCheckpointSizeWarningEvent,
} from './checkpoint-events.ts';
import type { AgentToolCalledEvent, AgentToolReturnedEvent } from './tool-events.ts';
import type { AgentTurnCompletedEvent, AgentTurnStartedEvent } from './turn-events.ts';

export * from '../../core/review/events.ts';
export * from './checkpoint-events.ts';
export * from './tool-events.ts';
export * from './turn-events.ts';

export type WeftAgentEventMap = {
  'agent:turn:started': AgentTurnStartedEvent;
  'agent:turn:completed': AgentTurnCompletedEvent;
  'agent:tool:called': AgentToolCalledEvent;
  'agent:tool:returned': AgentToolReturnedEvent;
  'agent:checkpoint-size-warning': AgentCheckpointSizeWarningEvent;
  'human-review:requested': HumanReviewRequestedEvent;
  'human-review:completed': HumanReviewCompletedEvent;
  'agent:checkpoint:resumed': AgentCheckpointResumedEvent;
};
