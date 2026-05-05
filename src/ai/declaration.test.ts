import { describe, expect, it } from 'bun:test';

import type { AgentToolDefinition } from './declaration.ts';
import { defineAgent, isAgentDefinition } from './declaration.ts';

const sampleTool: AgentToolDefinition = {
  definition: {
    name: 'lookup',
    description: 'Looks up a value.',
    inputSchema: { type: 'object', properties: { id: { type: 'string' } } },
  },
  execute: async () => 'value',
};

describe('defineAgent', () => {
  it('creates an agent definition with the required name and model', () => {
    const agent = defineAgent({ name: 'assistant', model: 'claude-3' });

    expect(agent.name).toBe('assistant');
    expect(agent.model).toBe('claude-3');
    expect(agent.version).toBe('0.0.0');
    expect(isAgentDefinition(agent)).toBe(true);
  });

  it('preserves the explicit version', () => {
    const agent = defineAgent({ name: 'assistant', model: 'claude-3', version: '1.2.3' });

    expect(agent.version).toBe('1.2.3');
  });

  it('preserves static tools', () => {
    const agent = defineAgent({ name: 'assistant', model: 'claude-3', tools: [sampleTool] });

    expect(agent.tools).toEqual([sampleTool]);
  });

  it('preserves maxTurns', () => {
    const agent = defineAgent({ name: 'assistant', model: 'claude-3', maxTurns: 5 });

    expect(agent.maxTurns).toBe(5);
  });

  it('preserves systemPrompt', () => {
    const agent = defineAgent({
      name: 'assistant',
      model: 'claude-3',
      systemPrompt: 'Answer briefly.',
    });

    expect(agent.systemPrompt).toBe('Answer briefly.');
  });

  it('preserves description', () => {
    const agent = defineAgent({
      name: 'assistant',
      model: 'claude-3',
      description: 'A compact assistant.',
    });

    expect(agent.description).toBe('A compact assistant.');
  });

  it('carries generic input and output phantom types without runtime fields', () => {
    const agent = defineAgent<{ question: string }, { answer: string }>({
      name: 'typed-assistant',
      model: 'claude-3',
    });

    expect(agent.name).toBe('typed-assistant');
    expect(Object.hasOwn(agent, '_inputType')).toBe(false);
    expect(Object.hasOwn(agent, '_outputType')).toBe(false);
  });
});

describe('isAgentDefinition', () => {
  it('returns true for values created by defineAgent', () => {
    const agent = defineAgent({ name: 'assistant', model: 'claude-3' });

    expect(isAgentDefinition(agent)).toBe(true);
  });

  it('returns false for null and non-objects', () => {
    expect(isAgentDefinition(null)).toBe(false);
    expect(isAgentDefinition(undefined)).toBe(false);
    expect(isAgentDefinition('agent')).toBe(false);
  });

  it('returns false for plain objects with matching fields but no brand', () => {
    expect(isAgentDefinition({ name: 'assistant', model: 'claude-3' })).toBe(false);
  });

  it('returns false when branded objects are missing required string fields', () => {
    expect(
      isAgentDefinition({
        _brand: '__weft_agent_definition__',
        name: 'assistant',
        model: 123,
      }),
    ).toBe(false);
  });
});
