import { describe, expect, it } from 'bun:test';

import { executeAgentLoop, executeAgentLoopWithState } from './agent/index.ts';
import type { ChatResponse, LLMProvider, PersistedAgentLoopState } from './agent/types.ts';
import { AgentCheckpointSizeWarningEvent } from './events/index.ts';

function createResponse(content: string, overrides: Partial<ChatResponse> = {}): ChatResponse {
  return {
    content,
    toolCalls: [],
    usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
    model: 'test-model',
    stopReason: 'end_turn',
    ...overrides,
  };
}

function createProvider(responses: ChatResponse[]): LLMProvider {
  let index = 0;
  return {
    name: 'test',
    async chat() {
      const response = responses[index++];
      if (!response) throw new Error('provider has no more responses');
      return response;
    },
  };
}

function createPersistedState(
  overrides: Partial<PersistedAgentLoopState> = {},
): PersistedAgentLoopState {
  return {
    schemaVersion: 2,
    conversation: [
      { role: 'user', content: 'original input' },
      { role: 'assistant', content: 'partial answer' },
    ],
    totalTokens: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
    turnCount: 1,
    lastContent: 'partial answer',
    sizeWarningFired: false,
    agentId: 'agent-1',
    workflowId: 'workflow-1',
    reasoningTraces: ['first trace'],
    turnUsage: [{ turnNumber: 0, inputTokens: 10, outputTokens: 5, source: 'provider' }],
    ...overrides,
  };
}

describe('agent loop durability', () => {
  it('round-trips persisted loop state through structuredClone', () => {
    const state = createPersistedState({
      pendingProviderResume: {
        turnIndex: 1,
        hint: { resumeToken: 'resume-1', state: { provider: 'test' } },
        resumed: false,
      },
    });

    const cloned = structuredClone(state);

    expect(cloned).toEqual(state);
    expect(cloned).not.toBe(state);
    expect(cloned.schemaVersion).toBe(2);
  });

  it('returns the last content when execution exits at maxTurns', async () => {
    let calls = 0;
    const provider: LLMProvider = {
      name: 'test',
      async chat() {
        calls++;
        return createResponse('', {
          toolCalls: [{ id: `tc-${calls}`, name: 'unknown_tool', input: {} }],
          stopReason: 'tool_use',
        });
      },
    };

    const result = await executeAgentLoop({ model: 'test-model', provider, maxTurns: 2 }, 'run');

    expect(calls).toBe(2);
    expect(result.turnCount).toBe(2);
    expect(result.content).toBe('');
  });

  it('exits without calling the provider when the abort signal is already aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    let providerCalled = false;

    const provider: LLMProvider = {
      name: 'test',
      async chat() {
        providerCalled = true;
        return createResponse('unexpected');
      },
    };

    const result = await executeAgentLoop(
      { model: 'test-model', provider, signal: controller.signal },
      'stop',
    );

    expect(providerCalled).toBe(false);
    expect(result.turnCount).toBe(0);
    expect(result.content).toBe('');
  });

  it('fires one checkpoint-size warning for a large conversation', async () => {
    const warnings: AgentCheckpointSizeWarningEvent[] = [];
    const eventTarget = new EventTarget();
    eventTarget.addEventListener(AgentCheckpointSizeWarningEvent.type, (event) => {
      warnings.push(event as AgentCheckpointSizeWarningEvent);
    });

    const provider = createProvider([
      createResponse('x'.repeat(200)),
      createResponse('y'.repeat(200)),
    ]);

    await executeAgentLoop(
      {
        model: 'test-model',
        provider,
        eventTarget,
        workflowId: 'workflow-1',
        agentId: 'agent-1',
        checkpointSizeWarningThreshold: 32,
        maxTurns: 2,
      },
      'start',
    );

    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.workflowId).toBe('workflow-1');
    expect(warnings[0]?.agentId).toBe('agent-1');
    expect(warnings[0]?.sizeBytes).toBeGreaterThanOrEqual(32);
  });

  it('resumes executeAgentLoopWithState from a persisted conversation', async () => {
    const persistedState = createPersistedState();
    let capturedMessageCount = 0;
    const provider: LLMProvider = {
      name: 'test',
      async chat(messages) {
        capturedMessageCount = messages.length;
        return createResponse('final answer', {
          usage: { inputTokens: 20, outputTokens: 10, totalTokens: 30 },
          reasoningTrace: 'second trace',
        });
      },
    };

    const result = await executeAgentLoopWithState(
      { model: 'test-model', provider },
      'ignored when state exists',
      persistedState,
    );

    expect(capturedMessageCount).toBe(2);
    expect(result.content).toBe('final answer');
    expect(result.turnCount).toBe(2);
    expect(result.totalTokens).toEqual({ inputTokens: 30, outputTokens: 15, totalTokens: 45 });
    expect(result.reasoningTraces).toEqual(['first trace', 'second trace']);
    expect(result.turnUsage).toEqual([
      { turnNumber: 0, inputTokens: 10, outputTokens: 5, source: 'provider' },
      { turnNumber: 1, inputTokens: 20, outputTokens: 10, source: 'provider' },
    ]);
  });
});
