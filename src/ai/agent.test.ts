import { describe, expect, it } from 'bun:test';

import type { BudgetTracker } from './budget';
import type { LLMProvider } from './providers/interface';
import type { ChatResponse, Message } from './providers/types';

import type { AgentTool, ToolCallInfo, ToolReturnInfo, TurnInfo, TurnResult } from './agent';
import { executeAgentLoop } from './agent';
import { BudgetExceededError } from './budget';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createMockProvider(responses: ChatResponse[]): LLMProvider {
  let callIndex = 0;
  return {
    name: 'mock',
    async chat(): Promise<ChatResponse> {
      return responses[callIndex++]!;
    },
    async stream() {
      return new ReadableStream();
    },
    async countTokens(): Promise<number> {
      return 100;
    },
  };
}

function createChatResponse(content: string, overrides?: Partial<ChatResponse>): ChatResponse {
  return {
    content,
    toolCalls: [],
    usage: { inputTokens: 10, outputTokens: 20, totalTokens: 30 },
    model: 'test-model',
    stopReason: 'end_turn',
    ...overrides,
  };
}

function createToolCallResponse(
  toolCalls: ChatResponse['toolCalls'],
  overrides?: Partial<ChatResponse>,
): ChatResponse {
  return {
    content: '',
    toolCalls,
    usage: { inputTokens: 10, outputTokens: 20, totalTokens: 30 },
    model: 'test-model',
    stopReason: 'tool_use',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('executeAgentLoop', () => {
  it('returns content from a simple single-turn response with no tools', async () => {
    const provider = createMockProvider([createChatResponse('Hello, world!')]);

    const result = await executeAgentLoop({ model: 'test-model', provider }, 'Say hello');

    expect(result.content).toBe('Hello, world!');
    expect(result.turnCount).toBe(1);
    expect(result.conversation.length).toBeGreaterThan(0);
  });

  it('executes a tool call and returns the final answer', async () => {
    const provider = createMockProvider([
      createToolCallResponse([{ id: 'call-1', name: 'get_weather', input: { city: 'NYC' } }]),
      createChatResponse('The weather in NYC is sunny.'),
    ]);

    const weatherTool: AgentTool = {
      definition: {
        name: 'get_weather',
        description: 'Get weather',
        inputSchema: { type: 'object' },
      },
      execute: async (input: unknown) => {
        const typedInput = input as { city: string };
        return { temp: 72, condition: 'sunny', city: typedInput.city };
      },
    };

    const result = await executeAgentLoop(
      { model: 'test-model', provider, tools: [weatherTool] },
      'What is the weather in NYC?',
    );

    expect(result.content).toBe('The weather in NYC is sunny.');
    expect(result.turnCount).toBe(2);
  });

  it('respects maxTurns limit', async () => {
    // Provider always returns tool calls, never a final answer
    const provider = createMockProvider([
      createToolCallResponse([{ id: 'call-1', name: 'noop', input: {} }]),
      createToolCallResponse([{ id: 'call-2', name: 'noop', input: {} }]),
      createToolCallResponse([{ id: 'call-3', name: 'noop', input: {} }], {
        content: 'Still thinking...',
      }),
    ]);

    const noopTool: AgentTool = {
      definition: {
        name: 'noop',
        description: 'Does nothing',
        inputSchema: { type: 'object' },
      },
      execute: async () => 'ok',
    };

    const result = await executeAgentLoop(
      { model: 'test-model', provider, tools: [noopTool], maxTurns: 3 },
      'Keep going',
    );

    expect(result.turnCount).toBe(3);
    expect(result.content).toBe('Still thinking...');
  });

  it('stops on budget exceeded', async () => {
    const firstResponse = createChatResponse('Before budget exceeded');

    const provider: LLMProvider = {
      name: 'mock',
      async chat(): Promise<ChatResponse> {
        return firstResponse;
      },
      async stream() {
        return new ReadableStream();
      },
      async countTokens(): Promise<number> {
        return 100;
      },
    };

    const mockBudget = {
      checkBudget() {
        throw new BudgetExceededError(
          {
            tokensUsed: 1000,
            costUsed: 10,
            tokensRemaining: 0,
            costRemaining: 0,
            breakdown: [],
          },
          1000,
          10,
        );
      },
      recordUsage() {
        return false;
      },
      budgetRemaining() {
        return {
          tokensUsed: 1000,
          costUsed: 10,
          tokensRemaining: 0,
          costRemaining: 0,
          breakdown: [],
        };
      },
    } as unknown as BudgetTracker;

    const result = await executeAgentLoop(
      { model: 'test-model', provider, budget: mockBudget },
      'Hello',
    );

    // Budget exceeded before first call, so we get empty content
    expect(result.content).toBe('');
    expect(result.turnCount).toBe(0);
  });

  it('stops on abort signal', async () => {
    const controller = new AbortController();
    // Abort immediately
    controller.abort();

    const provider = createMockProvider([createChatResponse('Should not reach this')]);

    const result = await executeAgentLoop(
      { model: 'test-model', provider, signal: controller.signal },
      'Hello',
    );

    expect(result.content).toBe('');
    expect(result.turnCount).toBe(0);
  });

  it('caches tool results for identical tool name and input', async () => {
    let executeCount = 0;

    const provider = createMockProvider([
      createToolCallResponse([{ id: 'call-1', name: 'lookup', input: { key: 'abc' } }]),
      createToolCallResponse([{ id: 'call-2', name: 'lookup', input: { key: 'abc' } }]),
      createChatResponse('Done'),
    ]);

    const lookupTool: AgentTool = {
      definition: {
        name: 'lookup',
        description: 'Lookup a key',
        inputSchema: { type: 'object' },
      },
      execute: async () => {
        executeCount++;
        return { value: 42 };
      },
    };

    const result = await executeAgentLoop(
      { model: 'test-model', provider, tools: [lookupTool] },
      'Lookup abc twice',
    );

    expect(result.content).toBe('Done');
    expect(result.turnCount).toBe(3);
    expect(executeCount).toBe(1);
  });

  it('fires turn callbacks at the correct points', async () => {
    const turnStarted: TurnInfo[] = [];
    const turnCompleted: TurnResult[] = [];

    const provider = createMockProvider([createChatResponse('Answer')]);

    await executeAgentLoop(
      {
        model: 'test-model',
        provider,
        onTurnStarted: (info) => turnStarted.push(info),
        onTurnCompleted: (info) => turnCompleted.push(info),
      },
      'Hello',
    );

    expect(turnStarted).toHaveLength(1);
    expect(turnStarted[0]!.turnIndex).toBe(0);
    expect(turnStarted[0]!.model).toBe('test-model');

    expect(turnCompleted).toHaveLength(1);
    expect(turnCompleted[0]!.turnIndex).toBe(0);
    expect(turnCompleted[0]!.inputTokens).toBe(10);
    expect(turnCompleted[0]!.outputTokens).toBe(20);
  });

  it('fires tool callbacks on tool execution', async () => {
    const toolCalled: ToolCallInfo[] = [];
    const toolReturned: ToolReturnInfo[] = [];

    const provider = createMockProvider([
      createToolCallResponse([{ id: 'call-1', name: 'greet', input: { name: 'World' } }]),
      createChatResponse('Greeted World'),
    ]);

    const greetTool: AgentTool = {
      definition: {
        name: 'greet',
        description: 'Greet someone',
        inputSchema: { type: 'object' },
      },
      execute: async (input: unknown) => {
        const typedInput = input as { name: string };
        return `Hello, ${typedInput.name}!`;
      },
    };

    await executeAgentLoop(
      {
        model: 'test-model',
        provider,
        tools: [greetTool],
        onToolCalled: (info) => toolCalled.push(info),
        onToolReturned: (info) => toolReturned.push(info),
      },
      'Greet World',
    );

    expect(toolCalled).toHaveLength(1);
    expect(toolCalled[0]!.toolName).toBe('greet');
    expect(toolCalled[0]!.turnIndex).toBe(0);

    expect(toolReturned).toHaveLength(1);
    expect(toolReturned[0]!.toolName).toBe('greet');
    expect(toolReturned[0]!.success).toBe(true);
    expect(toolReturned[0]!.duration).toBeGreaterThanOrEqual(0);
  });

  it('handles multiple tool calls in one turn', async () => {
    const executedTools: string[] = [];

    const provider = createMockProvider([
      createToolCallResponse([
        { id: 'call-1', name: 'tool_a', input: { x: 1 } },
        { id: 'call-2', name: 'tool_b', input: { y: 2 } },
      ]),
      createChatResponse('Both tools executed'),
    ]);

    const toolA: AgentTool = {
      definition: {
        name: 'tool_a',
        description: 'Tool A',
        inputSchema: { type: 'object' },
      },
      execute: async () => {
        executedTools.push('tool_a');
        return 'result_a';
      },
    };

    const toolB: AgentTool = {
      definition: {
        name: 'tool_b',
        description: 'Tool B',
        inputSchema: { type: 'object' },
      },
      execute: async () => {
        executedTools.push('tool_b');
        return 'result_b';
      },
    };

    const result = await executeAgentLoop(
      { model: 'test-model', provider, tools: [toolA, toolB] },
      'Use both tools',
    );

    expect(result.content).toBe('Both tools executed');
    expect(executedTools).toContain('tool_a');
    expect(executedTools).toContain('tool_b');
    expect(result.turnCount).toBe(2);
  });

  it('includes system prompt in conversation when provided', async () => {
    let capturedMessages: Message[] = [];

    const provider: LLMProvider = {
      name: 'mock',
      async chat(messages): Promise<ChatResponse> {
        capturedMessages = messages;
        return createChatResponse('Response');
      },
      async stream() {
        return new ReadableStream();
      },
      async countTokens(): Promise<number> {
        return 100;
      },
    };

    await executeAgentLoop(
      {
        model: 'test-model',
        provider,
        systemPrompt: 'You are a helpful assistant.',
      },
      'Hello',
    );

    expect(capturedMessages[0]!.role).toBe('system');
    expect(capturedMessages[0]!.content).toBe('You are a helpful assistant.');
  });

  it('tracks total token usage and cost correctly', async () => {
    const provider = createMockProvider([
      createToolCallResponse([{ id: 'call-1', name: 'noop', input: {} }], {
        usage: { inputTokens: 100, outputTokens: 50, totalTokens: 150 },
      }),
      createChatResponse('Done', {
        usage: { inputTokens: 200, outputTokens: 75, totalTokens: 275 },
      }),
    ]);

    const noopTool: AgentTool = {
      definition: {
        name: 'noop',
        description: 'No-op',
        inputSchema: { type: 'object' },
      },
      execute: async () => 'ok',
    };

    const result = await executeAgentLoop(
      { model: 'test-model', provider, tools: [noopTool] },
      'Track tokens',
    );

    expect(result.totalTokens.inputTokens).toBe(300);
    expect(result.totalTokens.outputTokens).toBe(125);
    expect(result.totalTokens.totalTokens).toBe(425);
    expect(result.turnCount).toBe(2);
  });

  it('works with an empty tools list', async () => {
    const provider = createMockProvider([createChatResponse('No tools available')]);

    const result = await executeAgentLoop({ model: 'test-model', provider, tools: [] }, 'Hello');

    expect(result.content).toBe('No tools available');
    expect(result.turnCount).toBe(1);
  });
});
