import { describe, expect, it } from 'bun:test';

import type { LLMProvider } from './providers/interface';
import type { ChatResponse, Message } from './providers/types';

import { debate, handoff, summarizeConversation, supervise } from './coordination';
import type { AgentDefinition } from './declaration';

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

function createAgentDefinition(overrides?: Partial<AgentDefinition>): AgentDefinition {
  return {
    name: 'test-agent',
    model: 'test-model',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// handoff
// ---------------------------------------------------------------------------

describe('handoff', () => {
  it('with forwardContext "none" passes only the input', async () => {
    const capturedMessages: Message[][] = [];
    const provider: LLMProvider = {
      name: 'mock',
      async chat(messages): Promise<ChatResponse> {
        capturedMessages.push([...messages]);
        return createChatResponse('handoff result');
      },
      async stream() {
        return new ReadableStream();
      },
      async countTokens(): Promise<number> {
        return 100;
      },
    };

    const agent = createAgentDefinition({ name: 'target-agent' });

    await handoff({
      agent,
      input: 'Do something',
      provider,
      forwardContext: 'none',
      parentConversation: [
        { role: 'user', content: 'previous question' },
        { role: 'assistant', content: 'previous answer' },
      ],
    });

    // The user message should only contain the raw input, not the parent conversation
    const userMessages = capturedMessages[0]!.filter((m) => m.role === 'user');
    expect(userMessages).toHaveLength(1);
    expect(userMessages[0]!.content).toBe('Do something');
  });

  it('with forwardContext "summary" includes a summary of the parent conversation', async () => {
    const capturedMessages: Message[][] = [];
    const provider: LLMProvider = {
      name: 'mock',
      async chat(messages): Promise<ChatResponse> {
        capturedMessages.push([...messages]);
        return createChatResponse('handoff result');
      },
      async stream() {
        return new ReadableStream();
      },
      async countTokens(): Promise<number> {
        return 100;
      },
    };

    const agent = createAgentDefinition({ name: 'target-agent' });

    await handoff({
      agent,
      input: 'Do something',
      provider,
      forwardContext: 'summary',
      parentConversation: [
        { role: 'user', content: 'What is 2+2?' },
        { role: 'assistant', content: '4' },
      ],
    });

    // The user message should contain the summary plus the input
    const userMessages = capturedMessages[0]!.filter((m) => m.role === 'user');
    expect(userMessages).toHaveLength(1);
    expect(userMessages[0]!.content).toContain('Do something');
    // The summary should reference the previous conversation content
    expect(userMessages[0]!.content).toContain('Context');
  });

  it('returns the child agent result and contextForwarded', async () => {
    const provider = createMockProvider([createChatResponse('child result')]);
    const agent = createAgentDefinition({ name: 'child-agent' });

    const result = await handoff({
      agent,
      input: 'Go',
      provider,
    });

    expect(result.result.content).toBe('child result');
    expect(result.contextForwarded).toBe('none');
  });

  it('with forwardContext "full" includes the entire parent conversation', async () => {
    const capturedMessages: Message[][] = [];
    const provider: LLMProvider = {
      name: 'mock',
      async chat(messages): Promise<ChatResponse> {
        capturedMessages.push([...messages]);
        return createChatResponse('handoff result');
      },
      async stream() {
        return new ReadableStream();
      },
      async countTokens(): Promise<number> {
        return 100;
      },
    };

    const agent = createAgentDefinition({ name: 'target-agent' });

    const parentConversation: Message[] = [
      { role: 'user', content: 'first question' },
      { role: 'assistant', content: 'first answer' },
    ];

    await handoff({
      agent,
      input: 'Do something',
      provider,
      forwardContext: 'full',
      parentConversation,
    });

    // The full conversation should be included in the messages sent to the provider
    const userMessages = capturedMessages[0]!.filter((m) => m.role === 'user');
    expect(userMessages).toHaveLength(1);
    expect(userMessages[0]!.content).toContain('first question');
    expect(userMessages[0]!.content).toContain('first answer');
    expect(userMessages[0]!.content).toContain('Do something');
  });
});

// ---------------------------------------------------------------------------
// debate
// ---------------------------------------------------------------------------

describe('debate', () => {
  it('runs the correct number of rounds', async () => {
    let callCount = 0;
    const provider: LLMProvider = {
      name: 'mock',
      async chat(): Promise<ChatResponse> {
        callCount++;
        // Advocate, Critic for each round, then Judge
        return createChatResponse(`response-${callCount}`);
      },
      async stream() {
        return new ReadableStream();
      },
      async countTokens(): Promise<number> {
        return 100;
      },
    };

    const result = await debate({
      advocate: createAgentDefinition({ name: 'advocate' }),
      critic: createAgentDefinition({ name: 'critic' }),
      judge: createAgentDefinition({ name: 'judge' }),
      topic: 'Is the sky blue?',
      rounds: 3,
      provider,
    });

    expect(result.rounds).toHaveLength(3);
    // 3 rounds x 2 agents (advocate + critic) + 1 judge = 7 calls
    expect(callCount).toBe(7);
  });

  it('alternates between advocate and critic', async () => {
    const agentOrder: string[] = [];
    const provider: LLMProvider = {
      name: 'mock',
      async chat(messages): Promise<ChatResponse> {
        // The system prompt tells us which agent is running
        const systemMessage = messages.find((m) => m.role === 'system');
        if (systemMessage) {
          agentOrder.push(systemMessage.content);
        }
        return createChatResponse('response');
      },
      async stream() {
        return new ReadableStream();
      },
      async countTokens(): Promise<number> {
        return 100;
      },
    };

    await debate({
      advocate: createAgentDefinition({
        name: 'advocate',
        systemPrompt: 'You are the advocate',
      }),
      critic: createAgentDefinition({ name: 'critic', systemPrompt: 'You are the critic' }),
      judge: createAgentDefinition({ name: 'judge', systemPrompt: 'You are the judge' }),
      topic: 'Test topic',
      rounds: 2,
      provider,
    });

    // Round 1: advocate, critic; Round 2: advocate, critic; then judge
    expect(agentOrder[0]).toBe('You are the advocate');
    expect(agentOrder[1]).toBe('You are the critic');
    expect(agentOrder[2]).toBe('You are the advocate');
    expect(agentOrder[3]).toBe('You are the critic');
    expect(agentOrder[4]).toBe('You are the judge');
  });

  it('judge returns verdict after all rounds', async () => {
    let callCount = 0;
    const provider: LLMProvider = {
      name: 'mock',
      async chat(): Promise<ChatResponse> {
        callCount++;
        if (callCount <= 4) {
          return createChatResponse(`round-response-${callCount}`);
        }
        return createChatResponse('The advocate wins.');
      },
      async stream() {
        return new ReadableStream();
      },
      async countTokens(): Promise<number> {
        return 100;
      },
    };

    const result = await debate({
      advocate: createAgentDefinition({ name: 'advocate' }),
      critic: createAgentDefinition({ name: 'critic' }),
      judge: createAgentDefinition({ name: 'judge' }),
      topic: 'Debate topic',
      rounds: 2,
      provider,
    });

    expect(result.verdict).toBe('The advocate wins.');
    expect(result.judgeResult.content).toBe('The advocate wins.');
  });

  it('with 1 round works correctly', async () => {
    let callCount = 0;
    const provider: LLMProvider = {
      name: 'mock',
      async chat(): Promise<ChatResponse> {
        callCount++;
        if (callCount === 1) return createChatResponse('advocate argument');
        if (callCount === 2) return createChatResponse('critic rebuttal');
        return createChatResponse('judge verdict');
      },
      async stream() {
        return new ReadableStream();
      },
      async countTokens(): Promise<number> {
        return 100;
      },
    };

    const result = await debate({
      advocate: createAgentDefinition({ name: 'advocate' }),
      critic: createAgentDefinition({ name: 'critic' }),
      judge: createAgentDefinition({ name: 'judge' }),
      topic: 'Simple topic',
      rounds: 1,
      provider,
    });

    expect(result.rounds).toHaveLength(1);
    expect(result.rounds[0]!.roundIndex).toBe(0);
    expect(result.rounds[0]!.advocateResponse).toBe('advocate argument');
    expect(result.rounds[0]!.criticResponse).toBe('critic rebuttal');
    expect(result.verdict).toBe('judge verdict');
    expect(callCount).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// supervise
// ---------------------------------------------------------------------------

describe('supervise', () => {
  it('runs all workers in parallel', async () => {
    const executionOrder: string[] = [];
    let callCount = 0;
    const provider: LLMProvider = {
      name: 'mock',
      async chat(messages): Promise<ChatResponse> {
        callCount++;
        const systemMessage = messages.find((m) => m.role === 'system');
        if (systemMessage) {
          executionOrder.push(systemMessage.content);
        }
        return createChatResponse(`result-${callCount}`);
      },
      async stream() {
        return new ReadableStream();
      },
      async countTokens(): Promise<number> {
        return 100;
      },
    };

    const result = await supervise({
      workers: [
        createAgentDefinition({ name: 'worker-1', systemPrompt: 'worker-1' }),
        createAgentDefinition({ name: 'worker-2', systemPrompt: 'worker-2' }),
        createAgentDefinition({ name: 'worker-3', systemPrompt: 'worker-3' }),
      ],
      supervisor: createAgentDefinition({ name: 'supervisor', systemPrompt: 'supervisor' }),
      input: 'Do the work',
      strategy: 'best-of-n',
      provider,
    });

    // 3 workers + 1 supervisor = 4 calls
    expect(result.workerResults).toHaveLength(3);
    expect(callCount).toBe(4);
  });

  it('with "best-of-n" strategy uses supervisor to pick the best', async () => {
    let callCount = 0;
    const provider: LLMProvider = {
      name: 'mock',
      async chat(_messages): Promise<ChatResponse> {
        callCount++;
        if (callCount <= 2) {
          return createChatResponse(`worker-${callCount}-result`);
        }
        // Supervisor picks the best
        return createChatResponse('worker-1-result is the best');
      },
      async stream() {
        return new ReadableStream();
      },
      async countTokens(): Promise<number> {
        return 100;
      },
    };

    const result = await supervise({
      workers: [
        createAgentDefinition({ name: 'worker-1' }),
        createAgentDefinition({ name: 'worker-2' }),
      ],
      supervisor: createAgentDefinition({ name: 'supervisor' }),
      input: 'Solve this problem',
      strategy: 'best-of-n',
      provider,
    });

    expect(result.finalResult).toBe('worker-1-result is the best');
    expect(result.strategy).toBe('best-of-n');
  });

  it('with "consensus" strategy checks agreement among workers', async () => {
    let callCount = 0;
    const provider: LLMProvider = {
      name: 'mock',
      async chat(): Promise<ChatResponse> {
        callCount++;
        if (callCount <= 3) {
          // All workers agree
          return createChatResponse('The answer is 42');
        }
        // Supervisor should not be called when workers agree
        return createChatResponse('supervisor says 42');
      },
      async stream() {
        return new ReadableStream();
      },
      async countTokens(): Promise<number> {
        return 100;
      },
    };

    const result = await supervise({
      workers: [
        createAgentDefinition({ name: 'worker-1' }),
        createAgentDefinition({ name: 'worker-2' }),
        createAgentDefinition({ name: 'worker-3' }),
      ],
      supervisor: createAgentDefinition({ name: 'supervisor' }),
      input: 'What is the answer?',
      strategy: 'consensus',
      provider,
    });

    // When all workers agree, consensus returns their answer directly
    expect(result.finalResult).toBe('The answer is 42');
    expect(result.strategy).toBe('consensus');
    // Only 3 worker calls, no supervisor needed
    expect(callCount).toBe(3);
  });

  it('with "consensus" strategy uses supervisor when workers disagree', async () => {
    let callCount = 0;
    const provider: LLMProvider = {
      name: 'mock',
      async chat(): Promise<ChatResponse> {
        callCount++;
        if (callCount === 1) return createChatResponse('Answer A');
        if (callCount === 2) return createChatResponse('Answer B');
        // Supervisor resolves disagreement
        return createChatResponse('Resolved answer');
      },
      async stream() {
        return new ReadableStream();
      },
      async countTokens(): Promise<number> {
        return 100;
      },
    };

    const result = await supervise({
      workers: [
        createAgentDefinition({ name: 'worker-1' }),
        createAgentDefinition({ name: 'worker-2' }),
      ],
      supervisor: createAgentDefinition({ name: 'supervisor' }),
      input: 'What is the answer?',
      strategy: 'consensus',
      provider,
    });

    expect(result.finalResult).toBe('Resolved answer');
    expect(callCount).toBe(3);
  });

  it('with "merge" strategy runs supervisor to merge outputs', async () => {
    let callCount = 0;
    const capturedMessages: Message[][] = [];
    const provider: LLMProvider = {
      name: 'mock',
      async chat(messages): Promise<ChatResponse> {
        callCount++;
        capturedMessages.push([...messages]);
        if (callCount <= 2) {
          return createChatResponse(`partial-${callCount}`);
        }
        return createChatResponse('merged result');
      },
      async stream() {
        return new ReadableStream();
      },
      async countTokens(): Promise<number> {
        return 100;
      },
    };

    const result = await supervise({
      workers: [
        createAgentDefinition({ name: 'worker-1' }),
        createAgentDefinition({ name: 'worker-2' }),
      ],
      supervisor: createAgentDefinition({ name: 'supervisor' }),
      input: 'Merge these',
      strategy: 'merge',
      provider,
    });

    expect(result.finalResult).toBe('merged result');
    expect(result.strategy).toBe('merge');
    // Workers + supervisor
    expect(callCount).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// summarizeConversation
// ---------------------------------------------------------------------------

describe('summarizeConversation', () => {
  it('produces a string summary from messages', () => {
    const messages: Message[] = [
      { role: 'user', content: 'What is TypeScript?' },
      { role: 'assistant', content: 'TypeScript is a typed superset of JavaScript.' },
      { role: 'user', content: 'How do I use it?' },
      { role: 'assistant', content: 'Install it via npm and use the tsc compiler.' },
    ];

    const summary = summarizeConversation(messages);

    expect(typeof summary).toBe('string');
    expect(summary.length).toBeGreaterThan(0);
    // Should reference the conversation content
    expect(summary).toContain('TypeScript');
  });

  it('returns an empty string for an empty conversation', () => {
    const summary = summarizeConversation([]);
    expect(summary).toBe('');
  });
});
