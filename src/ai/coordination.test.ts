import { describe, expect, it, spyOn } from 'bun:test';

import { sleepForTesting } from '../testing/fake-timers.ts';
import type { ChatResponse, LLMProvider, Message } from './agent/types.ts';
import {
  createChildHeaders,
  debate,
  handoff,
  summarizeConversation,
  supervise,
} from './coordination/index.ts';
import { defineAgent, type AgentDefinition } from './declaration.ts';

function createChatResponse(content: string): ChatResponse {
  return {
    content,
    toolCalls: [],
    usage: { inputTokens: 10, outputTokens: 20, totalTokens: 30 },
    model: 'test-model',
    stopReason: 'end_turn',
  };
}

function createProvider(responses: ChatResponse[]): LLMProvider {
  let callIndex = 0;
  return {
    name: 'mock',
    async chat(): Promise<ChatResponse> {
      const response = responses[callIndex++];
      if (!response) throw new Error('provider has no more responses');
      return response;
    },
  };
}

function createAgentDefinition(overrides: Partial<AgentDefinition> = {}): AgentDefinition {
  return defineAgent({
    name: 'test-agent',
    model: 'test-model',
    ...overrides,
  });
}

describe('createChildHeaders', () => {
  it('returns an empty map when parent headers are absent', () => {
    expect(createChildHeaders(undefined).size).toBe(0);
  });

  it('forwards traceparent and tracestate headers only', () => {
    const headers = createChildHeaders(
      new Map([
        ['traceparent', '00-abcd1234abcd1234abcd1234abcd1234-ef56ef56ef56ef56-01'],
        ['tracestate', 'vendor=value'],
        ['authorization', 'Bearer secret'],
      ]),
    );

    expect(headers.get('traceparent')).toBe(
      '00-abcd1234abcd1234abcd1234abcd1234-ef56ef56ef56ef56-01',
    );
    expect(headers.get('tracestate')).toBe('vendor=value');
    expect(headers.has('authorization')).toBe(false);
  });
});

describe('handoff', () => {
  it('passes only the current input when forwardContext is none', async () => {
    const capturedMessages: Message[][] = [];
    const provider: LLMProvider = {
      name: 'mock',
      async chat(messages): Promise<ChatResponse> {
        capturedMessages.push([...messages]);
        return createChatResponse('handoff result');
      },
    };

    const result = await handoff({
      agent: createAgentDefinition({ name: 'target-agent' }),
      input: 'Do something',
      provider,
      forwardContext: 'none',
      parentConversation: [
        { role: 'user', content: 'previous question' },
        { role: 'assistant', content: 'previous answer' },
      ],
    });

    expect(result.result.content).toBe('handoff result');
    expect(result.contextForwarded).toBe('none');
    expect(capturedMessages[0]?.filter((message) => message.role === 'user')).toEqual([
      { role: 'user', content: 'Do something' },
    ]);
  });

  it('includes a summary of the parent conversation when requested', async () => {
    const capturedMessages: Message[][] = [];
    const provider: LLMProvider = {
      name: 'mock',
      async chat(messages): Promise<ChatResponse> {
        capturedMessages.push([...messages]);
        return createChatResponse('handoff result');
      },
    };

    await handoff({
      agent: createAgentDefinition({ name: 'target-agent' }),
      input: 'Do something',
      provider,
      forwardContext: 'summary',
      parentConversation: [
        { role: 'user', content: 'What is 2+2?' },
        { role: 'assistant', content: '4' },
      ],
    });

    const userContent = capturedMessages[0]?.find((message) => message.role === 'user')?.content;
    expect(userContent).toContain('Context');
    expect(userContent).toContain('What is 2+2?');
    expect(userContent).toContain('Do something');
  });

  it('includes the full parent conversation when requested', async () => {
    const capturedMessages: Message[][] = [];
    const provider: LLMProvider = {
      name: 'mock',
      async chat(messages): Promise<ChatResponse> {
        capturedMessages.push([...messages]);
        return createChatResponse('handoff result');
      },
    };

    await handoff({
      agent: createAgentDefinition({ name: 'target-agent' }),
      input: 'Do something',
      provider,
      forwardContext: 'full',
      parentConversation: [
        { role: 'user', content: 'first question' },
        { role: 'assistant', content: 'first answer' },
      ],
    });

    const userContent = capturedMessages[0]?.find((message) => message.role === 'user')?.content;
    expect(userContent).toContain('first question');
    expect(userContent).toContain('first answer');
    expect(userContent).toContain('Do something');
  });

  it('passes the child agent system prompt to the provider conversation', async () => {
    const capturedMessages: Message[][] = [];
    const provider: LLMProvider = {
      name: 'mock',
      async chat(messages): Promise<ChatResponse> {
        capturedMessages.push([...messages]);
        return createChatResponse('handoff result');
      },
    };

    await handoff({
      agent: createAgentDefinition({ name: 'target-agent', systemPrompt: 'You are focused.' }),
      input: 'Do something',
      provider,
    });

    expect(capturedMessages[0]?.[0]).toEqual({ role: 'system', content: 'You are focused.' });
  });
});

describe('debate', () => {
  it('runs advocate and critic for each round, then the judge', async () => {
    let callCount = 0;
    const provider: LLMProvider = {
      name: 'mock',
      async chat(): Promise<ChatResponse> {
        callCount++;
        if (callCount === 1) return createChatResponse('advocate round 1');
        if (callCount === 2) return createChatResponse('critic round 1');
        if (callCount === 3) return createChatResponse('advocate round 2');
        if (callCount === 4) return createChatResponse('critic round 2');
        return createChatResponse('judge verdict');
      },
    };

    const result = await debate({
      advocate: createAgentDefinition({ name: 'advocate' }),
      critic: createAgentDefinition({ name: 'critic' }),
      judge: createAgentDefinition({ name: 'judge' }),
      topic: 'Is the sky blue?',
      rounds: 2,
      provider,
    });

    expect(callCount).toBe(5);
    expect(result.rounds).toEqual([
      { roundIndex: 0, advocateResponse: 'advocate round 1', criticResponse: 'critic round 1' },
      { roundIndex: 1, advocateResponse: 'advocate round 2', criticResponse: 'critic round 2' },
    ]);
    expect(result.verdict).toBe('judge verdict');
  });

  it('alternates system prompts between advocate, critic, and judge', async () => {
    const seenSystemPrompts: string[] = [];
    const provider: LLMProvider = {
      name: 'mock',
      async chat(messages): Promise<ChatResponse> {
        const systemPrompt = messages.find((message) => message.role === 'system')?.content;
        if (systemPrompt) seenSystemPrompts.push(systemPrompt);
        return createChatResponse('response');
      },
    };

    await debate({
      advocate: createAgentDefinition({ name: 'advocate', systemPrompt: 'advocate' }),
      critic: createAgentDefinition({ name: 'critic', systemPrompt: 'critic' }),
      judge: createAgentDefinition({ name: 'judge', systemPrompt: 'judge' }),
      topic: 'Test topic',
      rounds: 2,
      provider,
    });

    expect(seenSystemPrompts).toEqual(['advocate', 'critic', 'advocate', 'critic', 'judge']);
  });
});

describe('supervise', () => {
  it('runs all workers and asks the supervisor for best-of-n', async () => {
    let callCount = 0;
    const provider: LLMProvider = {
      name: 'mock',
      async chat(): Promise<ChatResponse> {
        callCount++;
        if (callCount <= 3) return createChatResponse(`worker-${callCount}`);
        return createChatResponse('worker-2 is best');
      },
    };

    const result = await supervise({
      workers: [
        createAgentDefinition({ name: 'worker-1' }),
        createAgentDefinition({ name: 'worker-2' }),
        createAgentDefinition({ name: 'worker-3' }),
      ],
      supervisor: createAgentDefinition({ name: 'supervisor' }),
      input: 'Do the work',
      strategy: 'best-of-n',
      provider,
    });

    expect(result.workerResults).toHaveLength(3);
    expect(result.finalResult).toBe('worker-2 is best');
    expect(callCount).toBe(4);
  });

  it('returns consensus directly when workers agree', async () => {
    let callCount = 0;
    const provider: LLMProvider = {
      name: 'mock',
      async chat(): Promise<ChatResponse> {
        callCount++;
        return createChatResponse('same answer');
      },
    };

    const result = await supervise({
      workers: [createAgentDefinition({ name: 'w1' }), createAgentDefinition({ name: 'w2' })],
      supervisor: createAgentDefinition({ name: 'supervisor' }),
      input: 'Go',
      strategy: 'consensus',
      provider,
    });

    expect(result.finalResult).toBe('same answer');
    expect(callCount).toBe(2);
  });

  it('uses the supervisor when consensus workers disagree', async () => {
    const provider = createProvider([
      createChatResponse('alpha'),
      createChatResponse('beta'),
      createChatResponse('supervisor picked alpha'),
    ]);

    const result = await supervise({
      workers: [createAgentDefinition({ name: 'w1' }), createAgentDefinition({ name: 'w2' })],
      supervisor: createAgentDefinition({ name: 'supervisor' }),
      input: 'Go',
      strategy: 'consensus',
      provider,
    });

    expect(result.finalResult).toBe('supervisor picked alpha');
  });

  it('runs the supervisor to merge worker outputs', async () => {
    const provider = createProvider([
      createChatResponse('partial one'),
      createChatResponse('partial two'),
      createChatResponse('merged result'),
    ]);

    const result = await supervise({
      workers: [createAgentDefinition({ name: 'w1' }), createAgentDefinition({ name: 'w2' })],
      supervisor: createAgentDefinition({ name: 'supervisor' }),
      input: 'Merge these',
      strategy: 'merge',
      provider,
    });

    expect(result.strategy).toBe('merge');
    expect(result.finalResult).toBe('merged result');
  });

  it('supports dynamic worker count by number and callback', async () => {
    let callCount = 0;
    const provider: LLMProvider = {
      name: 'mock',
      async chat(): Promise<ChatResponse> {
        callCount++;
        return createChatResponse('same');
      },
    };
    const workers = [
      createAgentDefinition({ name: 'w1' }),
      createAgentDefinition({ name: 'w2' }),
      createAgentDefinition({ name: 'w3' }),
    ];

    const numericResult = await supervise({
      workers,
      supervisor: createAgentDefinition({ name: 'supervisor' }),
      input: 'Go',
      strategy: 'consensus',
      n: 2,
      provider,
    });
    const callbackResult = await supervise({
      workers,
      supervisor: createAgentDefinition({ name: 'supervisor' }),
      input: 'Go',
      strategy: 'consensus',
      n: () => 1,
      provider,
    });

    expect(numericResult.workerResults).toHaveLength(2);
    expect(callbackResult.workerResults).toHaveLength(1);
    expect(callCount).toBe(3);
  });

  it('round-robin replicates workers when n exceeds the worker count', async () => {
    const seenSystemPrompts: string[] = [];
    const provider: LLMProvider = {
      name: 'mock',
      async chat(messages): Promise<ChatResponse> {
        const systemPrompt = messages.find((message) => message.role === 'system')?.content;
        if (systemPrompt) seenSystemPrompts.push(systemPrompt);
        return createChatResponse('same-answer');
      },
    };

    await supervise({
      workers: [
        createAgentDefinition({ name: 'w1', systemPrompt: 'worker-one' }),
        createAgentDefinition({ name: 'w2', systemPrompt: 'worker-two' }),
      ],
      supervisor: createAgentDefinition({ name: 'supervisor' }),
      input: 'Go',
      strategy: 'consensus',
      n: 5,
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

  it('cleans up the parent abort listener after successful completion', async () => {
    const controller = new AbortController();
    const addEventListenerSpy = spyOn(controller.signal, 'addEventListener');
    const removeEventListenerSpy = spyOn(controller.signal, 'removeEventListener');

    await supervise({
      workers: [createAgentDefinition({ name: 'w1' }), createAgentDefinition({ name: 'w2' })],
      supervisor: createAgentDefinition({ name: 'supervisor' }),
      input: 'Go',
      strategy: 'consensus',
      provider: createProvider([createChatResponse('same'), createChatResponse('same')]),
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
        capturedSignal = options.signal;
        return new Promise((_resolve, reject) => {
          options.signal?.addEventListener(
            'abort',
            () => reject(options.signal?.reason ?? new Error('parent aborted')),
            { once: true },
          );
        });
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
    expect(capturedSignal?.aborted).toBe(true);
  });
});

describe('summarizeConversation', () => {
  it('produces a string summary from non-system messages', () => {
    const summary = summarizeConversation([
      { role: 'system', content: 'hidden' },
      { role: 'user', content: 'What is TypeScript?' },
      { role: 'assistant', content: 'TypeScript is JavaScript with types.' },
    ]);

    expect(summary).toContain('What is TypeScript?');
    expect(summary).toContain('TypeScript is JavaScript with types.');
    expect(summary).not.toContain('hidden');
  });

  it('returns an empty string for an empty conversation', () => {
    expect(summarizeConversation([])).toBe('');
  });
});
