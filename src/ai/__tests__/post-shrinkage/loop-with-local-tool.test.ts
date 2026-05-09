import { describe, expect, it } from 'bun:test';

import type { AgentTool, ChatResponse, LLMProvider } from '../../agent/index.ts';
import { executeAgentLoop } from '../../agent/index.ts';

describe('executeAgentLoop — local tool round-trip', () => {
  it('runs a 2-turn loop: tool call then final answer', async () => {
    let toolCallCount = 0;
    const echoTool: AgentTool = {
      name: 'echo',
      description: 'Returns the input string.',
      input: { type: 'object', properties: { text: { type: 'string' } } },
      execute: async (input) => {
        toolCallCount++;
        return (input as { text: string }).text;
      },
    };

    const responses: ChatResponse[] = [
      {
        content: '',
        toolCalls: [{ id: 'tc-1', name: 'echo', arguments: { text: 'hello' } }],
        usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
        model: 'test-1.0',
        stopReason: 'tool_use',
      },
      {
        content: 'The echo says: hello',
        toolCalls: [],
        usage: { inputTokens: 20, outputTokens: 10, totalTokens: 30 },
        model: 'test-1.0',
        stopReason: 'end_turn',
      },
    ];

    let callIndex = 0;
    const provider: LLMProvider = {
      name: 'test',
      async chat() {
        return responses[callIndex++]!;
      },
    };

    const result = await executeAgentLoop(
      { model: 'test-1.0', provider, tools: [echoTool] },
      'Please echo "hello"',
    );

    expect(result.content).toBe('The echo says: hello');
    expect(toolCallCount).toBe(1);
    expect(result.turnCount).toBe(2);
  });
});
