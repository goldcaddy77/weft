import { AgentCheckpointSizeWarningEvent, AgentTurnCompletedEvent } from '../events/index.ts';
import { snapshotConversationForEvent } from './event-message-snapshot.ts';
import { estimateConversationSizeBytes } from './tool-execution.ts';
import type { AgentRuntime, ChatResponse, ChatTurnResult } from './types.ts';

/** Record the provider-reported token usage for a completed turn. */
export function recordTurnUsage(
  runtime: AgentRuntime,
  turnIndex: number,
  response: ChatResponse,
): void {
  runtime.state.turnUsage.push({
    turnNumber: turnIndex,
    inputTokens: response.usage.inputTokens,
    outputTokens: response.usage.outputTokens,
    source: 'provider',
  });
}

/** Dispatch the agent turn-completed event. */
export function dispatchTurnCompleted(
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
        response.usage.inputTokens,
        response.usage.outputTokens,
        turnResult.turnDuration,
        toolCallCount,
        messagesSnapshot,
      ),
    );
  }
}

/** Dispatch a checkpoint-size warning once the conversation crosses the threshold. */
export function maybeDispatchCheckpointWarning(runtime: AgentRuntime, turnIndex: number): void {
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

/** Finalize bookkeeping and events for one completed agent turn. */
export function finalizeTurn(
  runtime: AgentRuntime,
  turnIndex: number,
  turnResult: ChatTurnResult,
  toolNames: string[],
): void {
  recordTurnUsage(runtime, turnIndex, turnResult.response);
  dispatchTurnCompleted(runtime, turnIndex, turnResult.response, turnResult, toolNames.length);
  maybeDispatchCheckpointWarning(runtime, turnIndex);
}
