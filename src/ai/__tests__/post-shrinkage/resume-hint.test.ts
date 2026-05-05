import { describe, expect, it } from 'bun:test';

import type { LLMProvider } from '../../agent/index.ts';
import { AgentLoopSuspendedError, executeAgentLoop } from '../../agent/index.ts';
import { createSuspendingProvider } from '../../agent/suspending-provider.ts';

describe('provider resume hints', () => {
  it('carries createChatResumeHint output into AgentLoopSuspendedError.pendingResume.hint', async () => {
    const provider = createSuspendingProvider(
      {
        name: 'test',
        async createChatResumeHint() {
          return { resumeToken: 'r-1', state: { externalRunId: 'run-1' } };
        },
        async chat() {
          throw new Error('chat should not run before resume');
        },
      } satisfies LLMProvider,
      {
        canSuspend: true,
        async load() {
          return undefined;
        },
        async store() {},
        async clear() {},
      },
    );

    try {
      await executeAgentLoop({ model: 'test', provider }, 'start');
      throw new Error('expected suspension');
    } catch (error) {
      expect(error).toBeInstanceOf(AgentLoopSuspendedError);
      expect((error as AgentLoopSuspendedError).pendingResume.hint).toEqual({
        resumeToken: 'r-1',
        state: { externalRunId: 'run-1' },
      });
    }
  });
});
