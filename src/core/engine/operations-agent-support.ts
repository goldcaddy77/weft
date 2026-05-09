import type { AgentResult, ConversationHistory } from '../../ai/agent/index.ts';
import type { Context } from '../context.ts';
import { createAgentInterceptorExecute } from '../engine-helpers.ts';
import type { AgentInterception, ComposedWorkflowInterceptor } from '../interceptor.ts';

/** Build interception state for an agent operation. */
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

/** Open the composed workflow interceptor for an agent operation. */
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

/** Close an agent interceptor with the final agent content. */
export function closeAgentInterceptor(
  generator: Generator<unknown, unknown, unknown> | undefined,
  content: string,
): void {
  if (generator) {
    generator.next(content);
  }
}

function conversationEntries(conversation: ConversationHistory): readonly unknown[] {
  if (Array.isArray(conversation)) {
    return conversation;
  }

  return conversation.ids.flatMap((id) => {
    const message = conversation.messages[id];
    return message === undefined ? [] : [message];
  });
}

/** Expose agent conversation and per-turn token usage through the context. */
export function exposeAgentObservability(
  context: Context | undefined,
  agentResult: AgentResult,
  _agentMaxTurns: number,
): void {
  if (!context) {
    return;
  }

  const previousConversationAccessor = context.exposedAccessors.get('agentConversation');
  const previousTurnUsageAccessor = context.exposedAccessors.get('agentTurnUsage');
  const currentConversation = conversationEntries(agentResult.conversation);
  const currentTurnUsage = agentResult.turnUsage;

  context.expose({
    agentConversation: () => {
      const previous = previousConversationAccessor
        ? (previousConversationAccessor() as typeof currentConversation)
        : [];
      return [...previous, ...currentConversation];
    },
    agentTurnUsage: () => {
      const previous = previousTurnUsageAccessor
        ? (previousTurnUsageAccessor() as typeof currentTurnUsage)
        : [];
      return [...previous, ...currentTurnUsage];
    },
  });
}
