import type { AgentResult } from '../../ai/agent.ts';
import type { BudgetOptions, BudgetTracker } from '../../ai/budget.ts';
import { KEYS } from '../../storage/interface.ts';
import { encode } from '../codec.ts';
import type { Context, ContextOperationRequest } from '../context.ts';
import { createAgentInterceptorExecute } from '../engine-helpers.ts';
import { DevelopmentWarningEvent } from '../events.ts';
import type { AgentInterception, ComposedWorkflowInterceptor } from '../interceptor.ts';
import type { EngineInternals } from './internals.ts';

type AgentOperation = Extract<ContextOperationRequest, { type: 'agent' }>;

type AgentBudgetCallbacks = {
  dispatchEvent: (event: Event) => boolean;
  forwardEventToHandle: (workflowId: string, event: Event) => void;
};

export async function createAgentBudgetTracker(
  _internals: EngineInternals,
  workflowId: string,
  operation: AgentOperation,
  budgetOptions: BudgetOptions | undefined,
  callbacks: AgentBudgetCallbacks,
): Promise<BudgetTracker | undefined> {
  if (!budgetOptions) {
    return undefined;
  }

  const { BudgetTracker } = await import('../../ai/budget.ts');
  const { AgentBudgetWarningEvent, AgentBudgetExceededEvent } = await import('../../ai/events.ts');

  return new BudgetTracker(budgetOptions, {
    onWarning: (state) => {
      const threshold = budgetOptions.warningThreshold ?? 0.8;
      const costFraction =
        budgetOptions.maxCost !== undefined && budgetOptions.maxCost > 0
          ? state.costUsed / budgetOptions.maxCost
          : 0;
      const tokenFraction =
        budgetOptions.maxTokens !== undefined && budgetOptions.maxTokens > 0
          ? state.tokensUsed / budgetOptions.maxTokens
          : 0;
      const usedPercent = Math.max(costFraction, tokenFraction);
      const event = new AgentBudgetWarningEvent(
        workflowId,
        operation.operationId,
        usedPercent,
        state.tokensRemaining,
        state.costRemaining,
        threshold,
      );
      callbacks.dispatchEvent(event);
      callbacks.forwardEventToHandle(workflowId, event);
    },
    onExceeded: (state) => {
      const event = new AgentBudgetExceededEvent(
        workflowId,
        operation.operationId,
        state.tokensUsed,
        state.costUsed,
        budgetOptions.maxTokens ?? 0,
        budgetOptions.maxCost ?? 0,
      );
      callbacks.dispatchEvent(event);
      callbacks.forwardEventToHandle(workflowId, event);
    },
  });
}

export function resolveAgentBudgetNamespace(
  internals: EngineInternals,
  budgetNamespace: string | undefined,
): string | undefined {
  const budgetPolicyEnforcer = internals.budgetPolicyEnforcer;
  if (!budgetPolicyEnforcer) {
    return undefined;
  }

  if (budgetNamespace !== undefined) {
    return budgetNamespace;
  }

  if (budgetPolicyEnforcer.policies.size !== 1) {
    return undefined;
  }

  const firstPolicy = budgetPolicyEnforcer.policies.keys().next();
  return firstPolicy.done ? undefined : firstPolicy.value;
}

export async function checkAgentBudgetPolicy(
  internals: EngineInternals,
  workflowId: string,
  budgetOptions: BudgetOptions | undefined,
  resolvedBudgetNamespace: string | undefined,
  callbacks: Pick<AgentBudgetCallbacks, 'dispatchEvent'>,
): Promise<void> {
  const budgetPolicyEnforcer = internals.budgetPolicyEnforcer;
  if (!budgetPolicyEnforcer || !resolvedBudgetNamespace) {
    return;
  }

  if (!budgetOptions) {
    callbacks.dispatchEvent(
      new DevelopmentWarningEvent(
        workflowId,
        'Organization budget policy is active but ctx.agent() was called without budget options. Provide budget with model pricing to enable cost tracking and org budget enforcement.',
        [],
      ),
    );
  }

  await budgetPolicyEnforcer.checkBudget(resolvedBudgetNamespace);
}

export function exposeTokenUsageAccessor(
  context: Context | undefined,
  budgetTracker: BudgetTracker | undefined,
): void {
  if (!context || !budgetTracker) {
    return;
  }

  const previousAccessor = context.exposedAccessors.get('tokenUsage');
  context.expose({
    tokenUsage: () => {
      const current = budgetTracker.budgetRemaining();
      if (!previousAccessor) {
        return current;
      }

      const previous = previousAccessor() as typeof current;
      const mergedBreakdown = new Map<
        string,
        { model: string; inputTokens: number; outputTokens: number; cost: number }
      >();
      for (const entry of previous.breakdown) {
        mergedBreakdown.set(entry.model, { ...entry });
      }
      for (const entry of current.breakdown) {
        const existing = mergedBreakdown.get(entry.model);
        if (existing) {
          existing.inputTokens += entry.inputTokens;
          existing.outputTokens += entry.outputTokens;
          existing.cost += entry.cost;
          continue;
        }

        mergedBreakdown.set(entry.model, { ...entry });
      }

      return {
        tokensUsed: current.tokensUsed + previous.tokensUsed,
        costUsed: current.costUsed + previous.costUsed,
        tokensRemaining: current.tokensRemaining,
        costRemaining: current.costRemaining,
        breakdown: [...mergedBreakdown.values()],
      };
    },
  });
}

export function createAgentInterception(
  workflowId: string,
  model: string,
  prompt: string,
): AgentInterception {
  return {
    workflowId,
    model,
    prompt,
    headers: new Map<string, string>(),
  };
}

export function openAgentInterceptor(
  agentInterception: AgentInterception,
  callbacks: { getComposedWorkflowInterceptor: () => ComposedWorkflowInterceptor | null },
): Generator<unknown, unknown, unknown> | undefined {
  const composedInterceptor = callbacks.getComposedWorkflowInterceptor();
  if (!composedInterceptor) {
    return undefined;
  }

  const generator = composedInterceptor.agent(
    agentInterception,
    createAgentInterceptorExecute(agentInterception),
  );
  generator.next();
  return generator;
}

export function closeAgentInterceptor(
  generator: Generator<unknown, unknown, unknown> | undefined,
  content: string,
): void {
  if (generator) {
    generator.next(content);
  }
}

export function exposeAgentObservability(
  context: Context | undefined,
  agentResult: AgentResult,
  agentMaxTurns: number,
): void {
  if (!context) {
    return;
  }

  const previousWaterfallAccessor = context.exposedAccessors.get('agentCostWaterfall');
  const previousConversationAccessor = context.exposedAccessors.get('agentConversation');
  const previousProjectionAccessor = context.exposedAccessors.get('agentCostProjection');
  const currentTurnCosts = agentResult.turnCosts;
  const currentConversation = agentResult.conversation;
  const currentTurnCount = agentResult.turnCount;
  const currentTotalCost = agentResult.totalCost;

  context.expose({
    agentCostWaterfall: () => {
      const previous = previousWaterfallAccessor
        ? (previousWaterfallAccessor() as typeof currentTurnCosts)
        : [];
      return [...previous, ...currentTurnCosts];
    },
    agentConversation: () => {
      const previous = previousConversationAccessor
        ? (previousConversationAccessor() as typeof currentConversation)
        : [];
      return [...previous, ...currentConversation];
    },
    agentCostProjection: () => {
      const previousProjection = previousProjectionAccessor
        ? (previousProjectionAccessor() as {
            averageCostPerTurn: number;
            turnsCompleted: number;
            maxTurns: number;
            projectedTotalCost: number;
          })
        : null;

      const totalTurns = (previousProjection?.turnsCompleted ?? 0) + currentTurnCount;
      const totalCost =
        (previousProjection
          ? previousProjection.averageCostPerTurn * previousProjection.turnsCompleted
          : 0) + currentTotalCost;
      const averageCostPerTurn = totalTurns > 0 ? totalCost / totalTurns : 0;

      return {
        averageCostPerTurn,
        turnsCompleted: totalTurns,
        maxTurns: Math.max(previousProjection?.maxTurns ?? 0, agentMaxTurns),
        projectedTotalCost:
          averageCostPerTurn * Math.max(previousProjection?.maxTurns ?? 0, agentMaxTurns),
      };
    },
  });
}

export function recordAgentContextCost(context: Context | undefined, totalCost: number): void {
  if (!context || totalCost <= 0) {
    return;
  }

  const previousCost = context.getAttribute<number>('weft:tokenCost') ?? 0;
  context.setAttribute('weft:tokenCost', previousCost + totalCost);
}

export async function recordAgentBudgetCost(
  internals: EngineInternals,
  workflowId: string,
  operationId: string,
  resolvedBudgetNamespace: string | undefined,
  totalCost: number,
): Promise<void> {
  const budgetPolicyEnforcer = internals.budgetPolicyEnforcer;
  if (!budgetPolicyEnforcer || !resolvedBudgetNamespace || totalCost <= 0) {
    return;
  }

  const chargedKey = KEYS.budgetCharged(operationId);
  const alreadyCharged =
    internals.chargedAgentOperations.has(operationId) ||
    (await internals.storage.get(chargedKey)) !== null;

  if (alreadyCharged) {
    return;
  }

  await internals.storage.put(chargedKey, encode({ cost: totalCost }));
  await budgetPolicyEnforcer.recordCost(resolvedBudgetNamespace, totalCost);
  internals.chargedAgentOperations.add(operationId);

  let workflowOperations = internals.chargedAgentOperationsByWorkflow.get(workflowId);
  if (!workflowOperations) {
    workflowOperations = new Set();
    internals.chargedAgentOperationsByWorkflow.set(workflowId, workflowOperations);
  }
  workflowOperations.add(operationId);
}
