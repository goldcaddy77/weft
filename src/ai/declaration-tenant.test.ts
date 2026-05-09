import { describe, expect, it } from 'bun:test';

import type { AgentTool, ChatResponse, LLMProvider } from './agent/index.ts';
import { executeAgentLoop } from './agent/index.ts';

function pickToolsForTenant(tenant: string): AgentTool[] {
  const analyticsTool: AgentTool = {
    name: 'analytics_lookup',
    description: 'Analytics lookup for tenant Alice.',
    input: { type: 'object' },
    execute: async () => 'analytics',
  };

  const billingTool: AgentTool = {
    name: 'billing_lookup',
    description: 'Billing lookup for tenant Bob.',
    input: { type: 'object' },
    execute: async () => 'billing',
  };

  if (tenant === 'alice') return [analyticsTool];
  if (tenant === 'bob') return [billingTool];
  return [];
}

describe('tenant-specific tool selection', () => {
  it('passes only the selected tenant tools to each direct agent loop invocation', async () => {
    const seenToolNamesByTenant: Record<string, string[][]> = { alice: [], bob: [] };

    function createCapturingProvider(tenant: string): LLMProvider {
      return {
        name: 'capturing',
        async chat(_messages, options): Promise<ChatResponse> {
          seenToolNamesByTenant[tenant]?.push((options.tools ?? []).map((tool) => tool.name));
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
        provider: createCapturingProvider('alice'),
        tools: pickToolsForTenant('alice'),
      },
      'do something',
    );

    await executeAgentLoop(
      {
        model: 'test',
        provider: createCapturingProvider('bob'),
        tools: pickToolsForTenant('bob'),
      },
      'do something',
    );

    expect(seenToolNamesByTenant['alice']?.[0]).toEqual(['analytics_lookup']);
    expect(seenToolNamesByTenant['bob']?.[0]).toEqual(['billing_lookup']);
  });

  it('passes no tools when the tenant has no selected tool set', async () => {
    let seenToolNames: string[] | undefined;
    const provider: LLMProvider = {
      name: 'capturing',
      async chat(_messages, options): Promise<ChatResponse> {
        seenToolNames = (options.tools ?? []).map((tool) => tool.name);
        return {
          content: 'done',
          toolCalls: [],
          usage: { inputTokens: 5, outputTokens: 5, totalTokens: 10 },
          model: 'test',
          stopReason: 'end_turn',
        };
      },
    };

    await executeAgentLoop(
      { model: 'test', provider, tools: pickToolsForTenant('unknown') },
      'do something',
    );

    expect(seenToolNames).toEqual([]);
  });
});
