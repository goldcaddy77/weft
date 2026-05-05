import { AgentTurnStartedEvent } from '../events/index.ts';
import type { AgentRuntime, Message } from './types.ts';

/** Dispatch the agent turn-started event when an event target is configured. */
export function dispatchTurnStarted(
  runtime: AgentRuntime,
  turnIndex: number,
  conversationLength: number,
): void {
  if (runtime.options.eventTarget && runtime.options.workflowId) {
    runtime.options.eventTarget.dispatchEvent(
      new AgentTurnStartedEvent(
        runtime.options.workflowId,
        runtime.options.agentId,
        turnIndex,
        runtime.options.defaultModel,
        0,
        conversationLength,
      ),
    );
  }
}

/** Prepare the messages for a provider turn. */
export function prepareTurn(runtime: AgentRuntime, turnIndex: number): Message[] {
  const messagesToSend = [...runtime.state.conversation];
  dispatchTurnStarted(runtime, turnIndex, messagesToSend.length);
  return messagesToSend;
}
