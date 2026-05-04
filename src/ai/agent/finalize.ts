import { snapshotConversationForEvent } from '../event-message-snapshot.ts';
import { AgentCheckpointSizeWarningEvent, AgentTurnCompletedEvent } from '../events.ts';
import type { ChatResponse } from '../providers/types.ts';
import { estimateConversationSizeBytes } from './tool-execution.ts';
import type { AgentRuntime, ChatTurnResult } from './types.ts';

export function recordTurnCostEntry(
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

export function finalizeTurn(
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
