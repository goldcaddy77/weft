import { describe, expect, it } from 'bun:test';

import type { AgentTool, ChatResponse, LLMProvider } from '../../agent/index.ts';
import { executeAgentLoop } from '../../agent/index.ts';

function pickToolsForTenant(tenant: string): AgentTool[] {
  const toolA: AgentTool = {
    name: 'tool_a',
    description: 'Tool for tenant A',
    input: {},
    execute: async () => 'result-a',
  };
  const toolB: AgentTool = {
    name: 'tool_b',
    description: 'Tool for tenant B',
    input: {},
    execute: async () => 'result-b',
  };
  if (tenant === 'alice') return [toolA];
  if (tenant === 'bob') return [toolB];
  return [];
}

describe('tenant tool isolation', () => {
  it('tenant A only sees tool_a, tenant B only sees tool_b', async () => {
    const seenToolsByTenant: Record<string, string[][]> = { alice: [], bob: [] };

    function makeCapturingProvider(tenant: string): LLMProvider {
      return {
        name: 'capturing',
        async chat(_messages, options): Promise<ChatResponse> {
          const toolNames = (options.tools ?? []).map((tool) => tool.name);
          seenToolsByTenant[tenant]!.push(toolNames);
          return {
            content: `done for ${tenant}`,
            toolCalls: [],
            usage: { inputTokens: 5, outputTokens: 5, totalTokens: 10 },
            model: 'test',
            stopReason: 'end_turn',
          };
        },
      };
    }

    await executeAgentLoop(
      {
        model: 'test',
        provider: makeCapturingProvider('alice'),
        tools: pickToolsForTenant('alice'),
      },
      'do something',
    );

    await executeAgentLoop(
      { model: 'test', provider: makeCapturingProvider('bob'), tools: pickToolsForTenant('bob') },
      'do something',
    );

    expect(seenToolsByTenant['alice']![0]).toContain('tool_a');
    expect(seenToolsByTenant['alice']![0]).not.toContain('tool_b');
    expect(seenToolsByTenant['bob']![0]).toContain('tool_b');
    expect(seenToolsByTenant['bob']![0]).not.toContain('tool_a');
  });
});
