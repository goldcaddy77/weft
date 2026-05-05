import { describe, expect, it } from 'bun:test';

import type { ChatResponse, LLMProvider } from '../../agent/index.ts';
import {
  AgentLoopSuspendedError,
  executeAgentLoop,
  executeAgentLoopWithState,
} from '../../agent/index.ts';
import {
  createSuspendingProvider,
  type PendingChatResumeState,
} from '../../agent/suspending-provider.ts';

describe('provider suspension and resume', () => {
  it('suspends with schemaVersion 2 and resumes through executeAgentLoopWithState', async () => {
    const hint = { resumeToken: 'r-1' };
    const finalResponse: ChatResponse = {
      content: 'resumed result',
      toolCalls: [],
      usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
      model: 'test',
      stopReason: 'end_turn',
    };
    const baseProvider: LLMProvider = {
      name: 'test',
      async createChatResumeHint() {
        return hint;
      },
      async chat(_messages, options) {
        expect(options.resumeContext).toEqual({ hint, payload: { approved: true } });
        return finalResponse;
      },
    };

    const initialProvider = createSuspendingProvider(baseProvider, {
      canSuspend: true,
      async load() {
        return undefined;
      },
      async store() {},
      async clear() {},
    });

    let suspendedError: AgentLoopSuspendedError | undefined;
    try {
      await executeAgentLoop(
        { model: 'test', provider: initialProvider, workflowId: 'wf-1', agentId: 'agent-1' },
        'start',
      );
      throw new Error('expected AgentLoopSuspendedError, but executeAgentLoop returned normally');
    } catch (error) {
      expect(error).toBeInstanceOf(AgentLoopSuspendedError);
      suspendedError = error as AgentLoopSuspendedError;
    }

    expect(suspendedError).toBeInstanceOf(AgentLoopSuspendedError);
    expect(suspendedError.loopState.schemaVersion).toBe(2);
    expect(suspendedError.pendingResume.hint).toEqual(hint);

    const resumedState: PendingChatResumeState = {
      hint,
      resumed: true,
      payload: { approved: true },
    };
    const resumedProvider = createSuspendingProvider(baseProvider, {
      canSuspend: true,
      async load() {
        return resumedState;
      },
      async store() {},
      async clear() {},
    });

    const result = await executeAgentLoopWithState(
      { model: 'test', provider: resumedProvider, workflowId: 'wf-1', agentId: 'agent-1' },
      'start',
      suspendedError.loopState,
    );

    expect(result.content).toBe('resumed result');
    expect(result.turnCount).toBe(1);
  });
});
