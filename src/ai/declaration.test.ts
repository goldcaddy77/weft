import { describe, expect, it } from 'bun:test';
import { z } from 'zod';

import type { AgentToolDefinition } from './declaration.ts';
import { agent as createAgentDefinition, isAgentDefinition } from './declaration.ts';

const sampleTool: AgentToolDefinition = {
  name: 'lookup',
  description: 'Looks up a value.',
  input: { type: 'object', properties: { id: { type: 'string' } } },
  execute: async () => 'value',
};

describe('agent', () => {
  it('creates an agent definition with the required name and model', () => {
    const agentDefinition = createAgentDefinition({ name: 'assistant', model: 'claude-3' });

    expect(agentDefinition.name).toBe('assistant');
    expect(agentDefinition.model).toBe('claude-3');
    expect(agentDefinition.version).toBe('0.0.0');
    expect(isAgentDefinition(agentDefinition)).toBe(true);
  });

  it('preserves the explicit version', () => {
    const agentDefinition = createAgentDefinition({
      name: 'assistant',
      model: 'claude-3',
      version: '1.2.3',
    });

    expect(agentDefinition.version).toBe('1.2.3');
  });

  it('preserves static tools', () => {
    const agentDefinition = createAgentDefinition({
      name: 'assistant',
      model: 'claude-3',
      tools: [sampleTool],
    });

    expect(agentDefinition.tools).toEqual([sampleTool]);
  });

  it('preserves maxTurns', () => {
    const agentDefinition = createAgentDefinition({
      name: 'assistant',
      model: 'claude-3',
      maxTurns: 5,
    });

    expect(agentDefinition.maxTurns).toBe(5);
  });

  it('preserves systemPrompt', () => {
    const agentDefinition = createAgentDefinition({
      name: 'assistant',
      model: 'claude-3',
      systemPrompt: 'Answer briefly.',
    });

    expect(agentDefinition.systemPrompt).toBe('Answer briefly.');
  });

  it('preserves description', () => {
    const agentDefinition = createAgentDefinition({
      name: 'assistant',
      model: 'claude-3',
      description: 'A compact assistant.',
    });

    expect(agentDefinition.description).toBe('A compact assistant.');
  });

  it('preserves a Standard Schema inputSchema', () => {
    const inputSchema = z.object({ question: z.string() });
    const agentDefinition = createAgentDefinition({
      name: 'assistant',
      model: 'claude-3',
      inputSchema,
    });

    expect(agentDefinition.inputSchema).toBe(inputSchema);
  });

  it('preserves a Standard Schema outputSchema', () => {
    const outputSchema = z.object({ answer: z.string() });
    const agentDefinition = createAgentDefinition({
      name: 'assistant',
      model: 'claude-3',
      outputSchema,
    });

    expect(agentDefinition.outputSchema).toBe(outputSchema);
  });

  it('rejects an inputSchema that is not Standard Schema-shaped', () => {
    expect(() =>
      createAgentDefinition({
        name: 'assistant',
        model: 'claude-3',
        inputSchema: { not: 'a schema' } as never,
      }),
    ).toThrow(/Standard Schema-compatible/);
  });

  it('carries generic input and output phantom types without runtime fields', () => {
    const agentDefinition = createAgentDefinition<{ question: string }, { answer: string }>({
      name: 'typed-assistant',
      model: 'claude-3',
    });

    expect(agentDefinition.name).toBe('typed-assistant');
    expect(Object.hasOwn(agentDefinition, '_inputType')).toBe(false);
    expect(Object.hasOwn(agentDefinition, '_outputType')).toBe(false);
  });
});

describe('isAgentDefinition', () => {
  it('returns true for values created by agent', () => {
    const agentDefinition = createAgentDefinition({ name: 'assistant', model: 'claude-3' });

    expect(isAgentDefinition(agentDefinition)).toBe(true);
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
