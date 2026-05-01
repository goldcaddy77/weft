import { AgentModelFallbackEvent } from '../events.ts';
import type { ChatOptions } from '../providers/interface.ts';
import { PendingProviderResumeError } from '../providers/suspending-provider.ts';
import type { ChatResponse, Message } from '../providers/types.ts';
import type { ActiveTurn, AgentRuntime, ChatTurnResult } from './types.ts';

export function createChatOptions(
  runtime: AgentRuntime,
  model: string,
  turnIndex: number,
): ChatOptions {
  const chatOptions: ChatOptions = { model, turnIndex };
  if (runtime.toolDefinitions.length > 0) {
    chatOptions.tools = runtime.toolDefinitions;
  }
  if (runtime.options.signal) {
    chatOptions.signal = runtime.options.signal;
  }
  return chatOptions;
}

export function isAbortError(signal: AbortSignal | undefined, error: unknown): boolean {
  return signal?.aborted === true || (error instanceof DOMException && error.name === 'AbortError');
}

export function dispatchFallbackEvent(
  runtime: AgentRuntime,
  turnIndex: number,
  attemptModel: string,
  nextModel: string,
  fallbackAttempts: number,
  error: unknown,
): void {
  if (!(runtime.options.eventTarget && runtime.options.workflowId)) {
    return;
  }

  const reason = error instanceof Error ? error.message : String(error);
  runtime.options.eventTarget.dispatchEvent(
    new AgentModelFallbackEvent(
      runtime.options.workflowId,
      runtime.options.agentId,
      turnIndex,
      attemptModel,
      reason,
      nextModel,
      fallbackAttempts,
    ),
  );
}

export async function maybeTriggerBudgetWarning(runtime: AgentRuntime): Promise<void> {
  if (!runtime.options.budget || !runtime.options.hooks?.onBudgetWarning) {
    return;
  }

  if (runtime.state.budgetWarningFired) {
    return;
  }

  const state = runtime.options.budget.budgetRemaining();
  const tokenBudgetTotal = state.tokensUsed + state.tokensRemaining;
  const costBudgetTotal = state.costUsed + state.costRemaining;
  const tokenFraction =
    tokenBudgetTotal > 0 && isFinite(tokenBudgetTotal) ? state.tokensUsed / tokenBudgetTotal : 0;
  const costFraction =
    costBudgetTotal > 0 && isFinite(costBudgetTotal) ? state.costUsed / costBudgetTotal : 0;
  const budgetUsedPercent = Math.max(tokenFraction, costFraction) * 100;

  if (budgetUsedPercent < 80) {
    return;
  }

  runtime.state.budgetWarningFired = true;
  await runtime.options.hooks.onBudgetWarning({
    tokensRemaining: state.tokensRemaining,
    costRemaining: state.costRemaining,
    budgetUsedPercent,
  });
}

export function createAssistantMessage(response: ChatResponse): Message {
  const assistantMessage: Message = {
    role: 'assistant',
    content: response.content,
  };
  if (response.toolCalls.length > 0) {
    assistantMessage.toolCalls = response.toolCalls;
  }
  return assistantMessage;
}

export async function recordTurnResponse(
  runtime: AgentRuntime,
  currentModel: string,
  response: ChatResponse,
  costBefore: number,
): Promise<number> {
  runtime.state.totalTokens.inputTokens += response.usage.inputTokens;
  runtime.state.totalTokens.outputTokens += response.usage.outputTokens;
  runtime.state.totalTokens.totalTokens += response.usage.totalTokens;

  if (runtime.options.budget) {
    runtime.options.budget.recordUsage(
      currentModel,
      response.usage.inputTokens,
      response.usage.outputTokens,
    );
    await maybeTriggerBudgetWarning(runtime);
  }

  const turnCost = (runtime.options.budget?.budgetRemaining().costUsed ?? 0) - costBefore;
  runtime.state.totalCost += turnCost;
  runtime.state.turnCount++;
  runtime.state.lastContent = response.content;
  runtime.state.conversation.push(createAssistantMessage(response));

  if (response.reasoningTrace) {
    runtime.state.reasoningTraces.push(response.reasoningTrace);
  }

  return turnCost;
}

export async function executeChatWithFallbacks(
  runtime: AgentRuntime,
  turnIndex: number,
  preparedTurn: ActiveTurn,
): Promise<ChatTurnResult> {
  const modelsToTry = [preparedTurn.currentModel, ...preparedTurn.fallbackModels];
  let currentModel = preparedTurn.currentModel;
  let response: ChatResponse | undefined;
  let lastError: unknown;
  let fallbackAttempts = 0;

  for (let attempt = 0; attempt < modelsToTry.length; attempt++) {
    const attemptModel = modelsToTry[attempt]!;
    try {
      response = await runtime.options.provider.chat(
        preparedTurn.messagesToSend,
        createChatOptions(runtime, attemptModel, turnIndex),
      );
      runtime.options.healthTracker?.recordSuccess(runtime.options.provider.name);
      currentModel = attemptModel;
      break;
    } catch (error: unknown) {
      lastError = error;
      if (
        isAbortError(runtime.options.signal, error) ||
        error instanceof PendingProviderResumeError
      ) {
        throw error;
      }

      runtime.options.healthTracker?.recordFailure(runtime.options.provider.name);
      const nextModel = modelsToTry[attempt + 1];
      if (nextModel) {
        fallbackAttempts++;
        dispatchFallbackEvent(runtime, turnIndex, attemptModel, nextModel, fallbackAttempts, error);
      }
    }
  }

  if (response === undefined) {
    throw lastError;
  }

  runtime.state.previousModels.push(currentModel);
  const turnDuration = Date.now() - preparedTurn.turnStart;
  const turnCost = await recordTurnResponse(
    runtime,
    currentModel,
    response,
    preparedTurn.costBefore,
  );

  return {
    response,
    currentModel,
    originalModel: preparedTurn.originalModel,
    fallbackAttempts,
    turnCost,
    turnDuration,
  };
}
