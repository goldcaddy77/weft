import { AgentContextCompactedEvent, AgentTurnStartedEvent } from '../events.ts';
import type { RoutingContext } from '../model-router.ts';
import type { Message } from '../providers/types.ts';
import type { AgentRuntime, PreparedTurn } from './types.ts';

export function selectModelForTurn(
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

export async function prepareMessagesForTurn(runtime: AgentRuntime): Promise<Message[]> {
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

export async function applyBeforeTurnHook(
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

export function dispatchTurnStarted(
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

export async function prepareTurn(runtime: AgentRuntime, turnIndex: number): Promise<PreparedTurn> {
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
