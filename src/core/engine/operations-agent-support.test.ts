import { describe, expect, it } from 'bun:test';

import type {
  AgentBureauConversationHistory,
  AgentResult,
  ConversationHistoryMessage,
} from '../../ai/agent/index.ts';
import type { AgentInterception, ComposedWorkflowInterceptor } from '../interceptor.ts';
import {
  createAgentInterception,
  exposeAgentObservability,
  openAgentInterceptor,
} from './operations-agent-support.ts';

type FakeContext = {
  exposedAccessors: Map<string, () => unknown>;
  expose: (accessors: Record<string, () => unknown>) => void;
};

function createContext(): FakeContext {
  const exposedAccessors = new Map<string, () => unknown>();
  return {
    exposedAccessors,
    expose(accessors) {
      for (const [name, accessor] of Object.entries(accessors)) {
        exposedAccessors.set(name, accessor);
      }
    },
  };
}

describe('operations-agent-support', () => {
  it('creates agent interceptions with isolated headers and opens interceptors when present', () => {
    const interception = createAgentInterception('workflow-1', 'test-model', 'Prompt');
    const observed: AgentInterception[] = [];

    function* interceptAgent(target: AgentInterception): Generator<unknown, unknown, unknown> {
      observed.push(target);
      const content = yield;
      observed.push({ ...target, prompt: String(content) });
      return undefined;
    }

    const interceptor = {
      agent: interceptAgent,
    } as unknown as ComposedWorkflowInterceptor;

    const generator = openAgentInterceptor(interception, {
      getComposedWorkflowInterceptor: () => interceptor,
    });

    expect(generator).toBeDefined();
    expect(observed[0]).toEqual(interception);
    expect(openAgentInterceptor(interception, { getComposedWorkflowInterceptor: () => null })).toBe(
      undefined,
    );
  });

  it('exposes array and Agent Bureau conversation histories and appends prior accessors', () => {
    const context = createContext();
    context.exposedAccessors.set('agentConversation', () => [{ role: 'system', content: 'prior' }]);
    context.exposedAccessors.set('agentTurnUsage', () => [
      { turnNumber: 0, inputTokens: 1, outputTokens: 1, source: 'provider' },
    ]);

    const bureauMessage: ConversationHistoryMessage = {
      id: 'message-1',
      role: 'assistant',
      content: 'from bureau',
      position: 0,
      createdAt: '2026-05-11T00:00:00.000Z',
      metadata: {},
      hidden: false,
    };
    const result: AgentResult<AgentBureauConversationHistory> = {
      content: 'done',
      conversation: {
        schemaVersion: 4,
        id: 'conversation-1',
        status: 'active',
        metadata: {},
        ids: ['message-1', 'missing'],
        messages: { 'message-1': bureauMessage },
        createdAt: '2026-05-11T00:00:00.000Z',
        updatedAt: '2026-05-11T00:00:00.000Z',
      },
      turnCount: 1,
      totalTokens: { inputTokens: 2, outputTokens: 3, totalTokens: 5 },
      reasoningTraces: [],
      turnUsage: [{ turnNumber: 1, inputTokens: 2, outputTokens: 3, source: 'provider' }],
    };

    exposeAgentObservability(undefined, result, 3);
    exposeAgentObservability(context as never, result, 3);

    expect(context.exposedAccessors.get('agentConversation')?.()).toEqual([
      { role: 'system', content: 'prior' },
      bureauMessage,
    ]);
    expect(context.exposedAccessors.get('agentTurnUsage')?.()).toEqual([
      { turnNumber: 0, inputTokens: 1, outputTokens: 1, source: 'provider' },
      { turnNumber: 1, inputTokens: 2, outputTokens: 3, source: 'provider' },
    ]);
  });
});
