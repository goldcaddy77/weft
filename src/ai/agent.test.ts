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
});
