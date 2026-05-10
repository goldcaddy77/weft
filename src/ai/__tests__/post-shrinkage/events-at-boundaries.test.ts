import { describe, expect, it } from 'bun:test';

import type { AgentTool, ChatResponse, LLMProvider } from '../../agent/index.ts';
import { executeAgentLoop } from '../../agent/index.ts';
import {
  AgentToolCalledEvent,
  AgentToolReturnedEvent,
  AgentTurnCompletedEvent,
  AgentTurnStartedEvent,
} from '../../events/index.ts';

describe('events fire at correct boundaries', () => {
  it('fires turn and tool events in order', async () => {
    const fired: string[] = [];
    const eventTarget = new EventTarget();

    eventTarget.addEventListener(AgentTurnStartedEvent.type, () => fired.push('turn:started'));
    eventTarget.addEventListener(AgentToolCalledEvent.type, () => fired.push('tool:called'));
    eventTarget.addEventListener(AgentToolReturnedEvent.type, () => fired.push('tool:returned'));
    eventTarget.addEventListener(AgentTurnCompletedEvent.type, () => fired.push('turn:completed'));

    const tool: AgentTool = {
      name: 'noop',
      description: 'does nothing',
      input: {},
      execute: async () => 'done',
    };

    const responses: ChatResponse[] = [
      {
        content: '',
        toolCalls: [{ id: 'tc-1', name: 'noop', arguments: {} }],
        usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
        model: 'test',
        stopReason: 'tool_use',
      },
      {
        content: 'All done',
        toolCalls: [],
        usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
        model: 'test',
        stopReason: 'end_turn',
      },
    ];
    let index = 0;
    const provider: LLMProvider = {
      name: 'test',
      async chat() {
        return responses[index++]!;
      },
    };

    await executeAgentLoop(
      { model: 'test', provider, tools: [tool], eventTarget, workflowId: 'wf-1', agentId: 'a-1' },
      'go',
    );

    expect(fired).toEqual([
      'turn:started',
      'tool:called',
      'tool:returned',
      'turn:completed',
      'turn:started',
      'turn:completed',
    ]);
  });

  it('deleted event classes are not exported from events module', () => {
    const eventsModule = require('../../events/index.ts');
    expect(eventsModule.AgentBudgetExceededEvent).toBeUndefined();
    expect(eventsModule.AgentBudgetWarningEvent).toBeUndefined();
    expect(eventsModule.AgentContextCompactedEvent).toBeUndefined();
    expect(eventsModule.AgentModelFallbackEvent).toBeUndefined();
    expect(eventsModule.AgentProviderCircuitOpenEvent).toBeUndefined();
  });
});
