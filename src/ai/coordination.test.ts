import { describe, expect, it, spyOn } from 'bun:test';
import { sleepForTesting } from '../testing/fake-timers.ts';

import { BudgetTracker } from './budget';
import type { LLMProvider } from './providers/interface';
import type { ChatResponse, Message } from './providers/types';

import {
  createChildHeaders,
  debate,
  handoff,
  summarizeConversation,
  supervise,
} from './coordination';
import { defineAgent, type AgentDefinition } from './declaration';

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
  return defineAgent({
    name: 'test-agent',
    model: 'test-model',
    ...overrides,
  });
}

// ---------------------------------------------------------------------------
// createChildHeaders
// ---------------------------------------------------------------------------

describe('createChildHeaders', () => {
  it('returns empty map when parentHeaders is undefined', () => {
    const headers = createChildHeaders(undefined);
    expect(headers.size).toBe(0);
  });

  it('returns empty map when parentHeaders has no trace headers', () => {
    const parent = new Map<string, string>([['x-custom', 'value']]);
    const headers = createChildHeaders(parent);
    expect(headers.size).toBe(0);
  });

  it('forwards traceparent header from parent', () => {
    const parent = new Map<string, string>([
      ['traceparent', '00-abcd1234abcd1234abcd1234abcd1234-ef56ef56ef56ef56-01'],
    ]);

    const headers = createChildHeaders(parent);

    expect(headers.get('traceparent')).toBe(
      '00-abcd1234abcd1234abcd1234abcd1234-ef56ef56ef56ef56-01',
    );
  });

  it('forwards tracestate header when present', () => {
    const parent = new Map<string, string>([
      ['traceparent', '00-abcd1234abcd1234abcd1234abcd1234-ef56ef56ef56ef56-01'],
      ['tracestate', 'vendor1=value1,vendor2=value2'],
    ]);

    const headers = createChildHeaders(parent);

    expect(headers.get('traceparent')).toBeDefined();
    expect(headers.get('tracestate')).toBe('vendor1=value1,vendor2=value2');
  });

  it('does not forward non-trace headers', () => {
    const parent = new Map<string, string>([
      ['traceparent', '00-abcd1234abcd1234abcd1234abcd1234-ef56ef56ef56ef56-01'],
      ['authorization', 'Bearer secret'],
      ['x-request-id', '12345'],
    ]);

    const headers = createChildHeaders(parent);

    expect(headers.size).toBe(1);
    expect(headers.has('authorization')).toBe(false);
    expect(headers.has('x-request-id')).toBe(false);
  });
});

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

  it('propagates an already-aborted parent signal to worker and supervisor calls', async () => {
    const controller = new AbortController();
    controller.abort();

    await expect(
      supervise({
        workers: [
          createAgentDefinition({ name: 'worker-1' }),
          createAgentDefinition({ name: 'worker-2' }),
        ],
        supervisor: createAgentDefinition({ name: 'supervisor' }),
        input: 'Go',
        strategy: 'best-of-n',
        provider: createMockProvider([createChatResponse('done')]),
        signal: controller.signal,
      }),
    ).rejects.toThrow('The operation was aborted');
  });

  it('rejects an unknown supervise strategy and cleans up the parent abort listener', async () => {
    const controller = new AbortController();
    const addEventListenerSpy = spyOn(controller.signal, 'addEventListener');
    const removeEventListenerSpy = spyOn(controller.signal, 'removeEventListener');
    const provider = createMockProvider([createChatResponse('worker-1')]);

    await expect(
      supervise({
        workers: [createAgentDefinition({ name: 'worker-1' })],
        supervisor: createAgentDefinition({ name: 'supervisor' }),
        input: 'Go',
        strategy: 'unsupported' as 'best-of-n',
        provider,
        signal: controller.signal,
      }),
    ).rejects.toThrow('Unknown supervise strategy');

    expect(addEventListenerSpy).toHaveBeenCalledTimes(1);
    expect(removeEventListenerSpy).toHaveBeenCalledTimes(1);

    addEventListenerSpy.mockRestore();
    removeEventListenerSpy.mockRestore();
  });

  it('cleans up the parent abort listener after successful completion', async () => {
    const controller = new AbortController();
    const addEventListenerSpy = spyOn(controller.signal, 'addEventListener');
    const removeEventListenerSpy = spyOn(controller.signal, 'removeEventListener');
    const provider = createMockProvider([
      createChatResponse('same'),
      createChatResponse('same'),
      createChatResponse('same'),
    ]);

    await supervise({
      workers: [createAgentDefinition({ name: 'w1' }), createAgentDefinition({ name: 'w2' })],
      supervisor: createAgentDefinition({ name: 'sup' }),
      input: 'Go',
      strategy: 'consensus',
      provider,
      signal: controller.signal,
    });

    expect(addEventListenerSpy).toHaveBeenCalledTimes(1);
    expect(removeEventListenerSpy).toHaveBeenCalledTimes(1);

    addEventListenerSpy.mockRestore();
    removeEventListenerSpy.mockRestore();
  });

  it('aborts in-flight workers when the parent signal fires after supervise starts', async () => {
    const controller = new AbortController();
    let capturedSignal: AbortSignal | undefined;

    const provider: LLMProvider = {
      name: 'mock',
      chat(_messages, options): Promise<ChatResponse> {
        capturedSignal = options?.signal;

        return new Promise((_resolve, reject) => {
          options?.signal?.addEventListener(
            'abort',
            () => {
              reject(options.signal?.reason ?? new Error('parent aborted'));
            },
            { once: true },
          );
        });
      },
      async stream() {
        return new ReadableStream();
      },
      async countTokens(): Promise<number> {
        return 100;
      },
    };

    const resultPromise = supervise({
      workers: [createAgentDefinition({ name: 'worker-1' })],
      supervisor: createAgentDefinition({ name: 'supervisor' }),
      input: 'Go',
      strategy: 'consensus',
      provider,
      signal: controller.signal,
    });

    await sleepForTesting(0);
    controller.abort(new Error('parent aborted'));

    await expect(resultPromise).rejects.toThrow('parent aborted');
    expect(capturedSignal).toBeDefined();
    expect(capturedSignal!.aborted).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// supervise — dynamic n and confidence-weighted voting
// ---------------------------------------------------------------------------

describe('supervise: dynamic n and confidence-weighted voting', () => {
  it('with numeric n trims workers to the specified count', async () => {
    let callCount = 0;
    const provider: LLMProvider = {
      name: 'mock',
      async chat(): Promise<ChatResponse> {
        callCount++;
        return createChatResponse('same');
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
        createAgentDefinition({ name: 'w1' }),
        createAgentDefinition({ name: 'w2' }),
        createAgentDefinition({ name: 'w3' }),
        createAgentDefinition({ name: 'w4' }),
        createAgentDefinition({ name: 'w5' }),
      ],
      supervisor: createAgentDefinition({ name: 'supervisor' }),
      input: 'Go',
      strategy: 'consensus',
      n: 3,
      provider,
    });

    // Only 3 workers ran (all returned 'same', so no supervisor call)
    expect(result.workerResults).toHaveLength(3);
    expect(callCount).toBe(3);
  });

  it('with n as a function resolves the count from input', async () => {
    let callCount = 0;
    const provider: LLMProvider = {
      name: 'mock',
      async chat(): Promise<ChatResponse> {
        callCount++;
        return createChatResponse('same');
      },
      async stream() {
        return new ReadableStream();
      },
      async countTokens(): Promise<number> {
        return 100;
      },
    };

    await supervise({
      workers: [
        createAgentDefinition({ name: 'w1' }),
        createAgentDefinition({ name: 'w2' }),
        createAgentDefinition({ name: 'w3' }),
        createAgentDefinition({ name: 'w4' }),
        createAgentDefinition({ name: 'w5' }),
      ],
      supervisor: createAgentDefinition({ name: 'supervisor' }),
      input: 'Go',
      strategy: 'consensus',
      n: () => 2,
      provider,
    });

    // n function returns 2, so only 2 workers ran; they agreed → no supervisor
    expect(callCount).toBe(2);
  });

  it('with fractional n floors to the nearest integer', async () => {
    let callCount = 0;
    const provider: LLMProvider = {
      name: 'mock',
      async chat(): Promise<ChatResponse> {
        callCount++;
        return createChatResponse('same');
      },
      async stream() {
        return new ReadableStream();
      },
      async countTokens(): Promise<number> {
        return 100;
      },
    };

    await supervise({
      workers: [
        createAgentDefinition({ name: 'w1' }),
        createAgentDefinition({ name: 'w2' }),
        createAgentDefinition({ name: 'w3' }),
        createAgentDefinition({ name: 'w4' }),
        createAgentDefinition({ name: 'w5' }),
      ],
      supervisor: createAgentDefinition({ name: 'supervisor' }),
      input: 'Go',
      strategy: 'consensus',
      n: 2.9, // floors to 2
      provider,
    });

    // 2.9 floors to 2; only 2 workers ran
    expect(callCount).toBe(2);
  });

  it('with voting "confidence-weighted" picks the unanimous answer without calling the supervisor', async () => {
    let callCount = 0;
    const provider: LLMProvider = {
      name: 'mock',
      async chat(): Promise<ChatResponse> {
        callCount++;
        return createChatResponse('worker answer');
      },
      async stream() {
        return new ReadableStream();
      },
      async countTokens(): Promise<number> {
        return 100;
      },
    };

    const result = await supervise({
      workers: [createAgentDefinition({ name: 'w1' }), createAgentDefinition({ name: 'w2' })],
      supervisor: createAgentDefinition({ name: 'supervisor' }),
      input: 'Go',
      strategy: 'consensus',
      voting: 'confidence-weighted',
      provider,
    });

    // Both workers agreed on 'worker answer'; confidence-weighted picks the unanimous winner
    expect(result.finalResult).toBe('worker answer');
    // Supervisor should NOT be called — workers agreed (only 2 calls)
    expect(callCount).toBe(2);
  });

  it('with voting "confidence-weighted" falls through to supervisor when workers are evenly split', async () => {
    let callSequence = 0;
    const provider: LLMProvider = {
      name: 'mock',
      async chat(): Promise<ChatResponse> {
        callSequence++;
        // First two calls are workers (alternating answers); third is supervisor
        if (callSequence === 1) return createChatResponse('alpha');
        if (callSequence === 2) return createChatResponse('beta');
        return createChatResponse('supervisor picked alpha'); // supervisor resolves the tie
      },
      async stream() {
        return new ReadableStream();
      },
      async countTokens(): Promise<number> {
        return 100;
      },
    };

    const result = await supervise({
      workers: [createAgentDefinition({ name: 'w1' }), createAgentDefinition({ name: 'w2' })],
      supervisor: createAgentDefinition({ name: 'supervisor' }),
      input: 'Go',
      strategy: 'consensus',
      voting: 'confidence-weighted',
      provider,
    });

    // Workers disagreed (alpha vs beta) with equal weight (confidence undefined → 0.5 each)
    // → confidence-weighted detects a tie and falls through to supervisor
    expect(result.finalResult).toBe('supervisor picked alpha');
    expect(callSequence).toBe(3);
  });

  it('clamps non-finite n values to one worker', async () => {
    let callCount = 0;
    const provider: LLMProvider = {
      name: 'mock',
      async chat(): Promise<ChatResponse> {
        callCount++;
        return createChatResponse('worker answer');
      },
      async stream() {
        return new ReadableStream();
      },
      async countTokens(): Promise<number> {
        return 100;
      },
    };

    const infinityResult = await supervise({
      workers: [
        createAgentDefinition({ name: 'w1' }),
        createAgentDefinition({ name: 'w2' }),
        createAgentDefinition({ name: 'w3' }),
      ],
      supervisor: createAgentDefinition({ name: 'supervisor' }),
      input: 'Go',
      strategy: 'consensus',
      n: () => Number.POSITIVE_INFINITY,
      provider,
    });

    const nanResult = await supervise({
      workers: [
        createAgentDefinition({ name: 'w1' }),
        createAgentDefinition({ name: 'w2' }),
        createAgentDefinition({ name: 'w3' }),
      ],
      supervisor: createAgentDefinition({ name: 'supervisor' }),
      input: 'Go',
      strategy: 'consensus',
      n: () => Number.NaN,
      provider,
    });

    expect(infinityResult.finalResult).toBe('worker answer');
    expect(nanResult.finalResult).toBe('worker answer');
    expect(callCount).toBe(2);
  });

  it('round-robin replicates workers when n exceeds the worker count', async () => {
    let callCount = 0;
    const provider: LLMProvider = {
      name: 'mock',
      async chat(): Promise<ChatResponse> {
        callCount++;
        return createChatResponse(`same-${callCount <= 5 ? 'answer' : 'supervisor'}`);
      },
      async stream() {
        return new ReadableStream();
      },
      async countTokens(): Promise<number> {
        return 100;
      },
    };

    const result = await supervise({
      workers: [createAgentDefinition({ name: 'w1' }), createAgentDefinition({ name: 'w2' })],
      supervisor: createAgentDefinition({ name: 'supervisor' }),
      input: 'Go',
      strategy: 'consensus',
      n: 5,
      provider,
    });

    expect(result.workerResults).toHaveLength(5);
    expect(result.finalResult).toBe('same-answer');
    expect(callCount).toBe(5);
  });

  it('replicates workers in round-robin order when n resolves above the worker count', async () => {
    const seenSystemPrompts: string[] = [];
    const provider: LLMProvider = {
      name: 'mock',
      async chat(messages): Promise<ChatResponse> {
        const systemPrompt = messages.find((message) => message.role === 'system')?.content;
        if (systemPrompt) {
          seenSystemPrompts.push(systemPrompt);
        }
        return createChatResponse('same-answer');
      },
      async stream() {
        return new ReadableStream();
      },
      async countTokens(): Promise<number> {
        return 100;
      },
    };

    await supervise({
      workers: [
        createAgentDefinition({ name: 'w1', systemPrompt: 'worker-one' }),
        createAgentDefinition({ name: 'w2', systemPrompt: 'worker-two' }),
      ],
      supervisor: createAgentDefinition({ name: 'supervisor', systemPrompt: 'supervisor' }),
      input: 'Go',
      strategy: 'consensus',
      n: () => 5,
      provider,
    });

    expect(seenSystemPrompts).toEqual([
      'worker-one',
      'worker-two',
      'worker-one',
      'worker-two',
      'worker-one',
    ]);
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

// ---------------------------------------------------------------------------
// Budget propagation
// ---------------------------------------------------------------------------

const BUDGET_OPTIONS = {
  maxTokens: 10_000,
  models: { 'test-model': { inputCostPer1K: 0.01, outputCostPer1K: 0.03 } },
};

describe('budget propagation', () => {
  it('handoff passes budget to child agent and tokens are recorded', async () => {
    const budget = new BudgetTracker(BUDGET_OPTIONS);
    const provider = createMockProvider([createChatResponse('done')]);

    await handoff({
      agent: createAgentDefinition(),
      input: 'Go',
      provider,
      budget,
    });

    const state = budget.budgetRemaining();
    // The mock returns usage: { inputTokens: 10, outputTokens: 20 }
    expect(state.tokensUsed).toBe(30);
  });

  it('debate shares budget across all rounds', async () => {
    const budget = new BudgetTracker(BUDGET_OPTIONS);
    // 1 round = advocate + critic + judge = 3 calls, each 30 tokens
    const provider = createMockProvider([
      createChatResponse('advocate'),
      createChatResponse('critic'),
      createChatResponse('verdict'),
    ]);

    await debate({
      advocate: createAgentDefinition({ name: 'advocate' }),
      critic: createAgentDefinition({ name: 'critic' }),
      judge: createAgentDefinition({ name: 'judge' }),
      topic: 'Test',
      rounds: 1,
      provider,
      budget,
    });

    const state = budget.budgetRemaining();
    // 3 calls × 30 tokens each = 90 tokens
    expect(state.tokensUsed).toBe(90);
  });

  it('supervise shares budget across parallel workers', async () => {
    const budget = new BudgetTracker(BUDGET_OPTIONS);
    // 2 workers + 1 supervisor = 3 calls
    const provider = createMockProvider([
      createChatResponse('worker-1'),
      createChatResponse('worker-2'),
      createChatResponse('best pick'),
    ]);

    await supervise({
      workers: [createAgentDefinition({ name: 'w1' }), createAgentDefinition({ name: 'w2' })],
      supervisor: createAgentDefinition({ name: 'sup' }),
      input: 'Go',
      strategy: 'best-of-n',
      provider,
      budget,
    });

    const state = budget.budgetRemaining();
    // 3 calls × 30 tokens each = 90 tokens
    expect(state.tokensUsed).toBe(90);
  });

  it('handoff with signal completes normally', async () => {
    const controller = new AbortController();
    const provider = createMockProvider([createChatResponse('done')]);

    const result = await handoff({
      agent: createAgentDefinition(),
      input: 'Go',
      provider,
      signal: controller.signal,
    });

    expect(result.result.content).toBe('done');
  });

  it('supervise wires budget abort controller and fires signal on exhaustion', async () => {
    // Budget allows only 50 tokens; each call uses 30 (10 in + 20 out).
    const budget = new BudgetTracker({
      maxTokens: 50,
      models: { 'test-model': { inputCostPer1K: 0.01, outputCostPer1K: 0.03 } },
    });

    let callCount = 0;
    let lastSignal: AbortSignal | undefined;
    const provider: LLMProvider = {
      name: 'mock',
      async chat(_messages: Message[], options?: { signal?: AbortSignal }): Promise<ChatResponse> {
        callCount++;
        lastSignal = options?.signal;
        // Small delay so the budget abort controller can fire between calls
        await new Promise((resolve) => setTimeout(resolve, 5));
        return createChatResponse(`worker-${callCount}`);
      },
      async stream() {
        return new ReadableStream();
      },
      async countTokens(): Promise<number> {
        return 100;
      },
    };

    // All 3 workers produce distinct output, so consensus fails and the
    // supervisor is also called. Total usage exceeds the 50-token budget.
    // We verify the abort wiring is set up (signal exists and fires).
    try {
      await supervise({
        workers: [
          createAgentDefinition({ name: 'w1' }),
          createAgentDefinition({ name: 'w2' }),
          createAgentDefinition({ name: 'w3' }),
        ],
        supervisor: createAgentDefinition({ name: 'sup' }),
        input: 'Go',
        strategy: 'consensus',
        provider,
        budget,
      });
    } catch {
      // Budget exhaustion may surface as an error — that's acceptable.
    }

    const state = budget.budgetRemaining();
    expect(state.tokensUsed).toBeGreaterThan(50);
    expect(state.tokensRemaining).toBeLessThan(0);

    // The signal passed to the provider should have been aborted by
    // the budget tracker once usage exceeded the limit.
    expect(lastSignal).toBeDefined();
    expect(lastSignal!.aborted).toBe(true);
  });

  it('supervise cleans up budget abort controller after completion', async () => {
    const budget = new BudgetTracker(BUDGET_OPTIONS);
    // Wire an external controller to verify supervise doesn't leave it stale
    const externalController = new AbortController();
    budget.setAbortController(externalController);

    const provider = createMockProvider([
      createChatResponse('same'),
      createChatResponse('same'),
      createChatResponse('same'),
    ]);

    await supervise({
      workers: [createAgentDefinition({ name: 'w1' }), createAgentDefinition({ name: 'w2' })],
      supervisor: createAgentDefinition({ name: 'sup' }),
      input: 'Go',
      strategy: 'consensus',
      provider,
      budget,
    });

    // After supervise returns, the budget's signal should NOT reference
    // the internal controller — it should be a fresh, non-aborted signal.
    expect(budget.signal).toBeDefined();
    expect(budget.signal!.aborted).toBe(false);
  });
});
