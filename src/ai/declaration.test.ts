import { describe, expect, it } from 'bun:test';

import { defineAgent, type AgentToolDefinition } from './declaration.ts';
import type { AgentHooks } from './hooks.ts';

describe('defineAgent', () => {
  it('returns an AgentDefinition with all fields', () => {
    const tool: AgentToolDefinition = {
      definition: {
        name: 'search',
        description: 'Search for information',
        inputSchema: { type: 'object', properties: { query: { type: 'string' } } },
      },
      execute: async (_input: unknown) => ({ results: [] }),
    };

    const hooks: AgentHooks = {
      beforeTurn: () => ({ action: 'continue' as const }),
      afterToolCall: () => ({ action: 'continue' as const }),
      onBudgetWarning: () => {},
    };

    const agent = defineAgent({
      name: 'research-agent',
      model: 'gpt-4',
      systemPrompt: 'You are a research assistant.',
      tools: [tool],
      maxTurns: 10,
      budget: { models: { 'gpt-4': { inputCostPer1K: 0.03, outputCostPer1K: 0.06 } } },
      hooks,
      description: 'A research agent',
    });

    expect(agent.name).toBe('research-agent');
    expect(agent.model).toBe('gpt-4');
    expect(agent.systemPrompt).toBe('You are a research assistant.');
    expect(agent.tools).toHaveLength(1);
    expect(agent.maxTurns).toBe(10);
    expect(agent.budget).toBeDefined();
    expect(agent.hooks).toBe(hooks);
    expect(agent.description).toBe('A research agent');
  });

  it('with minimal options uses defaults', () => {
    const agent = defineAgent({
      name: 'minimal-agent',
      model: 'gpt-3.5',
    });

    expect(agent.name).toBe('minimal-agent');
    expect(agent.model).toBe('gpt-3.5');
    expect(agent.systemPrompt).toBeUndefined();
    expect(agent.tools).toBeUndefined();
    expect(agent.maxTurns).toBeUndefined();
    expect(agent.budget).toBeUndefined();
    expect(agent.hooks).toBeUndefined();
    expect(agent.description).toBeUndefined();
  });

  it('requires name (type-level enforcement)', () => {
    // Name is required at the type level. Passing it ensures it appears in the output.
    const agent = defineAgent({ name: 'must-have-name', model: 'gpt-4' });
    expect(agent.name).toBe('must-have-name');
  });

  it('requires model (type-level enforcement)', () => {
    // Model is required at the type level. Passing it ensures it appears in the output.
    const agent = defineAgent({ name: 'test', model: 'claude-3-opus' });
    expect(agent.model).toBe('claude-3-opus');
  });

  it('preserves tools array', () => {
    const toolA: AgentToolDefinition = {
      definition: {
        name: 'tool-a',
        description: 'First tool',
        inputSchema: {},
      },
      execute: async () => 'a',
    };

    const toolB: AgentToolDefinition = {
      definition: {
        name: 'tool-b',
        description: 'Second tool',
        inputSchema: {},
      },
      execute: async () => 'b',
    };

    const agent = defineAgent({
      name: 'multi-tool-agent',
      model: 'gpt-4',
      tools: [toolA, toolB],
    });

    expect(agent.tools).toHaveLength(2);
    expect(agent.tools![0]!.definition.name).toBe('tool-a');
    expect(agent.tools![1]!.definition.name).toBe('tool-b');
  });

  it('preserves hooks', () => {
    const hooks: AgentHooks = {
      beforeTurn: () => ({ action: 'skip' as const, result: 'nope' }),
    };

    const agent = defineAgent({
      name: 'hooked-agent',
      model: 'gpt-4',
      hooks,
    });

    expect(agent.hooks).toBe(hooks);
    expect(agent.hooks!.beforeTurn).toBeDefined();
  });

  it('returns a plain object (not a class instance)', () => {
    const agent = defineAgent({ name: 'plain', model: 'gpt-4' });

    // A plain object's constructor is Object
    expect(agent.constructor).toBe(Object);
    expect(typeof agent).toBe('object');
    expect(agent).not.toBeInstanceOf(Array);
  });
});
