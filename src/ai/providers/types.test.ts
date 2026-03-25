import { describe, expect, it } from 'bun:test';

import type {
  ChatResponse,
  Message,
  MessageRole,
  StreamChunk,
  TokenUsage,
  ToolCall,
  ToolDefinition,
  ToolResult,
} from './types';

describe('MessageRole', () => {
  it('accepts all valid role values', () => {
    const roles: MessageRole[] = ['system', 'user', 'assistant', 'tool'];
    expect(roles).toHaveLength(4);
  });
});

describe('Message', () => {
  it('can be constructed with required fields', () => {
    const message: Message = { role: 'user', content: 'Hello' };
    expect(message.role).toBe('user');
    expect(message.content).toBe('Hello');
  });

  it('can include optional toolCalls, toolResults, and name', () => {
    const message: Message = {
      role: 'assistant',
      content: 'result',
      toolCalls: [{ id: 'tc-1', name: 'search', input: { query: 'test' } }],
      toolResults: [{ toolCallId: 'tc-1', output: 'found it' }],
      name: 'agent',
    };
    expect(message.toolCalls).toHaveLength(1);
    expect(message.toolResults).toHaveLength(1);
    expect(message.name).toBe('agent');
  });
});

describe('ToolCall', () => {
  it('has id, name, and input', () => {
    const toolCall: ToolCall = { id: 'tc-1', name: 'readFile', input: { path: '/tmp/test' } };
    expect(toolCall.id).toBe('tc-1');
    expect(toolCall.name).toBe('readFile');
    expect(toolCall.input).toEqual({ path: '/tmp/test' });
  });
});

describe('ToolResult', () => {
  it('has toolCallId and output', () => {
    const result: ToolResult = { toolCallId: 'tc-1', output: 'file contents' };
    expect(result.toolCallId).toBe('tc-1');
    expect(result.output).toBe('file contents');
  });

  it('can include optional isError flag', () => {
    const result: ToolResult = { toolCallId: 'tc-2', output: 'not found', isError: true };
    expect(result.isError).toBe(true);
  });
});

describe('ToolDefinition', () => {
  it('has name, description, and inputSchema', () => {
    const definition: ToolDefinition = {
      name: 'search',
      description: 'Search for files',
      inputSchema: { type: 'object', properties: { query: { type: 'string' } } },
    };
    expect(definition.name).toBe('search');
    expect(definition.description).toBe('Search for files');
    expect(definition.inputSchema).toHaveProperty('type', 'object');
  });
});

describe('TokenUsage', () => {
  it('has inputTokens, outputTokens, and totalTokens', () => {
    const usage: TokenUsage = { inputTokens: 100, outputTokens: 50, totalTokens: 150 };
    expect(usage.inputTokens).toBe(100);
    expect(usage.outputTokens).toBe(50);
    expect(usage.totalTokens).toBe(150);
  });
});

describe('StreamChunk', () => {
  it('can represent a token chunk', () => {
    const chunk: StreamChunk = { type: 'token', token: 'Hello' };
    expect(chunk.type).toBe('token');
    expect(chunk.token).toBe('Hello');
  });

  it('can represent a tool call start chunk', () => {
    const chunk: StreamChunk = {
      type: 'tool_call_start',
      toolCall: { id: 'tc-1', name: 'search' },
    };
    expect(chunk.type).toBe('tool_call_start');
    expect(chunk.toolCall?.name).toBe('search');
  });

  it('can represent a done chunk with usage', () => {
    const chunk: StreamChunk = {
      type: 'done',
      usage: { inputTokens: 100, outputTokens: 50, totalTokens: 150 },
    };
    expect(chunk.type).toBe('done');
    expect(chunk.usage?.totalTokens).toBe(150);
  });
});

describe('ChatResponse', () => {
  it('has all required fields', () => {
    const response: ChatResponse = {
      content: 'Hello, world!',
      toolCalls: [],
      usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
      model: 'claude-3-opus',
      stopReason: 'end_turn',
    };
    expect(response.content).toBe('Hello, world!');
    expect(response.toolCalls).toEqual([]);
    expect(response.usage.totalTokens).toBe(15);
    expect(response.model).toBe('claude-3-opus');
    expect(response.stopReason).toBe('end_turn');
  });

  it('accepts all valid stop reasons', () => {
    const reasons: ChatResponse['stopReason'][] = [
      'end_turn',
      'tool_use',
      'max_tokens',
      'stop_sequence',
    ];
    expect(reasons).toHaveLength(4);
  });
});
