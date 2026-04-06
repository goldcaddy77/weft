/**
 * Durability tests for the agent conversation loop.
 *
 * Verifies that conversation state survives structuredClone (checkpoint
 * boundaries), that storage scan performance is not affected by agent
 * turn count, that all four exit paths produce clean state, and that
 * large conversation warnings fire at the right threshold.
 *
 * @module ai/agent-durability.test
 */

import { describe, expect, it } from 'bun:test';

import type { AgentTool } from './agent';
import { executeAgentLoop } from './agent';
import { BudgetExceededError, BudgetTracker } from './budget';
import { AgentCheckpointSizeWarningEvent } from './events';
import type { LLMProvider } from './providers/interface';
import type { ChatResponse } from './providers/types';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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

/** Create a provider that returns tool calls for N-1 turns, then a final answer. */
function createMultiTurnProvider(totalTurns: number, finalContent: string): LLMProvider {
  let callIndex = 0;
  return {
    name: 'multi-turn-mock',
    async chat(): Promise<ChatResponse> {
      callIndex++;
      if (callIndex < totalTurns) {
        return createToolCallResponse([
          { id: `call-${String(callIndex)}`, name: 'noop', input: { turn: callIndex } },
        ]);
      }
      return createChatResponse(finalContent);
    },
    async stream() {
      return new ReadableStream();
    },
    async countTokens(): Promise<number> {
      return 100;
    },
  };
}

function createNoopTool(name = 'noop'): AgentTool {
  return {
    definition: {
      name,
      description: 'Does nothing',
      inputSchema: { type: 'object' },
    },
    execute: async (input: unknown) => {
      return { result: 'ok', input };
    },
  };
}

// ---------------------------------------------------------------------------
// B1: Conversation accumulation in checkpoint locals
// ---------------------------------------------------------------------------

describe('B1: conversation accumulation survives structuredClone', () => {
  it('15-turn conversation round-trips through structuredClone without data loss', async () => {
    const totalTurns = 15;
    const provider = createMultiTurnProvider(totalTurns, 'Final answer after 15 turns');
    const noopTool = createNoopTool();

    const result = await executeAgentLoop(
      {
        model: 'test-model',
        provider,
        tools: [noopTool],
        maxTurns: totalTurns,
        systemPrompt: 'You are a test assistant.',
      },
      'Start the multi-turn conversation',
    );

    expect(result.turnCount).toBe(totalTurns);
    expect(result.content).toBe('Final answer after 15 turns');

    // The conversation should include: system, user, then (assistant + tool) pairs
    // for 14 tool turns, plus a final assistant message
    // system(1) + user(1) + 14*(assistant + tool) + 1 final assistant = 31
    expect(result.conversation.length).toBe(31);

    // Verify structuredClone round-trip preserves exact conversation
    const cloned = structuredClone(result.conversation);
    expect(cloned).toEqual(result.conversation);
    expect(cloned.length).toBe(result.conversation.length);

    // Verify message roles in the expected order
    expect(cloned[0]!.role).toBe('system');
    expect(cloned[0]!.content).toBe('You are a test assistant.');
    expect(cloned[1]!.role).toBe('user');
    expect(cloned[1]!.content).toBe('Start the multi-turn conversation');

    // Each tool turn produces an assistant message (with toolCalls) followed by a tool message
    for (let i = 0; i < 14; i++) {
      const assistantIndex = 2 + i * 2;
      const toolIndex = 3 + i * 2;
      expect(cloned[assistantIndex]!.role).toBe('assistant');
      expect(cloned[assistantIndex]!.toolCalls).toBeDefined();
      expect(cloned[assistantIndex]!.toolCalls!.length).toBe(1);
      expect(cloned[toolIndex]!.role).toBe('tool');
      expect(cloned[toolIndex]!.toolResults).toBeDefined();
    }

    // Final assistant message (no tool calls)
    const finalMessage = cloned[30]!;
    expect(finalMessage.role).toBe('assistant');
    expect(finalMessage.content).toBe('Final answer after 15 turns');
    expect(finalMessage.toolCalls).toBeUndefined();
  });

  it('conversation survives multiple sequential structuredClone passes', async () => {
    const provider = createMultiTurnProvider(5, 'Done after 5 turns');
    const noopTool = createNoopTool();

    const result = await executeAgentLoop(
      {
        model: 'test-model',
        provider,
        tools: [noopTool],
        maxTurns: 5,
      },
      'Go',
    );

    // Simulate checkpoint boundary at each "step" by cloning repeatedly
    let current = result.conversation;
    for (let pass = 0; pass < 10; pass++) {
      const next = structuredClone(current);
      expect(next).toEqual(current);
      current = next;
    }

    // After 10 round-trips the data is still identical to the original
    expect(current).toEqual(result.conversation);
  });

  it('tool results with complex nested objects survive structuredClone', async () => {
    let callIndex = 0;
    const provider: LLMProvider = {
      name: 'mock',
      async chat(): Promise<ChatResponse> {
        callIndex++;
        if (callIndex === 1) {
          return createToolCallResponse([
            { id: 'call-complex', name: 'complex_tool', input: { nested: { deep: true } } },
          ]);
        }
        return createChatResponse('Got the complex result');
      },
      async stream() {
        return new ReadableStream();
      },
      async countTokens(): Promise<number> {
        return 100;
      },
    };

    const complexTool: AgentTool = {
      definition: {
        name: 'complex_tool',
        description: 'Returns complex data',
        inputSchema: { type: 'object' },
      },
      execute: async () => ({
        nested: {
          array: [1, 2, { key: 'value' }],
          nullValue: null,
          booleanValue: true,
          numberValue: 42.5,
        },
      }),
    };

    const result = await executeAgentLoop(
      { model: 'test-model', provider, tools: [complexTool] },
      'Get complex data',
    );

    const cloned = structuredClone(result.conversation);
    expect(cloned).toEqual(result.conversation);

    // Verify the tool result message contains the serialized complex output
    const toolMessage = cloned.find((message) => message.role === 'tool');
    expect(toolMessage).toBeDefined();
    expect(toolMessage!.toolResults).toBeDefined();
    expect(toolMessage!.toolResults!.length).toBe(1);

    const output = JSON.parse(toolMessage!.toolResults![0]!.output);
    expect(output.nested.array).toEqual([1, 2, { key: 'value' }]);
    expect(output.nested.nullValue).toBeNull();
  });

  it('conversation contains no class instances or functions that would break structuredClone', async () => {
    const provider = createMultiTurnProvider(3, 'Done');
    const noopTool = createNoopTool();

    const result = await executeAgentLoop(
      {
        model: 'test-model',
        provider,
        tools: [noopTool],
        maxTurns: 3,
        systemPrompt: 'System prompt',
      },
      'Input',
    );

    // Walk the entire conversation tree and verify no functions or non-plain prototypes
    function assertPlainData(value: unknown, path: string): void {
      if (value === null || value === undefined) return;
      if (typeof value === 'function') {
        throw new Error(`Found function at ${path}`);
      }
      if (typeof value === 'object') {
        const proto = Object.getPrototypeOf(value);
        if (proto !== Object.prototype && proto !== Array.prototype && proto !== null) {
          throw new Error(`Found non-plain object at ${path}: ${proto?.constructor?.name}`);
        }
        if (Array.isArray(value)) {
          for (let i = 0; i < value.length; i++) {
            assertPlainData(value[i], `${path}[${String(i)}]`);
          }
        } else {
          for (const [key, val] of Object.entries(value)) {
            assertPlainData(val, `${path}.${key}`);
          }
        }
      }
    }

    // This should not throw
    assertPlainData(result.conversation, 'conversation');
  });
});

// ---------------------------------------------------------------------------
// B2: Storage scan performance
// ---------------------------------------------------------------------------

describe('B2: storage scan performance is not affected by agent turn count', () => {
  it('agent turn data is stored inside the conversation array, not as separate keys', async () => {
    const totalTurns = 50;
    const provider = createMultiTurnProvider(totalTurns, 'Done after 50 turns');
    const noopTool = createNoopTool();

    const result = await executeAgentLoop(
      {
        model: 'test-model',
        provider,
        tools: [noopTool],
        maxTurns: totalTurns,
      },
      'Go for 50 turns',
    );

    // Verify the result is a single object containing the full conversation
    expect(result.turnCount).toBe(totalTurns);
    expect(result.conversation.length).toBeGreaterThan(50);

    // The conversation is one array — not spread across multiple storage keys.
    // Serialize the entire result to verify it fits in one blob.
    const serialized = JSON.stringify(result);
    expect(typeof serialized).toBe('string');

    // Deserialize and verify
    const deserialized = JSON.parse(serialized);
    expect(deserialized.conversation.length).toBe(result.conversation.length);
    expect(deserialized.turnCount).toBe(totalTurns);
  });

  it('50-turn agent result round-trips through structuredClone as a single blob', async () => {
    const totalTurns = 50;
    const provider = createMultiTurnProvider(totalTurns, 'Final');
    const noopTool = createNoopTool();

    const result = await executeAgentLoop(
      {
        model: 'test-model',
        provider,
        tools: [noopTool],
        maxTurns: totalTurns,
      },
      'Go',
    );

    const start = performance.now();
    const cloned = structuredClone(result);
    const elapsed = performance.now() - start;

    // structuredClone of the full result should be fast (well under 100ms)
    expect(elapsed).toBeLessThan(100);
    expect(cloned.conversation.length).toBe(result.conversation.length);
    expect(cloned.turnCount).toBe(totalTurns);
  });
});

// ---------------------------------------------------------------------------
// B3: Four exit paths with clean checkpoints
// ---------------------------------------------------------------------------

describe('B3: four exit paths produce clean state', () => {
  it('exit path: final answer — clean result with no pending tool calls', async () => {
    const provider = createMultiTurnProvider(3, 'The final answer');
    const noopTool = createNoopTool();

    const result = await executeAgentLoop(
      {
        model: 'test-model',
        provider,
        tools: [noopTool],
        maxTurns: 10,
      },
      'Solve this',
    );

    // Completed via final answer
    expect(result.content).toBe('The final answer');
    expect(result.turnCount).toBe(3);

    // The last message is an assistant response with no tool calls
    const lastMessage = result.conversation[result.conversation.length - 1]!;
    expect(lastMessage.role).toBe('assistant');
    expect(lastMessage.toolCalls).toBeUndefined();

    // No unresolved tool messages: every tool message has results
    const toolMessages = result.conversation.filter((message) => message.role === 'tool');
    for (const toolMessage of toolMessages) {
      expect(toolMessage.toolResults).toBeDefined();
      expect(toolMessage.toolResults!.length).toBeGreaterThan(0);
      for (const toolResult of toolMessage.toolResults!) {
        expect(typeof toolResult.output).toBe('string');
        expect(toolResult.output.length).toBeGreaterThan(0);
      }
    }

    // Conversation is serializable
    const cloned = structuredClone(result);
    expect(cloned).toEqual(result);
  });

  it('exit path: maxTurns reached — clean result with conversation intact', async () => {
    // Provider always returns tool calls, never a final answer
    let callCount = 0;
    const provider: LLMProvider = {
      name: 'mock',
      async chat(): Promise<ChatResponse> {
        callCount++;
        return createToolCallResponse(
          [{ id: `call-${String(callCount)}`, name: 'noop', input: {} }],
          {
            content: `Turn ${String(callCount)} thinking...`,
          },
        );
      },
      async stream() {
        return new ReadableStream();
      },
      async countTokens(): Promise<number> {
        return 100;
      },
    };

    const noopTool = createNoopTool();

    const result = await executeAgentLoop(
      {
        model: 'test-model',
        provider,
        tools: [noopTool],
        maxTurns: 3,
      },
      'Keep going forever',
    );

    // Reached the maxTurns limit
    expect(result.turnCount).toBe(3);

    // Every tool call has a corresponding result
    const toolMessages = result.conversation.filter((message) => message.role === 'tool');
    expect(toolMessages.length).toBe(3);
    for (const toolMessage of toolMessages) {
      expect(toolMessage.toolResults).toBeDefined();
      expect(toolMessage.toolResults!.length).toBeGreaterThan(0);
    }

    // Conversation is serializable
    const cloned = structuredClone(result);
    expect(cloned).toEqual(result);
  });

  it('exit path: budget exhausted — clean result, no partial state', async () => {
    // Budget check passes on first turn, then fails on second
    let turnIndex = 0;
    const provider: LLMProvider = {
      name: 'mock',
      async chat(): Promise<ChatResponse> {
        return createToolCallResponse([
          { id: `call-${String(turnIndex)}`, name: 'noop', input: {} },
        ]);
      },
      async stream() {
        return new ReadableStream();
      },
      async countTokens(): Promise<number> {
        return 100;
      },
    };

    const noopTool = createNoopTool();

    let checkCount = 0;
    const mockBudget = {
      checkBudget() {
        checkCount++;
        if (checkCount > 1) {
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
        }
      },
      recordUsage() {
        turnIndex++;
        return false;
      },
      budgetRemaining() {
        return {
          tokensUsed: turnIndex * 30,
          costUsed: turnIndex * 0.1,
          tokensRemaining: 1000 - turnIndex * 30,
          costRemaining: 10 - turnIndex * 0.1,
          breakdown: [],
        };
      },
    } as unknown as BudgetTracker;

    const result = await executeAgentLoop(
      {
        model: 'test-model',
        provider,
        tools: [noopTool],
        maxTurns: 10,
        budget: mockBudget,
      },
      'Spend the budget',
    );

    // Completed 1 turn before budget was exhausted on second check
    expect(result.turnCount).toBe(1);

    // The tool results from the completed turn are present
    const toolMessages = result.conversation.filter((message) => message.role === 'tool');
    expect(toolMessages.length).toBe(1);
    for (const toolMessage of toolMessages) {
      expect(toolMessage.toolResults).toBeDefined();
    }

    // Conversation is serializable — no dangling state
    const cloned = structuredClone(result);
    expect(cloned).toEqual(result);
  });

  it('exit path: cancellation via AbortSignal — clean shutdown', async () => {
    const controller = new AbortController();
    let callCount = 0;

    const provider: LLMProvider = {
      name: 'mock',
      async chat(): Promise<ChatResponse> {
        callCount++;
        if (callCount === 2) {
          // Abort before the second LLM call completes
          controller.abort();
        }
        return createToolCallResponse([
          { id: `call-${String(callCount)}`, name: 'noop', input: {} },
        ]);
      },
      async stream() {
        return new ReadableStream();
      },
      async countTokens(): Promise<number> {
        return 100;
      },
    };

    const noopTool = createNoopTool();

    const result = await executeAgentLoop(
      {
        model: 'test-model',
        provider,
        tools: [noopTool],
        maxTurns: 10,
        signal: controller.signal,
      },
      'Run until cancelled',
    );

    // The agent ran some turns before cancellation kicked in
    // (abort is checked at start of loop, so turn 2 completes but turn 3 won't start)
    expect(result.turnCount).toBeGreaterThanOrEqual(1);
    expect(result.turnCount).toBeLessThanOrEqual(3);

    // All tool messages have results — no dangling promises
    const toolMessages = result.conversation.filter((message) => message.role === 'tool');
    for (const toolMessage of toolMessages) {
      expect(toolMessage.toolResults).toBeDefined();
      expect(toolMessage.toolResults!.length).toBeGreaterThan(0);
    }

    // Conversation is serializable
    const cloned = structuredClone(result);
    expect(cloned).toEqual(result);
  });

  it('pre-aborted signal produces empty result immediately', async () => {
    const controller = new AbortController();
    controller.abort();

    const provider: LLMProvider = {
      name: 'mock',
      async chat(): Promise<ChatResponse> {
        throw new Error('Should never be called');
      },
      async stream() {
        return new ReadableStream();
      },
      async countTokens(): Promise<number> {
        return 100;
      },
    };

    const result = await executeAgentLoop(
      {
        model: 'test-model',
        provider,
        signal: controller.signal,
      },
      'Hello',
    );

    expect(result.turnCount).toBe(0);
    expect(result.content).toBe('');

    // Even the empty result is serializable
    const cloned = structuredClone(result);
    expect(cloned).toEqual(result);
  });

  it('budget exhausted before first turn produces empty result', async () => {
    const provider: LLMProvider = {
      name: 'mock',
      async chat(): Promise<ChatResponse> {
        throw new Error('Should never be called');
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

    expect(result.turnCount).toBe(0);
    expect(result.content).toBe('');
    const cloned = structuredClone(result);
    expect(cloned).toEqual(result);
  });
});

// ---------------------------------------------------------------------------
// B4: Checkpoint size warning for large conversations
// ---------------------------------------------------------------------------

describe('B4: checkpoint size warning for large conversations', () => {
  it('dispatches checkpoint size warning when conversation exceeds threshold', async () => {
    // Create a provider that returns large tool results for several turns
    const largePayload = 'x'.repeat(12_000); // ~12KB per tool result
    let callIndex = 0;
    const totalTurns = 8; // 8 turns * 12KB > 64KB default threshold

    const provider: LLMProvider = {
      name: 'mock',
      async chat(): Promise<ChatResponse> {
        callIndex++;
        if (callIndex < totalTurns) {
          return createToolCallResponse([
            { id: `call-${String(callIndex)}`, name: 'large_tool', input: { turn: callIndex } },
          ]);
        }
        return createChatResponse('Done with large conversation');
      },
      async stream() {
        return new ReadableStream();
      },
      async countTokens(): Promise<number> {
        return 100;
      },
    };

    const largeTool: AgentTool = {
      definition: {
        name: 'large_tool',
        description: 'Returns large data',
        inputSchema: { type: 'object' },
      },
      execute: async () => largePayload,
    };

    const eventTarget = new EventTarget();
    const sizeWarnings: AgentCheckpointSizeWarningEvent[] = [];

    eventTarget.addEventListener(AgentCheckpointSizeWarningEvent.type, ((event: Event) => {
      sizeWarnings.push(event as AgentCheckpointSizeWarningEvent);
    }) as EventListener);

    await executeAgentLoop(
      {
        model: 'test-model',
        provider,
        tools: [largeTool],
        maxTurns: totalTurns,
        eventTarget,
        workflowId: 'wf-size-test',
        agentId: 'agent-size-test',
        checkpointSizeWarningThreshold: 64 * 1024, // 64KB
      },
      'Generate large data',
    );

    // At some point the cumulative conversation exceeded 64KB
    expect(sizeWarnings.length).toBeGreaterThan(0);

    // The warning fires exactly once (sizeWarningFired flag prevents repeats)
    expect(sizeWarnings.length).toBe(1);

    // The first warning should fire when size crosses the threshold
    expect(sizeWarnings[0]!.sizeBytes).toBeGreaterThan(64 * 1024);
    expect(sizeWarnings[0]!.workflowId).toBe('wf-size-test');
    expect(sizeWarnings[0]!.agentId).toBe('agent-size-test');
  });

  it('does not dispatch warning when conversation stays under threshold', async () => {
    const provider = createMultiTurnProvider(3, 'Small result');
    const noopTool = createNoopTool();

    const eventTarget = new EventTarget();
    const sizeWarnings: AgentCheckpointSizeWarningEvent[] = [];

    eventTarget.addEventListener(AgentCheckpointSizeWarningEvent.type, ((event: Event) => {
      sizeWarnings.push(event as AgentCheckpointSizeWarningEvent);
    }) as EventListener);

    await executeAgentLoop(
      {
        model: 'test-model',
        provider,
        tools: [noopTool],
        maxTurns: 3,
        eventTarget,
        workflowId: 'wf-small-test',
        agentId: 'agent-small-test',
        checkpointSizeWarningThreshold: 64 * 1024, // 64KB — conversation is small
      },
      'Small conversation',
    );

    expect(sizeWarnings.length).toBe(0);
  });
});
