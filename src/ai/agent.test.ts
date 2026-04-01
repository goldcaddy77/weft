import { describe, expect, it } from 'bun:test';

import type { LLMProvider } from './providers/interface';
import type { ChatResponse, Message } from './providers/types';

import type { AgentTool, ToolCallInfo, ToolReturnInfo, TurnInfo, TurnResult } from './agent';
import { executeAgentLoop } from './agent';
import { BudgetExceededError, BudgetTracker } from './budget';
import { AgentModelFallbackEvent, AgentTurnCompletedEvent } from './events';
import type { ModelRouter, RoutingContext } from './model-router';

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

  it('uses modelRouter to select a different model per turn', async () => {
    const capturedModels: string[] = [];

    const provider: LLMProvider = {
      name: 'mock',
      async chat(_messages, options): Promise<ChatResponse> {
        capturedModels.push(options.model);
        if (capturedModels.length === 1) {
          return createToolCallResponse([{ id: 'call-1', name: 'noop', input: {} }]);
        }
        return createChatResponse('Done');
      },
      async stream() {
        return new ReadableStream();
      },
      async countTokens(): Promise<number> {
        return 100;
      },
    };

    const noopTool: AgentTool = {
      definition: {
        name: 'noop',
        description: 'No-op',
        inputSchema: { type: 'object' },
      },
      execute: async () => 'ok',
    };

    const modelRouter = {
      select(context: any) {
        return {
          model: context.turnIndex === 0 ? 'expensive-model' : 'cheap-model',
        };
      },
    };

    const result = await executeAgentLoop(
      {
        model: 'default-model',
        provider,
        tools: [noopTool],
        modelRouter,
      },
      'Hello',
    );

    expect(result.turnCount).toBe(2);
    expect(capturedModels[0]).toBe('expensive-model');
    expect(capturedModels[1]).toBe('cheap-model');
  });

  it('uses modelRouter with budget remaining info', async () => {
    let capturedRoutingContext: any;

    const provider = createMockProvider([createChatResponse('Done')]);

    const modelRouter = {
      select(context: any) {
        capturedRoutingContext = context;
        return { model: 'routed-model' };
      },
    };

    const mockBudget = {
      checkBudget() {},
      recordUsage() {
        return true;
      },
      budgetRemaining() {
        return {
          tokensUsed: 100,
          costUsed: 0.5,
          tokensRemaining: 9900,
          costRemaining: 9.5,
          breakdown: [],
        };
      },
    } as unknown as BudgetTracker;

    await executeAgentLoop(
      {
        model: 'default-model',
        provider,
        modelRouter,
        budget: mockBudget,
      },
      'Hello',
    );

    expect(capturedRoutingContext).toBeDefined();
    expect(capturedRoutingContext.budgetRemaining).toEqual({
      tokensRemaining: 9900,
      costRemaining: 9.5,
    });
  });

  it('triggers context window compaction when contextManager says to compact', async () => {
    let sentMessageCount = 0;

    const provider: LLMProvider = {
      name: 'mock',
      async chat(messages): Promise<ChatResponse> {
        // Capture count at call time since the array reference may be mutated
        sentMessageCount = messages.length;
        return createChatResponse('Done');
      },
      async stream() {
        return new ReadableStream();
      },
      async countTokens(): Promise<number> {
        return 5000; // high token count to trigger compaction
      },
    };

    const contextManager = {
      shouldCompact(tokenCount: number): boolean {
        return tokenCount > 1000;
      },
      async compact(messages: Message[]) {
        // Drop all but the last message
        const compacted = messages.slice(-1);
        return {
          messages: compacted,
          tokensBefore: 5000,
          tokensAfter: 100,
          messagesDropped: messages.length - 1,
        };
      },
    } as any;

    await executeAgentLoop(
      {
        model: 'test-model',
        provider,
        contextManager,
        systemPrompt: 'You are helpful.',
      },
      'Hello',
    );

    // The context manager compacted to only the last message
    expect(sentMessageCount).toBe(1);
  });

  it('does not compact when contextManager says not to', async () => {
    let sentMessageCount = 0;
    let firstMessageRole = '';

    const provider: LLMProvider = {
      name: 'mock',
      async chat(messages): Promise<ChatResponse> {
        // Capture at call time since the array may be mutated after
        sentMessageCount = messages.length;
        firstMessageRole = messages[0]!.role;
        return createChatResponse('Done');
      },
      async stream() {
        return new ReadableStream();
      },
      async countTokens(): Promise<number> {
        return 50; // low token count
      },
    };

    const contextManager = {
      shouldCompact(): boolean {
        return false;
      },
      async compact(messages: Message[]) {
        return {
          messages,
          tokensBefore: 50,
          tokensAfter: 50,
          messagesDropped: 0,
        };
      },
    } as any;

    await executeAgentLoop(
      {
        model: 'test-model',
        provider,
        contextManager,
      },
      'Hello',
    );

    // Should have user message only (no system prompt)
    expect(sentMessageCount).toBe(1);
    expect(firstMessageRole).toBe('user');
  });

  it('records success in health tracker on successful LLM call', async () => {
    const healthEvents: { type: string; provider: string }[] = [];

    const provider = createMockProvider([createChatResponse('Done')]);

    const healthTracker = {
      recordSuccess(providerName: string) {
        healthEvents.push({ type: 'success', provider: providerName });
      },
      recordFailure(providerName: string) {
        healthEvents.push({ type: 'failure', provider: providerName });
      },
    } as any;

    await executeAgentLoop(
      {
        model: 'test-model',
        provider,
        healthTracker,
      },
      'Hello',
    );

    expect(healthEvents).toHaveLength(1);
    expect(healthEvents[0]!.type).toBe('success');
    expect(healthEvents[0]!.provider).toBe('mock');
  });

  it('records failure in health tracker when LLM call throws', async () => {
    const healthEvents: { type: string; provider: string }[] = [];

    const provider: LLMProvider = {
      name: 'mock',
      async chat(): Promise<ChatResponse> {
        throw new Error('Provider down');
      },
      async stream() {
        return new ReadableStream();
      },
      async countTokens(): Promise<number> {
        return 100;
      },
    };

    const healthTracker = {
      recordSuccess(providerName: string) {
        healthEvents.push({ type: 'success', provider: providerName });
      },
      recordFailure(providerName: string) {
        healthEvents.push({ type: 'failure', provider: providerName });
      },
    } as any;

    await expect(
      executeAgentLoop(
        {
          model: 'test-model',
          provider,
          healthTracker,
        },
        'Hello',
      ),
    ).rejects.toThrow('Provider down');

    expect(healthEvents).toHaveLength(1);
    expect(healthEvents[0]!.type).toBe('failure');
    expect(healthEvents[0]!.provider).toBe('mock');
  });

  it('handles tool execution that throws an error', async () => {
    const provider = createMockProvider([
      createToolCallResponse([{ id: 'call-1', name: 'failing_tool', input: {} }]),
      createChatResponse('Tool failed, but I handled it'),
    ]);

    const failingTool: AgentTool = {
      definition: {
        name: 'failing_tool',
        description: 'A tool that always fails',
        inputSchema: { type: 'object' },
      },
      execute: async () => {
        throw new Error('Tool execution failed');
      },
    };

    const toolReturned: ToolReturnInfo[] = [];

    const result = await executeAgentLoop(
      {
        model: 'test-model',
        provider,
        tools: [failingTool],
        onToolReturned: (info) => toolReturned.push(info),
      },
      'Use the tool',
    );

    expect(result.content).toBe('Tool failed, but I handled it');
    expect(toolReturned).toHaveLength(1);
    expect(toolReturned[0]!.success).toBe(false);
  });

  it('handles tool execution that throws a non-Error value', async () => {
    const provider = createMockProvider([
      createToolCallResponse([{ id: 'call-1', name: 'string_throw', input: {} }]),
      createChatResponse('Handled'),
    ]);

    const stringThrowTool: AgentTool = {
      definition: {
        name: 'string_throw',
        description: 'Throws a string',
        inputSchema: { type: 'object' },
      },
      execute: async () => {
        throw 'raw string error';
      },
    };

    const result = await executeAgentLoop(
      {
        model: 'test-model',
        provider,
        tools: [stringThrowTool],
      },
      'Use the tool',
    );

    expect(result.content).toBe('Handled');
  });

  it('handles LLM returning tool call for unknown tool', async () => {
    const provider = createMockProvider([
      createToolCallResponse([{ id: 'call-1', name: 'nonexistent_tool', input: {} }]),
      createChatResponse('Handled missing tool'),
    ]);

    const toolReturned: ToolReturnInfo[] = [];

    const result = await executeAgentLoop(
      {
        model: 'test-model',
        provider,
        tools: [],
        onToolReturned: (info) => toolReturned.push(info),
      },
      'Use a tool',
    );

    expect(result.content).toBe('Handled missing tool');
    expect(toolReturned).toHaveLength(1);
    expect(toolReturned[0]!.success).toBe(false);
  });

  it('passes signal to provider chat options', async () => {
    let capturedSignal: AbortSignal | undefined;

    const provider: LLMProvider = {
      name: 'mock',
      async chat(_messages, options): Promise<ChatResponse> {
        capturedSignal = options.signal;
        return createChatResponse('Done');
      },
      async stream() {
        return new ReadableStream();
      },
      async countTokens(): Promise<number> {
        return 100;
      },
    };

    const controller = new AbortController();

    await executeAgentLoop(
      {
        model: 'test-model',
        provider,
        signal: controller.signal,
      },
      'Hello',
    );

    expect(capturedSignal).toBe(controller.signal);
  });

  it('records budget usage on each turn', async () => {
    const usageRecords: { model: string; input: number; output: number }[] = [];

    const provider = createMockProvider([
      createToolCallResponse([{ id: 'call-1', name: 'noop', input: {} }], {
        usage: { inputTokens: 50, outputTokens: 25, totalTokens: 75 },
      }),
      createChatResponse('Done', {
        usage: { inputTokens: 100, outputTokens: 50, totalTokens: 150 },
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

    const mockBudget = {
      checkBudget() {},
      recordUsage(model: string, inputTokens: number, outputTokens: number) {
        usageRecords.push({ model, input: inputTokens, output: outputTokens });
        return true;
      },
      budgetRemaining() {
        return {
          tokensUsed: 0,
          costUsed: 0,
          tokensRemaining: 100000,
          costRemaining: 100,
          breakdown: [],
        };
      },
    } as unknown as BudgetTracker;

    await executeAgentLoop(
      {
        model: 'test-model',
        provider,
        tools: [noopTool],
        budget: mockBudget,
      },
      'Hello',
    );

    expect(usageRecords).toHaveLength(2);
    expect(usageRecords[0]).toEqual({ model: 'test-model', input: 50, output: 25 });
    expect(usageRecords[1]).toEqual({ model: 'test-model', input: 100, output: 50 });
  });

  it('re-throws non-BudgetExceededError from budget.checkBudget', async () => {
    const provider = createMockProvider([createChatResponse('Should not reach')]);

    const mockBudget = {
      checkBudget() {
        throw new Error('Unexpected error in budget');
      },
      recordUsage() {
        return true;
      },
      budgetRemaining() {
        return {
          tokensUsed: 0,
          costUsed: 0,
          tokensRemaining: 0,
          costRemaining: 0,
          breakdown: [],
        };
      },
    } as unknown as BudgetTracker;

    await expect(
      executeAgentLoop({ model: 'test-model', provider, budget: mockBudget }, 'Hello'),
    ).rejects.toThrow('Unexpected error in budget');
  });

  it('fires turn-completed callback with tool call count for tool turns', async () => {
    const turnResults: TurnResult[] = [];

    const provider = createMockProvider([
      createToolCallResponse([
        { id: 'call-1', name: 'tool_a', input: {} },
        { id: 'call-2', name: 'tool_b', input: {} },
      ]),
      createChatResponse('Done'),
    ]);

    const toolA: AgentTool = {
      definition: { name: 'tool_a', description: 'Tool A', inputSchema: { type: 'object' } },
      execute: async () => 'a',
    };
    const toolB: AgentTool = {
      definition: { name: 'tool_b', description: 'Tool B', inputSchema: { type: 'object' } },
      execute: async () => 'b',
    };

    await executeAgentLoop(
      {
        model: 'test-model',
        provider,
        tools: [toolA, toolB],
        onTurnCompleted: (info) => turnResults.push(info),
      },
      'Use tools',
    );

    expect(turnResults).toHaveLength(2);
    expect(turnResults[0]!.toolCallCount).toBe(2);
    expect(turnResults[1]!.toolCallCount).toBe(0);
  });

  it('hooks.beforeTurn with action continue and modified messages uses them', async () => {
    let capturedMessages: Message[] = [];

    const provider: LLMProvider = {
      name: 'mock',
      async chat(messages): Promise<ChatResponse> {
        capturedMessages = [...messages];
        return createChatResponse('Done');
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
        hooks: {
          beforeTurn: (_context) => {
            return {
              action: 'continue',
              messages: [
                { role: 'system', content: 'Injected system prompt' },
                { role: 'user', content: 'Modified user message' },
              ],
            };
          },
        },
      },
      'Original message',
    );

    expect(capturedMessages).toHaveLength(2);
    expect(capturedMessages[0]!.content).toBe('Injected system prompt');
    expect(capturedMessages[1]!.content).toBe('Modified user message');
  });

  it('hooks.beforeTurn with action skip stops the loop and sets content', async () => {
    const provider = createMockProvider([createChatResponse('Should not reach')]);

    const result = await executeAgentLoop(
      {
        model: 'test-model',
        provider,
        hooks: {
          beforeTurn: (_context) => {
            return { action: 'skip', result: 'Skipped by policy' };
          },
        },
      },
      'Hello',
    );

    expect(result.content).toBe('Skipped by policy');
    expect(result.turnCount).toBe(0);
  });

  it('hooks.afterToolCall with action continue and modified result uses it', async () => {
    let capturedToolResultMessages: Message[] = [];

    const provider: LLMProvider = {
      name: 'mock',
      async chat(messages): Promise<ChatResponse> {
        capturedToolResultMessages = [...messages];
        if (messages.length <= 1) {
          return createToolCallResponse([{ id: 'call-1', name: 'lookup', input: {} }]);
        }
        return createChatResponse('Done');
      },
      async stream() {
        return new ReadableStream();
      },
      async countTokens(): Promise<number> {
        return 100;
      },
    };

    const lookupTool: AgentTool = {
      definition: {
        name: 'lookup',
        description: 'Lookup',
        inputSchema: { type: 'object' },
      },
      execute: async () => 'original-result',
    };

    await executeAgentLoop(
      {
        model: 'test-model',
        provider,
        tools: [lookupTool],
        hooks: {
          afterToolCall: (_context) => {
            return { action: 'continue', result: 'modified-result' };
          },
        },
      },
      'Lookup something',
    );

    // The tool message should contain the modified result
    const toolMessage = capturedToolResultMessages.find((message) => message.role === 'tool');
    expect(toolMessage).toBeDefined();
    expect(toolMessage!.toolResults![0]!.output).toBe('modified-result');
  });

  it('hooks.afterToolCall with action reject replaces output with error', async () => {
    let capturedToolResultMessages: Message[] = [];

    const provider: LLMProvider = {
      name: 'mock',
      async chat(messages): Promise<ChatResponse> {
        capturedToolResultMessages = [...messages];
        if (messages.length <= 1) {
          return createToolCallResponse([{ id: 'call-1', name: 'danger', input: {} }]);
        }
        return createChatResponse('Handled rejection');
      },
      async stream() {
        return new ReadableStream();
      },
      async countTokens(): Promise<number> {
        return 100;
      },
    };

    const dangerTool: AgentTool = {
      definition: {
        name: 'danger',
        description: 'A dangerous tool',
        inputSchema: { type: 'object' },
      },
      execute: async () => 'dangerous-output',
    };

    const toolReturned: ToolReturnInfo[] = [];

    const result = await executeAgentLoop(
      {
        model: 'test-model',
        provider,
        tools: [dangerTool],
        hooks: {
          afterToolCall: (_context) => {
            return { action: 'reject', reason: 'Unsafe operation blocked' };
          },
        },
        onToolReturned: (info) => toolReturned.push(info),
      },
      'Use dangerous tool',
    );

    expect(result.content).toBe('Handled rejection');

    // The tool result should be marked as error
    const toolMessage = capturedToolResultMessages.find((message) => message.role === 'tool');
    expect(toolMessage).toBeDefined();
    expect(toolMessage!.toolResults![0]!.isError).toBe(true);
    expect(toolMessage!.toolResults![0]!.output).toContain('Unsafe operation blocked');

    // The toolReturned callback should report failure
    expect(toolReturned).toHaveLength(1);
    expect(toolReturned[0]!.success).toBe(false);
  });

  it('hooks.onBudgetWarning fires when budget crosses 80% threshold', async () => {
    // Budget: maxTokens = 100. Each response uses 30 tokens (10 input + 20 output).
    // After 3 turns: 90 tokens used = 90% > 80% threshold.
    const provider = createMockProvider([
      createToolCallResponse([{ id: 'call-1', name: 'noop', input: {} }]),
      createToolCallResponse([{ id: 'call-2', name: 'noop', input: {} }]),
      createChatResponse('Done'),
    ]);

    const budget = new BudgetTracker({
      maxTokens: 100,
      models: { 'test-model': { inputCostPer1K: 0, outputCostPer1K: 0 } },
    });

    const noopTool: AgentTool = {
      definition: { name: 'noop', description: 'No-op', inputSchema: { type: 'object' } },
      execute: async () => 'ok',
    };

    let warningContext: import('./hooks').BudgetWarningContext | undefined;
    const result = await executeAgentLoop(
      {
        model: 'test-model',
        provider,
        tools: [noopTool],
        budget,
        hooks: {
          onBudgetWarning: (context) => {
            warningContext = context;
          },
        },
      },
      'Hello',
    );

    expect(result.content).toBe('Done');
    expect(warningContext).toBeDefined();
    expect(warningContext!.budgetUsedPercent).toBeGreaterThanOrEqual(80);
    expect(warningContext!.tokensRemaining).toBeLessThan(100);
  });

  it('hooks.onBudgetWarning fires only once across multiple turns', async () => {
    // Budget: maxTokens = 100. Each turn uses 30 tokens.
    // Turn 1: 30% — no warning. Turn 2: 60% — no warning. Turn 3: 90% — warning.
    // Turn 4 would also be above threshold, but warning should not fire again.
    const provider = createMockProvider([
      createToolCallResponse([{ id: 'call-1', name: 'noop', input: {} }]),
      createToolCallResponse([{ id: 'call-2', name: 'noop', input: {} }]),
      createToolCallResponse([{ id: 'call-3', name: 'noop', input: {} }]),
      createChatResponse('Done'),
    ]);

    const budget = new BudgetTracker({
      maxTokens: 100,
      models: { 'test-model': { inputCostPer1K: 0, outputCostPer1K: 0 } },
    });

    const noopTool: AgentTool = {
      definition: { name: 'noop', description: 'No-op', inputSchema: { type: 'object' } },
      execute: async () => 'ok',
    };

    let warningCallCount = 0;
    await executeAgentLoop(
      {
        model: 'test-model',
        provider,
        tools: [noopTool],
        budget,
        hooks: {
          onBudgetWarning: () => {
            warningCallCount++;
          },
        },
      },
      'Hello',
    );

    expect(warningCallCount).toBe(1);
  });

  it('hooks.onBudgetWarning does not fire when budget is below threshold', async () => {
    // Budget: maxTokens = 1000. One turn uses 30 tokens = 3% — well below 80%.
    const provider = createMockProvider([createChatResponse('Done')]);

    const budget = new BudgetTracker({
      maxTokens: 1000,
      models: { 'test-model': { inputCostPer1K: 0, outputCostPer1K: 0 } },
    });

    let warningCalled = false;
    const result = await executeAgentLoop(
      {
        model: 'test-model',
        provider,
        budget,
        hooks: {
          onBudgetWarning: () => {
            warningCalled = true;
          },
        },
      },
      'Hello',
    );

    expect(result.content).toBe('Done');
    expect(warningCalled).toBe(false);
  });

  it('hooks.onBudgetWarning is not called when no budget tracker is provided', async () => {
    const provider = createMockProvider([createChatResponse('Done')]);

    let warningCalled = false;
    const result = await executeAgentLoop(
      {
        model: 'test-model',
        provider,
        hooks: {
          onBudgetWarning: () => {
            warningCalled = true;
          },
        },
      },
      'Hello',
    );

    expect(result.content).toBe('Done');
    expect(warningCalled).toBe(false);
  });

  it('dispatches events to eventTarget when provided', async () => {
    const provider = createMockProvider([
      createToolCallResponse([{ id: 'call-1', name: 'noop', input: {} }]),
      createChatResponse('Done'),
    ]);

    const noopTool: AgentTool = {
      definition: {
        name: 'noop',
        description: 'No-op',
        inputSchema: { type: 'object' },
      },
      execute: async () => 'ok',
    };

    const eventTarget = new EventTarget();
    const receivedEvents: string[] = [];

    eventTarget.addEventListener('agent:turn:started', () => {
      receivedEvents.push('agent:turn:started');
    });
    eventTarget.addEventListener('agent:turn:completed', () => {
      receivedEvents.push('agent:turn:completed');
    });
    eventTarget.addEventListener('agent:tool:called', () => {
      receivedEvents.push('agent:tool:called');
    });
    eventTarget.addEventListener('agent:tool:returned', () => {
      receivedEvents.push('agent:tool:returned');
    });

    await executeAgentLoop(
      {
        model: 'test-model',
        provider,
        tools: [noopTool],
        eventTarget,
        workflowId: 'wf-event-test',
        agentId: 'agent-event-test',
      },
      'Use a tool',
    );

    expect(receivedEvents).toContain('agent:turn:started');
    expect(receivedEvents).toContain('agent:turn:completed');
    expect(receivedEvents).toContain('agent:tool:called');
    expect(receivedEvents).toContain('agent:tool:returned');
    // Should have two turn-started (one per LLM call) and two turn-completed
    expect(receivedEvents.filter((event) => event === 'agent:turn:started')).toHaveLength(2);
    expect(receivedEvents.filter((event) => event === 'agent:turn:completed')).toHaveLength(2);
  });

  it('accepts MCP tools option without error', async () => {
    // MCP tools are passed as regular AgentTool objects. This test verifies
    // the agent loop can accept tools regardless of their source.
    const provider = createMockProvider([
      createToolCallResponse([{ id: 'call-1', name: 'mcp_read_file', input: { path: '/tmp' } }]),
      createChatResponse('File contents read'),
    ]);

    const mcpTool: AgentTool = {
      definition: {
        name: 'mcp_read_file',
        description: 'Read a file via MCP',
        inputSchema: { type: 'object', properties: { path: { type: 'string' } } },
      },
      execute: async (input: unknown) => {
        const typedInput = input as { path: string };
        return `Contents of ${typedInput.path}`;
      },
    };

    const result = await executeAgentLoop(
      { model: 'test-model', provider, tools: [mcpTool] },
      'Read the file',
    );

    expect(result.content).toBe('File contents read');
    expect(result.turnCount).toBe(2);
  });

  it('tracks per-turn cost in AgentTurnCompletedEvent', async () => {
    const provider = createMockProvider([
      createToolCallResponse([{ id: 'call-1', name: 'noop', input: {} }], {
        usage: { inputTokens: 100, outputTokens: 50, totalTokens: 150 },
      }),
      createChatResponse('Done', {
        usage: { inputTokens: 200, outputTokens: 100, totalTokens: 300 },
      }),
    ]);

    const noopTool: AgentTool = {
      definition: { name: 'noop', description: 'No-op', inputSchema: { type: 'object' } },
      execute: async () => 'ok',
    };

    const budget = new BudgetTracker({
      maxCost: 10,
      models: { 'test-model': { inputCostPer1K: 1, outputCostPer1K: 2 } },
    });

    const eventTarget = new EventTarget();
    const turnEvents: AgentTurnCompletedEvent[] = [];

    eventTarget.addEventListener(AgentTurnCompletedEvent.type, (event) => {
      turnEvents.push(event as AgentTurnCompletedEvent);
    });

    const result = await executeAgentLoop(
      {
        model: 'test-model',
        provider,
        tools: [noopTool],
        budget,
        eventTarget,
        workflowId: 'wf-cost-test',
        agentId: 'agent-cost-test',
      },
      'Do something',
    );

    expect(turnEvents).toHaveLength(2);

    // Turn 0: 100 input * $1/1K + 50 output * $2/1K = $0.10 + $0.10 = $0.20
    expect(turnEvents[0]!.cost).toBeCloseTo(0.2, 4);
    expect(turnEvents[0]!.cumulativeCost).toBeCloseTo(0.2, 4);

    // Turn 1: 200 input * $1/1K + 100 output * $2/1K = $0.20 + $0.20 = $0.40
    expect(turnEvents[1]!.cost).toBeCloseTo(0.4, 4);
    expect(turnEvents[1]!.cumulativeCost).toBeCloseTo(0.6, 4);

    // Total cost in result
    expect(result.totalCost).toBeCloseTo(0.6, 4);
  });

  it('reports per-turn cost in onTurnCompleted callback', async () => {
    const provider = createMockProvider([
      createChatResponse('Done', {
        usage: { inputTokens: 500, outputTokens: 200, totalTokens: 700 },
      }),
    ]);

    const budget = new BudgetTracker({
      maxCost: 10,
      models: { 'test-model': { inputCostPer1K: 2, outputCostPer1K: 4 } },
    });

    const turnResults: TurnResult[] = [];

    await executeAgentLoop(
      {
        model: 'test-model',
        provider,
        budget,
        onTurnCompleted: (turn) => turnResults.push(turn),
      },
      'Hello',
    );

    expect(turnResults).toHaveLength(1);
    // 500 input * $2/1K + 200 output * $4/1K = $1.00 + $0.80 = $1.80
    expect(turnResults[0]!.cost).toBeCloseTo(1.8, 4);
  });

  it('returns zero cost when no budget tracker is provided', async () => {
    const provider = createMockProvider([createChatResponse('Done')]);

    const result = await executeAgentLoop({ model: 'test-model', provider }, 'Hello');

    expect(result.totalCost).toBe(0);
  });

  it('does not cache tool results with different input arguments', async () => {
    let executeCount = 0;

    const provider = createMockProvider([
      createToolCallResponse([{ id: 'call-1', name: 'lookup', input: { key: 'abc' } }]),
      createToolCallResponse([{ id: 'call-2', name: 'lookup', input: { key: 'xyz' } }]),
      createChatResponse('Done'),
    ]);

    const lookupTool: AgentTool = {
      definition: {
        name: 'lookup',
        description: 'Lookup a key',
        inputSchema: { type: 'object' },
      },
      execute: async (input: unknown) => {
        executeCount++;
        const typedInput = input as { key: string };
        return { value: typedInput.key };
      },
    };

    const result = await executeAgentLoop(
      { model: 'test-model', provider, tools: [lookupTool] },
      'Lookup abc then xyz',
    );

    expect(result.content).toBe('Done');
    expect(executeCount).toBe(2);
  });

  it('re-executes tool after cache TTL expires', async () => {
    let executeCount = 0;
    const originalDateNow = Date.now;

    let mockTime = 1000;
    Date.now = () => mockTime;

    try {
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

      // Use a very short TTL (100ms)
      // First call: time=1000, cached at time=1000
      // Advance time past TTL before second call
      const originalChat = provider.chat.bind(provider);
      let chatCallCount = 0;
      provider.chat = async function (messages, options) {
        chatCallCount++;
        if (chatCallCount === 2) {
          // Advance time past TTL before second tool execution
          mockTime = 2000;
        }
        return originalChat(messages, options);
      };

      const result = await executeAgentLoop(
        { model: 'test-model', provider, tools: [lookupTool], toolCacheTTL: 100 },
        'Lookup abc twice',
      );

      expect(result.content).toBe('Done');
      // Both calls should execute because TTL expired
      expect(executeCount).toBe(2);
    } finally {
      Date.now = originalDateNow;
    }
  });

  it('does not cache failed tool executions', async () => {
    let executeCount = 0;

    const provider = createMockProvider([
      createToolCallResponse([{ id: 'call-1', name: 'flaky', input: { key: 'abc' } }]),
      createToolCallResponse([{ id: 'call-2', name: 'flaky', input: { key: 'abc' } }]),
      createChatResponse('Done'),
    ]);

    const flakyTool: AgentTool = {
      definition: {
        name: 'flaky',
        description: 'A flaky tool',
        inputSchema: { type: 'object' },
      },
      execute: async () => {
        executeCount++;
        if (executeCount === 1) {
          throw new Error('Transient failure');
        }
        return { value: 'success' };
      },
    };

    const result = await executeAgentLoop(
      { model: 'test-model', provider, tools: [flakyTool] },
      'Try flaky tool twice',
    );

    expect(result.content).toBe('Done');
    // Both calls should execute because the first one failed and was not cached
    expect(executeCount).toBe(2);
  });

  // ---------------------------------------------------------------------------
  // D1: Per-turn model selection — routing context correctness
  // ---------------------------------------------------------------------------

  it('passes correct workflowId to model router', async () => {
    let capturedContext: RoutingContext | undefined;

    const provider = createMockProvider([createChatResponse('Done')]);

    const modelRouter: ModelRouter = {
      select(context: RoutingContext) {
        capturedContext = context;
        return { model: 'routed-model' };
      },
    };

    await executeAgentLoop(
      {
        model: 'default-model',
        provider,
        modelRouter,
        workflowId: 'wf-test-123',
      },
      'Hello',
    );

    expect(capturedContext).toBeDefined();
    expect(capturedContext!.workflowId).toBe('wf-test-123');
  });

  it('tracks previousModels across turns in the routing context', async () => {
    const capturedContexts: RoutingContext[] = [];
    let providerCallCount = 0;

    const provider: LLMProvider = {
      name: 'mock',
      async chat(): Promise<ChatResponse> {
        providerCallCount++;
        if (providerCallCount < 4) {
          return createToolCallResponse([
            { id: `call-${providerCallCount}`, name: 'noop', input: {} },
          ]);
        }
        return createChatResponse('Done');
      },
      async stream() {
        return new ReadableStream();
      },
      async countTokens(): Promise<number> {
        return 100;
      },
    };

    const noopTool: AgentTool = {
      definition: { name: 'noop', description: 'No-op', inputSchema: { type: 'object' } },
      execute: async () => 'ok',
    };

    const modelRouter: ModelRouter = {
      select(context: RoutingContext) {
        capturedContexts.push({ ...context, previousModels: [...context.previousModels] });
        const models = ['model-a', 'model-b', 'model-c', 'model-d'];
        return { model: models[context.turnIndex] ?? 'model-d' };
      },
    };

    await executeAgentLoop(
      { model: 'default', provider, tools: [noopTool], modelRouter, maxTurns: 5 },
      'Hello',
    );

    expect(capturedContexts[0]!.previousModels).toEqual([]);
    expect(capturedContexts[1]!.previousModels).toEqual(['model-a']);
    expect(capturedContexts[2]!.previousModels).toEqual(['model-a', 'model-b']);
    expect(capturedContexts[3]!.previousModels).toEqual(['model-a', 'model-b', 'model-c']);
  });

  it('passes conversationLength and turnIndex accurately to router', async () => {
    const capturedContexts: RoutingContext[] = [];

    const provider: LLMProvider = {
      name: 'mock',
      async chat(): Promise<ChatResponse> {
        if (capturedContexts.length < 2) {
          return createToolCallResponse([
            { id: `call-${capturedContexts.length}`, name: 'noop', input: {} },
          ]);
        }
        return createChatResponse('Done');
      },
      async stream() {
        return new ReadableStream();
      },
      async countTokens(): Promise<number> {
        return 100;
      },
    };

    const noopTool: AgentTool = {
      definition: { name: 'noop', description: 'No-op', inputSchema: { type: 'object' } },
      execute: async () => 'ok',
    };

    const modelRouter: ModelRouter = {
      select(context: RoutingContext) {
        capturedContexts.push({ ...context });
        return { model: 'routed-model' };
      },
    };

    await executeAgentLoop(
      { model: 'default', provider, tools: [noopTool], modelRouter, maxTurns: 3 },
      'Hello',
    );

    expect(capturedContexts[0]!.turnIndex).toBe(0);
    expect(capturedContexts[1]!.turnIndex).toBe(1);
    expect(capturedContexts[1]!.conversationLength).toBeGreaterThan(
      capturedContexts[0]!.conversationLength,
    );
  });

  // ---------------------------------------------------------------------------
  // D2: Static fallback chain with retry on provider failure
  // ---------------------------------------------------------------------------

  it('retries with fallback models when the primary model fails', async () => {
    const capturedModels: string[] = [];

    const provider: LLMProvider = {
      name: 'mock',
      async chat(_messages, options): Promise<ChatResponse> {
        capturedModels.push(options.model);
        if (options.model === 'model-a') {
          throw new Error('rate limit exceeded');
        }
        return createChatResponse('Done from fallback');
      },
      async stream() {
        return new ReadableStream();
      },
      async countTokens(): Promise<number> {
        return 100;
      },
    };

    const modelRouter: ModelRouter = {
      select() {
        return { model: 'model-a', fallback: ['model-b', 'model-c'] };
      },
    };

    const result = await executeAgentLoop(
      { model: 'default', provider, modelRouter, workflowId: 'wf-fallback' },
      'Hello',
    );

    expect(result.content).toBe('Done from fallback');
    expect(capturedModels).toContain('model-a');
    expect(capturedModels).toContain('model-b');
  });

  it('throws when all fallback models fail', async () => {
    const provider: LLMProvider = {
      name: 'mock',
      async chat(): Promise<ChatResponse> {
        throw new Error('all models fail');
      },
      async stream() {
        return new ReadableStream();
      },
      async countTokens(): Promise<number> {
        return 100;
      },
    };

    const modelRouter: ModelRouter = {
      select() {
        return { model: 'model-a', fallback: ['model-b'] };
      },
    };

    expect(executeAgentLoop({ model: 'default', provider, modelRouter }, 'Hello')).rejects.toThrow(
      'all models fail',
    );
  });

  // ---------------------------------------------------------------------------
  // D5: AgentModelFallbackEvent dispatched on fallback
  // ---------------------------------------------------------------------------

  it('dispatches AgentModelFallbackEvent when a fallback model is used', async () => {
    const fallbackEvents: AgentModelFallbackEvent[] = [];
    const eventTarget = new EventTarget();

    eventTarget.addEventListener(AgentModelFallbackEvent.type, ((
      event: AgentModelFallbackEvent,
    ) => {
      fallbackEvents.push(event);
    }) as EventListener);

    const provider: LLMProvider = {
      name: 'mock',
      async chat(_messages, options): Promise<ChatResponse> {
        if (options.model === 'model-a') {
          throw new Error('rate limit');
        }
        return createChatResponse('Success via fallback');
      },
      async stream() {
        return new ReadableStream();
      },
      async countTokens(): Promise<number> {
        return 100;
      },
    };

    const modelRouter: ModelRouter = {
      select() {
        return { model: 'model-a', fallback: ['model-b'] };
      },
    };

    await executeAgentLoop(
      {
        model: 'default',
        provider,
        modelRouter,
        eventTarget,
        workflowId: 'wf-fallback-event',
        agentId: 'agent-1',
      },
      'Hello',
    );

    expect(fallbackEvents).toHaveLength(1);
    expect(fallbackEvents[0]!.failedModel).toBe('model-a');
    expect(fallbackEvents[0]!.nextModel).toBe('model-b');
    expect(fallbackEvents[0]!.turnIndex).toBe(0);
    expect(fallbackEvents[0]!.workflowId).toBe('wf-fallback-event');
  });

  it('reports fallbackAttempts > 0 in AgentTurnCompletedEvent after fallback', async () => {
    const completedEvents: AgentTurnCompletedEvent[] = [];
    const eventTarget = new EventTarget();

    eventTarget.addEventListener(AgentTurnCompletedEvent.type, ((
      event: AgentTurnCompletedEvent,
    ) => {
      completedEvents.push(event);
    }) as EventListener);

    const provider: LLMProvider = {
      name: 'mock',
      async chat(_messages, options): Promise<ChatResponse> {
        if (options.model === 'model-a') {
          throw new Error('rate limit');
        }
        return createChatResponse('Done');
      },
      async stream() {
        return new ReadableStream();
      },
      async countTokens(): Promise<number> {
        return 100;
      },
    };

    const modelRouter: ModelRouter = {
      select() {
        return { model: 'model-a', fallback: ['model-b'] };
      },
    };

    await executeAgentLoop(
      {
        model: 'default',
        provider,
        modelRouter,
        eventTarget,
        workflowId: 'wf-fallback-completed',
        agentId: 'agent-1',
      },
      'Hello',
    );

    expect(completedEvents).toHaveLength(1);
    expect(completedEvents[0]!.fallbackAttempts).toBeGreaterThan(0);
    expect(completedEvents[0]!.selectedModel).toBe('model-b');
  });

  // ---------------------------------------------------------------------------
  // D4: Default model router (engine wires it, but the behavior is testable
  //     at the agent loop level — per-call router should override any default)
  // ---------------------------------------------------------------------------

  it('uses modelRouter from options when provided', async () => {
    let routerCalled = false;

    const provider = createMockProvider([createChatResponse('Done')]);

    const modelRouter: ModelRouter = {
      select() {
        routerCalled = true;
        return { model: 'router-model' };
      },
    };

    const result = await executeAgentLoop(
      { model: 'default-model', provider, modelRouter },
      'Hello',
    );

    expect(routerCalled).toBe(true);
    expect(result.content).toBe('Done');
  });

  it('falls back to default model when no modelRouter is provided', async () => {
    const capturedModels: string[] = [];

    const provider: LLMProvider = {
      name: 'mock',
      async chat(_messages, options): Promise<ChatResponse> {
        capturedModels.push(options.model);
        return createChatResponse('Done');
      },
      async stream() {
        return new ReadableStream();
      },
      async countTokens(): Promise<number> {
        return 100;
      },
    };

    await executeAgentLoop({ model: 'my-default-model', provider }, 'Hello');

    expect(capturedModels).toEqual(['my-default-model']);
  });

  it('records health tracker failures for failed fallback attempts', async () => {
    const healthEvents: { type: string; provider: string }[] = [];

    const provider: LLMProvider = {
      name: 'mock',
      async chat(_messages, options): Promise<ChatResponse> {
        if (options.model === 'model-a') {
          throw new Error('rate limit');
        }
        return createChatResponse('Done');
      },
      async stream() {
        return new ReadableStream();
      },
      async countTokens(): Promise<number> {
        return 100;
      },
    };

    const healthTracker = {
      recordSuccess(providerName: string) {
        healthEvents.push({ type: 'success', provider: providerName });
      },
      recordFailure(providerName: string) {
        healthEvents.push({ type: 'failure', provider: providerName });
      },
    } as any;

    const modelRouter: ModelRouter = {
      select() {
        return { model: 'model-a', fallback: ['model-b'] };
      },
    };

    await executeAgentLoop({ model: 'default', provider, modelRouter, healthTracker }, 'Hello');

    expect(healthEvents).toContainEqual({ type: 'failure', provider: 'mock' });
    expect(healthEvents).toContainEqual({ type: 'success', provider: 'mock' });
  });

  // ---------------------------------------------------------------------------
  // E: Reasoning traces and per-turn cost breakdown
  // ---------------------------------------------------------------------------

  it('captures reasoning trace from provider response in turn-completed event', async () => {
    const provider = createMockProvider([
      createChatResponse('Final answer', {
        reasoningTrace: 'Let me think step by step about this problem.',
      }),
    ]);

    const eventTarget = new EventTarget();
    const turnEvents: AgentTurnCompletedEvent[] = [];

    eventTarget.addEventListener(AgentTurnCompletedEvent.type, (event) => {
      turnEvents.push(event as AgentTurnCompletedEvent);
    });

    await executeAgentLoop(
      {
        model: 'test-model',
        provider,
        eventTarget,
        workflowId: 'wf-reasoning',
        agentId: 'agent-reasoning',
      },
      'Think about this',
    );

    expect(turnEvents).toHaveLength(1);
    expect(turnEvents[0]!.reasoningTrace).toBe('Let me think step by step about this problem.');
  });

  it('passes undefined reasoning trace when provider does not return one', async () => {
    const provider = createMockProvider([createChatResponse('Final answer')]);

    const eventTarget = new EventTarget();
    const turnEvents: AgentTurnCompletedEvent[] = [];

    eventTarget.addEventListener(AgentTurnCompletedEvent.type, (event) => {
      turnEvents.push(event as AgentTurnCompletedEvent);
    });

    await executeAgentLoop(
      {
        model: 'test-model',
        provider,
        eventTarget,
        workflowId: 'wf-no-reasoning',
        agentId: 'agent-no-reasoning',
      },
      'Simple question',
    );

    expect(turnEvents).toHaveLength(1);
    expect(turnEvents[0]!.reasoningTrace).toBeUndefined();
  });

  it('includes reasoning trace in AgentResult', async () => {
    const provider = createMockProvider([
      createChatResponse('Answer', {
        reasoningTrace: 'Thinking deeply...',
      }),
    ]);

    const result = await executeAgentLoop({ model: 'test-model', provider }, 'Think');

    expect(result.reasoningTraces).toHaveLength(1);
    expect(result.reasoningTraces[0]).toBe('Thinking deeply...');
  });

  it('captures reasoning traces across multiple turns with tool calls', async () => {
    const provider = createMockProvider([
      createToolCallResponse([{ id: 'call-1', name: 'noop', input: {} }], {
        reasoningTrace: 'I need to use a tool first.',
      }),
      createChatResponse('Done', {
        reasoningTrace: 'Now I have the answer.',
      }),
    ]);

    const noopTool: AgentTool = {
      definition: { name: 'noop', description: 'No-op', inputSchema: { type: 'object' } },
      execute: async () => 'ok',
    };

    const eventTarget = new EventTarget();
    const turnEvents: AgentTurnCompletedEvent[] = [];

    eventTarget.addEventListener(AgentTurnCompletedEvent.type, (event) => {
      turnEvents.push(event as AgentTurnCompletedEvent);
    });

    const result = await executeAgentLoop(
      {
        model: 'test-model',
        provider,
        tools: [noopTool],
        eventTarget,
        workflowId: 'wf-multi-reasoning',
        agentId: 'agent-multi-reasoning',
      },
      'Use tool then answer',
    );

    expect(turnEvents).toHaveLength(2);
    expect(turnEvents[0]!.reasoningTrace).toBe('I need to use a tool first.');
    expect(turnEvents[1]!.reasoningTrace).toBe('Now I have the answer.');
    expect(result.reasoningTraces).toHaveLength(2);
  });

  it('exposes per-turn cost data in turnCosts array', async () => {
    const provider = createMockProvider([
      createToolCallResponse([{ id: 'call-1', name: 'noop', input: {} }], {
        usage: { inputTokens: 100, outputTokens: 50, totalTokens: 150 },
      }),
      createChatResponse('Done', {
        usage: { inputTokens: 200, outputTokens: 100, totalTokens: 300 },
      }),
    ]);

    const noopTool: AgentTool = {
      definition: { name: 'noop', description: 'No-op', inputSchema: { type: 'object' } },
      execute: async () => 'ok',
    };

    const budget = new BudgetTracker({
      maxCost: 10,
      models: { 'test-model': { inputCostPer1K: 1, outputCostPer1K: 2 } },
    });

    const result = await executeAgentLoop(
      {
        model: 'test-model',
        provider,
        tools: [noopTool],
        budget,
      },
      'Track costs',
    );

    expect(result.turnCosts).toHaveLength(2);
    expect(result.turnCosts[0]!.turn).toBe(0);
    expect(result.turnCosts[0]!.inputTokens).toBe(100);
    expect(result.turnCosts[0]!.outputTokens).toBe(50);
    expect(result.turnCosts[0]!.model).toBe('test-model');
    expect(result.turnCosts[0]!.tools).toEqual(['noop']);
    expect(result.turnCosts[1]!.turn).toBe(1);
    expect(result.turnCosts[1]!.inputTokens).toBe(200);
    expect(result.turnCosts[1]!.outputTokens).toBe(100);
    expect(result.turnCosts[1]!.tools).toEqual([]);
  });
});
