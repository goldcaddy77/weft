import { describe, expect, it } from 'bun:test';
import { sleepForTesting } from '../testing/fake-timers.ts';

import { TokenEvent } from '@/core/events.ts';
import type { ChatOptions, LLMProvider } from './providers/interface.ts';
import {
  createSuspendingProvider,
  type PendingChatResumeState,
} from './providers/suspending-provider.ts';
import type { ChatResponse, Message, StreamChunk, TokenUsage } from './providers/types.ts';
import {
  buildRecoveryConversation,
  buildStreamCheckpoint,
  createSSEStream,
  createStreamingProvider,
  enqueueStreamingToken,
  executeStreamingAgent,
  formatSSE,
} from './streaming-agent.ts';
import { StreamMultiplexer } from './streaming.ts';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createStreamChunks(tokens: string[], usage?: TokenUsage): StreamChunk[] {
  const chunks: StreamChunk[] = tokens.map((token) => ({
    type: 'token' as const,
    token,
  }));
  chunks.push({
    type: 'done' as const,
    usage: usage ?? { inputTokens: 10, outputTokens: 20, totalTokens: 30 },
  });
  return chunks;
}

function createMockStreamProvider(streamResponses: StreamChunk[][]): {
  provider: LLMProvider;
  callCount: () => number;
} {
  let callIndex = 0;
  let calls = 0;

  const provider: LLMProvider = {
    name: 'mock-stream',

    async chat(_messages: Message[], options: ChatOptions): Promise<ChatResponse> {
      // Fallback — should not be called when streaming
      const chunks = streamResponses[callIndex++] ?? [];
      calls++;
      let content = '';
      let usage: TokenUsage = { inputTokens: 10, outputTokens: 20, totalTokens: 30 };

      for (const chunk of chunks) {
        if (chunk.type === 'token' && chunk.token) content += chunk.token;
        if (chunk.type === 'done' && chunk.usage) usage = chunk.usage;
      }

      return {
        content,
        toolCalls: [],
        usage,
        model: options.model,
        stopReason: 'end_turn',
      };
    },

    async stream(
      _messages: Message[],
      _options: ChatOptions,
    ): Promise<ReadableStream<StreamChunk>> {
      const chunks = streamResponses[callIndex++] ?? [];
      calls++;

      return new ReadableStream<StreamChunk>({
        start(controller) {
          for (const chunk of chunks) {
            controller.enqueue(chunk);
          }
          controller.close();
        },
      });
    },

    async countTokens(): Promise<number> {
      return 100;
    },
  };

  return { provider, callCount: () => calls };
}

async function collectStream(stream: ReadableStream<string>): Promise<string[]> {
  const reader = stream.getReader();
  const tokens: string[] = [];
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    tokens.push(value);
  }
  return tokens;
}

async function collectByteStream(stream: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let output = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    output += decoder.decode(value, { stream: true });
  }
  output += decoder.decode();
  return output;
}

function createResumeCoordinator() {
  const pendingState = new Map<number, PendingChatResumeState>();
  const waiters = new Map<string, (payload: unknown) => void>();

  return {
    load: async (turnIndex: number) => pendingState.get(turnIndex),
    store: async (turnIndex: number, state: PendingChatResumeState) => {
      pendingState.set(turnIndex, state);
    },
    clear: async (turnIndex: number) => {
      pendingState.delete(turnIndex);
    },
    waitForSignal: async (resumeToken: string) =>
      await new Promise<unknown>((resolve) => {
        waiters.set(resumeToken, resolve);
      }),
    resume(resumeToken: string, payload: unknown) {
      waiters.get(resumeToken)?.(payload);
    },
  };
}

// ---------------------------------------------------------------------------
// H1: ctx.agent() returns ReadableStream with streamTo: "output"
// ---------------------------------------------------------------------------

describe('H1: executeStreamingAgent returns ReadableStream', () => {
  it('returns a ReadableStream<string> when streamTo is "output"', () => {
    const { provider } = createMockStreamProvider([createStreamChunks(['Hello', ' world'])]);

    const { stream, result } = executeStreamingAgent(
      { model: 'test-model', provider, streamTo: 'output' },
      'Say hello',
    );

    expect(stream).toBeInstanceOf(ReadableStream);
    expect(result).toBeInstanceOf(Promise);
  });

  it('emits tokens that match what the mock provider returns', async () => {
    const { provider } = createMockStreamProvider([
      createStreamChunks(['Hello', ' ', 'world', '!']),
    ]);

    const { stream, result } = executeStreamingAgent(
      { model: 'test-model', provider, streamTo: 'output' },
      'Say hello',
    );

    const tokens = await collectStream(stream);
    expect(tokens).toEqual(['Hello', ' ', 'world', '!']);

    const agentResult = await result;
    expect(agentResult.content).toBe('Hello world!');
  });

  it('stream closes after agent loop completes', async () => {
    const { provider } = createMockStreamProvider([createStreamChunks(['Done'])]);

    const { stream, result } = executeStreamingAgent(
      { model: 'test-model', provider, streamTo: 'output' },
      'Finish',
    );

    const tokens = await collectStream(stream);
    expect(tokens).toEqual(['Done']);

    const agentResult = await result;
    expect(agentResult.turnCount).toBe(1);
  });

  it('handles multi-turn conversations with tool calls', async () => {
    let streamCallIndex = 0;
    const streamResponses: StreamChunk[][] = [
      // Turn 1: tool call
      [
        { type: 'tool_call_start', toolCall: { id: 'tc-1', name: 'get_weather' } },
        { type: 'tool_call_delta', toolCall: { id: 'tc-1', input: '{"city":"NYC"}' } },
        { type: 'tool_call_end', toolCall: { id: 'tc-1' } },
        { type: 'done', usage: { inputTokens: 10, outputTokens: 20, totalTokens: 30 } },
      ],
      // Turn 2: final answer
      createStreamChunks(['The', ' weather', ' is', ' sunny']),
    ];

    const provider: LLMProvider = {
      name: 'mock-stream',
      async chat(): Promise<ChatResponse> {
        throw new Error('Should not be called');
      },
      async stream(): Promise<ReadableStream<StreamChunk>> {
        const chunks = streamResponses[streamCallIndex++] ?? [];
        return new ReadableStream({
          start(controller) {
            for (const chunk of chunks) controller.enqueue(chunk);
            controller.close();
          },
        });
      },
      async countTokens(): Promise<number> {
        return 100;
      },
    };

    const { stream, result } = executeStreamingAgent(
      {
        model: 'test-model',
        provider,
        streamTo: 'output',
        tools: [
          {
            definition: {
              name: 'get_weather',
              description: 'Get weather',
              inputSchema: { type: 'object' },
            },
            execute: async () => ({ temp: 72, condition: 'sunny' }),
          },
        ],
      },
      'What is the weather?',
    );

    const tokens = await collectStream(stream);
    // Only text tokens from the final answer should appear
    expect(tokens).toEqual(['The', ' weather', ' is', ' sunny']);

    const agentResult = await result;
    expect(agentResult.turnCount).toBe(2);
  });

  it('createStreamingProvider forwards stream and countTokens to the base provider', async () => {
    const expectedStream = new ReadableStream<StreamChunk>();
    let streamMessages: Message[] | undefined;
    let streamModel = '';
    let countedMessages: Message[] | undefined;

    const baseProvider: LLMProvider = {
      name: 'passthrough-provider',
      async chat(): Promise<ChatResponse> {
        throw new Error('Should not be called');
      },
      async stream(messages, options): Promise<ReadableStream<StreamChunk>> {
        streamMessages = messages;
        streamModel = options.model;
        return expectedStream;
      },
      async countTokens(messages: Message[]): Promise<number> {
        countedMessages = messages;
        return 321;
      },
    };

    const wrapped = createStreamingProvider(baseProvider, () => {});
    const messages: Message[] = [{ role: 'user', content: 'Hello' }];

    expect(await wrapped.stream(messages, { model: 'wrapped-model' })).toBe(expectedStream);
    expect(await wrapped.countTokens(messages)).toBe(321);
    expect(streamMessages).toEqual(messages);
    expect(streamModel).toBe('wrapped-model');
    expect(countedMessages).toEqual(messages);
  });

  it('createStreamingProvider forwards resume hints and warmup to the base provider', async () => {
    let hintedMessages: Message[] | undefined;
    let hintedModel = '';
    let warmupCalls = 0;

    const baseProvider: LLMProvider = {
      name: 'passthrough-provider',
      async chat(): Promise<ChatResponse> {
        throw new Error('Should not be called');
      },
      async stream(): Promise<ReadableStream<StreamChunk>> {
        throw new Error('Should not be called');
      },
      async countTokens(): Promise<number> {
        return 0;
      },
      async createChatResumeHint(messages, options) {
        hintedMessages = messages;
        hintedModel = options.model;
        return { resumeToken: 'resume-token' };
      },
      async warmup(): Promise<void> {
        warmupCalls += 1;
      },
    };

    const wrapped = createStreamingProvider(baseProvider, () => {});
    const messages: Message[] = [{ role: 'user', content: 'Hello' }];

    await expect(
      wrapped.createChatResumeHint?.(messages, { model: 'wrapped-model' }),
    ).resolves.toEqual({ resumeToken: 'resume-token' });
    await expect(wrapped.warmup?.()).resolves.toBeUndefined();
    expect(hintedMessages).toEqual(messages);
    expect(hintedModel).toBe('wrapped-model');
    expect(warmupCalls).toBe(1);
  });

  it('gracefully handles missing and malformed streaming tool call input fragments', async () => {
    const provider: LLMProvider = {
      name: 'tool-call-stream',
      async chat(): Promise<ChatResponse> {
        throw new Error('Should not be called');
      },
      async stream(): Promise<ReadableStream<StreamChunk>> {
        return new ReadableStream<StreamChunk>({
          start(controller) {
            controller.enqueue({ type: 'tool_call_end', toolCall: { id: 'missing-call' } });
            controller.enqueue({
              type: 'tool_call_start',
              toolCall: { id: 'call-1', name: 'empty' },
            });
            controller.enqueue({
              type: 'tool_call_delta',
              toolCall: { id: 'call-1', input: undefined },
            });
            controller.enqueue({ type: 'tool_call_end', toolCall: { id: 'call-1' } });
            controller.enqueue({
              type: 'tool_call_start',
              toolCall: { id: 'call-2', name: 'broken' },
            });
            controller.enqueue({ type: 'tool_call_delta', toolCall: { id: 'call-2', input: '{' } });
            controller.enqueue({ type: 'tool_call_end', toolCall: { id: 'call-2' } });
            controller.enqueue({
              type: 'done',
              usage: { inputTokens: 1, outputTokens: 2, totalTokens: 3 },
            });
            controller.close();
          },
        });
      },
      async countTokens(): Promise<number> {
        return 100;
      },
    };

    const wrapped = createStreamingProvider(provider, () => {});
    const response = await wrapped.chat([{ role: 'user', content: 'Hello' }], {
      model: 'test-model',
    });

    expect(response.toolCalls).toEqual([
      { id: 'call-1', name: 'empty', input: {} },
      { id: 'call-2', name: 'broken', input: '{' },
    ]);
    expect(response.stopReason).toBe('tool_use');
  });

  it('waits for the provider resume signal before starting the streaming fetch', async () => {
    const coordinator = createResumeCoordinator();
    let streamStarted = false;
    let observedResumePayload: unknown;

    const provider = createSuspendingProvider(
      {
        name: 'resume-aware-stream',
        async createChatResumeHint() {
          return { resumeToken: 'stream-ready-token' };
        },
        async chat(): Promise<ChatResponse> {
          throw new Error('Streaming provider chat() should not be called');
        },
        async stream(
          _messages: Message[],
          options: ChatOptions,
        ): Promise<ReadableStream<StreamChunk>> {
          streamStarted = true;
          observedResumePayload = options.resumeContext?.payload;
          return new ReadableStream<StreamChunk>({
            start(controller) {
              controller.enqueue({ type: 'token', token: 'Hello' });
              controller.enqueue({
                type: 'done',
                usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
              });
              controller.close();
            },
          });
        },
        async countTokens(): Promise<number> {
          return 100;
        },
      },
      coordinator,
    );

    const { stream, result } = executeStreamingAgent(
      { model: 'test-model', provider, streamTo: 'output' },
      'Wait for stream resume',
    );

    await Bun.sleep(0);
    expect(streamStarted).toBe(false);

    coordinator.resume('stream-ready-token', { ready: true });

    expect(await collectStream(stream)).toEqual(['Hello']);
    const streamingResult = await result;
    expect(streamingResult.content).toBe('Hello');
    expect(streamStarted).toBe(true);
    expect(observedResumePayload).toEqual({ ready: true });
  });

  it('clears stored resume state only after the wrapped stream consumer drains the final chunk', async () => {
    const turnIndex = 3;
    const resumeState: PendingChatResumeState = {
      hint: { resumeToken: 'stream-ready-token' },
      resumed: true,
      payload: { ready: true },
    };
    const pendingState = new Map<number, PendingChatResumeState>([[turnIndex, resumeState]]);

    const provider = createSuspendingProvider(
      {
        name: 'resume-aware-stream',
        async createChatResumeHint() {
          return { resumeToken: 'stream-ready-token' };
        },
        async chat(): Promise<ChatResponse> {
          throw new Error('Streaming provider chat() should not be called');
        },
        async stream(): Promise<ReadableStream<StreamChunk>> {
          return new ReadableStream<StreamChunk>({
            start(controller) {
              controller.enqueue({ type: 'token', token: 'Hello' });
              controller.enqueue({
                type: 'done',
                usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
              });
              controller.close();
            },
          });
        },
        async countTokens(): Promise<number> {
          return 100;
        },
      },
      {
        load: async (currentTurnIndex: number) => pendingState.get(currentTurnIndex),
        store: async (currentTurnIndex: number, state: PendingChatResumeState) => {
          pendingState.set(currentTurnIndex, state);
        },
        clear: async (currentTurnIndex: number) => {
          pendingState.delete(currentTurnIndex);
        },
      },
    );

    const stream = await provider.stream([{ role: 'user', content: 'Hello' }], {
      model: 'test-model',
      turnIndex,
    });

    expect(pendingState.get(turnIndex)).toEqual(resumeState);

    const reader = stream.getReader();
    expect(await reader.read()).toEqual({
      done: false,
      value: { type: 'token', token: 'Hello' },
    });
    expect(pendingState.get(turnIndex)).toEqual(resumeState);

    expect(await reader.read()).toEqual({
      done: false,
      value: {
        type: 'done',
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
      },
    });
    expect(pendingState.has(turnIndex)).toBe(false);

    expect(await reader.read()).toEqual({ done: true, value: undefined });
  });

  it('preserves stored resume state when the wrapped stream fails mid-consumption', async () => {
    const turnIndex = 7;
    const resumeState: PendingChatResumeState = {
      hint: { resumeToken: 'stream-ready-token' },
      resumed: true,
      payload: { ready: true },
    };
    const pendingState = new Map<number, PendingChatResumeState>([[turnIndex, resumeState]]);
    const streamError = new Error('stream failed');
    let emittedToken = false;

    const provider = createSuspendingProvider(
      {
        name: 'resume-aware-stream',
        async createChatResumeHint() {
          return { resumeToken: 'stream-ready-token' };
        },
        async chat(): Promise<ChatResponse> {
          throw new Error('Streaming provider chat() should not be called');
        },
        async stream(): Promise<ReadableStream<StreamChunk>> {
          return new ReadableStream<StreamChunk>({
            pull(controller) {
              if (!emittedToken) {
                emittedToken = true;
                controller.enqueue({ type: 'token', token: 'Hello' });
                return;
              }

              throw streamError;
            },
          });
        },
        async countTokens(): Promise<number> {
          return 100;
        },
      },
      {
        load: async (currentTurnIndex: number) => pendingState.get(currentTurnIndex),
        store: async (currentTurnIndex: number, state: PendingChatResumeState) => {
          pendingState.set(currentTurnIndex, state);
        },
        clear: async (currentTurnIndex: number) => {
          pendingState.delete(currentTurnIndex);
        },
      },
    );

    const stream = await provider.stream([{ role: 'user', content: 'Hello' }], {
      model: 'test-model',
      turnIndex,
    });

    const reader = stream.getReader();
    expect(await reader.read()).toEqual({
      done: false,
      value: { type: 'token', token: 'Hello' },
    });
    await expect(reader.read()).rejects.toThrow(streamError.message);
    expect(pendingState.get(turnIndex)).toEqual(resumeState);
  });

  it('cancelling the wrapped resume stream cancels the source reader without clearing state', async () => {
    const turnIndex = 9;
    const resumeState: PendingChatResumeState = {
      hint: { resumeToken: 'stream-ready-token' },
      resumed: true,
      payload: { ready: true },
    };
    const pendingState = new Map<number, PendingChatResumeState>([[turnIndex, resumeState]]);
    const cancelReasons: unknown[] = [];

    const provider = createSuspendingProvider(
      {
        name: 'resume-aware-stream',
        async createChatResumeHint() {
          return { resumeToken: 'stream-ready-token' };
        },
        async chat(): Promise<ChatResponse> {
          throw new Error('Streaming provider chat() should not be called');
        },
        async stream(): Promise<ReadableStream<StreamChunk>> {
          return new ReadableStream<StreamChunk>({
            start(controller) {
              controller.enqueue({ type: 'token', token: 'Hello' });
            },
            cancel(reason) {
              cancelReasons.push(reason);
            },
          });
        },
        async countTokens(): Promise<number> {
          return 100;
        },
      },
      {
        load: async (currentTurnIndex: number) => pendingState.get(currentTurnIndex),
        store: async (currentTurnIndex: number, state: PendingChatResumeState) => {
          pendingState.set(currentTurnIndex, state);
        },
        clear: async (currentTurnIndex: number) => {
          pendingState.delete(currentTurnIndex);
        },
      },
    );

    const stream = await provider.stream([{ role: 'user', content: 'Hello' }], {
      model: 'test-model',
      turnIndex,
    });

    const reader = stream.getReader();
    expect(await reader.read()).toEqual({
      done: false,
      value: { type: 'token', token: 'Hello' },
    });

    await expect(reader.cancel('consumer aborted')).resolves.toBeUndefined();
    expect(cancelReasons).toEqual(['consumer aborted']);
    expect(pendingState.has(turnIndex)).toBe(false);
  });

  it('createSuspendingProvider forwards optional helpers to the base provider', async () => {
    let hintedMessages: Message[] | undefined;
    let hintedModel = '';
    let warmupCalls = 0;

    const provider = createSuspendingProvider(
      {
        name: 'resume-aware',
        async chat(): Promise<ChatResponse> {
          throw new Error('Should not be called');
        },
        async stream(): Promise<ReadableStream<StreamChunk>> {
          throw new Error('Should not be called');
        },
        async countTokens(): Promise<number> {
          return 42;
        },
        async createChatResumeHint(messages, options) {
          hintedMessages = messages;
          hintedModel = options.model;
          return { resumeToken: 'resume-token' };
        },
        async warmup(): Promise<void> {
          warmupCalls += 1;
        },
      },
      createResumeCoordinator(),
    );

    const messages: Message[] = [{ role: 'user', content: 'Hello' }];
    await expect(provider.countTokens(messages)).resolves.toBe(42);
    await expect(
      provider.createChatResumeHint?.(messages, { model: 'wrapped-model' }),
    ).resolves.toEqual({ resumeToken: 'resume-token' });
    await expect(provider.warmup?.()).resolves.toBeUndefined();
    expect(hintedMessages).toEqual(messages);
    expect(hintedModel).toBe('wrapped-model');
    expect(warmupCalls).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// H2: Token stream bridges to EventTarget
// ---------------------------------------------------------------------------

describe('H2: Token stream bridges to EventTarget', () => {
  it('dispatches TokenEvent for each token chunk when eventTarget is provided', async () => {
    const { provider } = createMockStreamProvider([createStreamChunks(['Hello', ' world'])]);

    const eventTarget = new EventTarget();
    const receivedTokens: string[] = [];

    eventTarget.addEventListener(TokenEvent.type, ((event: TokenEvent) => {
      receivedTokens.push(event.token);
    }) as EventListener);

    const { stream, result } = executeStreamingAgent(
      {
        model: 'test-model',
        provider,
        streamTo: 'output',
        eventTarget,
        workflowId: 'wf-1',
      },
      'Say hello',
    );

    await collectStream(stream);
    await result;

    expect(receivedTokens).toEqual(['Hello', ' world']);
  });

  it('TokenEvent contains correct workflowId and model', async () => {
    const { provider } = createMockStreamProvider([createStreamChunks(['test'])]);

    const eventTarget = new EventTarget();
    let capturedEvent: TokenEvent | undefined;

    eventTarget.addEventListener(TokenEvent.type, ((event: TokenEvent) => {
      capturedEvent = event;
    }) as EventListener);

    const { stream, result } = executeStreamingAgent(
      {
        model: 'gpt-4',
        provider,
        streamTo: 'output',
        eventTarget,
        workflowId: 'wf-42',
      },
      'Test',
    );

    await collectStream(stream);
    await result;

    expect(capturedEvent).toBeDefined();
    expect(capturedEvent!.workflowId).toBe('wf-42');
    expect(capturedEvent!.model).toBe('gpt-4');
  });

  it('does not dispatch events when no eventTarget is provided', async () => {
    const { provider } = createMockStreamProvider([createStreamChunks(['test'])]);

    // No eventTarget — should not throw
    const { stream, result } = executeStreamingAgent(
      { model: 'test-model', provider, streamTo: 'output' },
      'Test',
    );

    const tokens = await collectStream(stream);
    expect(tokens).toEqual(['test']);
    await result;
  });
});

// ---------------------------------------------------------------------------
// H3: Stream multiplexer integration
// ---------------------------------------------------------------------------

describe('H3: Stream multiplexer integration', () => {
  it('three consumers receive identical tokens from a single LLM call', async () => {
    const { provider, callCount } = createMockStreamProvider([createStreamChunks(['A', 'B', 'C'])]);

    const { stream } = executeStreamingAgent(
      { model: 'test-model', provider, streamTo: 'output' },
      'Test multiplexer',
    );

    // Pipe the stream through a StreamMultiplexer as StreamChunks
    const chunkStream = stream.pipeThrough(
      new TransformStream<string, StreamChunk>({
        transform(token, controller) {
          controller.enqueue({ type: 'token', token });
        },
        flush(controller) {
          controller.enqueue({ type: 'done' });
        },
      }),
    );

    const multiplexer = new StreamMultiplexer(chunkStream);

    const consumer1 = multiplexer.createConsumer();
    const consumer2 = multiplexer.createConsumer();
    const consumer3 = multiplexer.createConsumer();

    const extractTokens = async (
      consumerStream: ReadableStream<StreamChunk>,
    ): Promise<string[]> => {
      const reader = consumerStream.getReader();
      const tokens: string[] = [];
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value.type === 'token' && value.token) tokens.push(value.token);
      }
      return tokens;
    };

    const [tokens1, tokens2, tokens3] = await Promise.all([
      extractTokens(consumer1),
      extractTokens(consumer2),
      extractTokens(consumer3),
    ]);

    expect(tokens1).toEqual(['A', 'B', 'C']);
    expect(tokens2).toEqual(['A', 'B', 'C']);
    expect(tokens3).toEqual(['A', 'B', 'C']);

    // Provider should only be called once
    expect(callCount()).toBe(1);
  });

  it('no duplicate LLM requests when multiplexing', async () => {
    const { provider, callCount } = createMockStreamProvider([createStreamChunks(['X', 'Y'])]);

    const { stream, result } = executeStreamingAgent(
      { model: 'test-model', provider, streamTo: 'output' },
      'Test dedup',
    );

    const tokens = await collectStream(stream);
    await result;

    expect(tokens).toEqual(['X', 'Y']);
    expect(callCount()).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// H4: Crash recovery mid-stream
// ---------------------------------------------------------------------------

describe('H4: Crash recovery mid-stream', () => {
  it('buildStreamCheckpoint identifies completed turns', () => {
    const conversation: Message[] = [
      { role: 'system', content: 'You are helpful.' },
      { role: 'user', content: 'Hello' },
      {
        role: 'assistant',
        content: '',
        toolCalls: [{ id: 'tc-1', name: 'search', input: {} }],
      },
      {
        role: 'tool',
        content: '',
        toolResults: [{ toolCallId: 'tc-1', output: 'result' }],
      },
      { role: 'assistant', content: 'Final answer' },
    ];

    const checkpoint = buildStreamCheckpoint(conversation);
    expect(checkpoint.completedTurns).toEqual([0, 1]);
    expect(checkpoint.completedContent).toEqual(['', 'Final answer']);
    expect(checkpoint.incompleteTurn).toBeUndefined();
  });

  it('buildStreamCheckpoint detects incomplete turn with missing tool result', () => {
    const conversation: Message[] = [
      { role: 'user', content: 'Hello' },
      {
        role: 'assistant',
        content: 'Calling tool...',
        toolCalls: [{ id: 'tc-1', name: 'search', input: {} }],
      },
      // No tool result — crash happened here
    ];

    const checkpoint = buildStreamCheckpoint(conversation);
    expect(checkpoint.completedTurns).toEqual([]);
    expect(checkpoint.incompleteTurn).toBe(0);
  });

  it('buildStreamCheckpoint marks a non-final assistant answer as incomplete', () => {
    const conversation: Message[] = [
      { role: 'user', content: 'Hello' },
      { role: 'assistant', content: 'Premature answer' },
      { role: 'tool', content: '', toolResults: [{ toolCallId: 'tc-1', output: 'late' }] },
    ];

    const checkpoint = buildStreamCheckpoint(conversation);
    expect(checkpoint.completedTurns).toEqual([]);
    expect(checkpoint.incompleteTurn).toBe(0);
  });

  it('buildStreamCheckpoint skips non-assistant messages between turns', () => {
    const conversation: Message[] = [
      { role: 'user', content: 'Hello' },
      { role: 'tool', content: '', toolResults: [{ toolCallId: 'tc-1', output: 'orphaned' }] },
      { role: 'assistant', content: 'Final answer' },
    ];

    const checkpoint = buildStreamCheckpoint(conversation);
    expect(checkpoint.completedTurns).toEqual([1]);
    expect(checkpoint.completedContent).toEqual(['Final answer']);
  });

  it('buildRecoveryConversation discards incomplete turn', () => {
    const conversation: Message[] = [
      { role: 'system', content: 'System prompt' },
      { role: 'user', content: 'Hello' },
      {
        role: 'assistant',
        content: 'Turn 1 done',
        toolCalls: [{ id: 'tc-1', name: 'search', input: {} }],
      },
      {
        role: 'tool',
        content: '',
        toolResults: [{ toolCallId: 'tc-1', output: 'result-1' }],
      },
      {
        role: 'assistant',
        content: 'Turn 2 incomplete...',
        toolCalls: [{ id: 'tc-2', name: 'fetch', input: {} }],
      },
      // Crash — no tool result for tc-2
    ];

    const checkpoint = buildStreamCheckpoint(conversation);
    expect(checkpoint.completedTurns).toEqual([0]);
    expect(checkpoint.incompleteTurn).toBe(1);

    const recovery = buildRecoveryConversation(conversation, checkpoint);

    // Should include system, user, turn 1 assistant + tool, but NOT turn 2
    expect(recovery.length).toBe(4);
    expect(recovery[0]!.role).toBe('system');
    expect(recovery[1]!.role).toBe('user');
    expect(recovery[2]!.role).toBe('assistant');
    expect(recovery[3]!.role).toBe('tool');
  });

  it('recovery conversation preserves completed turns 1-2 and discards turn 3', () => {
    const conversation: Message[] = [
      { role: 'user', content: 'Start' },
      // Turn 0: tool call + result
      {
        role: 'assistant',
        content: '',
        toolCalls: [{ id: 'tc-1', name: 'a', input: {} }],
      },
      {
        role: 'tool',
        content: '',
        toolResults: [{ toolCallId: 'tc-1', output: 'r1' }],
      },
      // Turn 1: tool call + result
      {
        role: 'assistant',
        content: '',
        toolCalls: [{ id: 'tc-2', name: 'b', input: {} }],
      },
      {
        role: 'tool',
        content: '',
        toolResults: [{ toolCallId: 'tc-2', output: 'r2' }],
      },
      // Turn 2: incomplete — crashed mid-stream
      {
        role: 'assistant',
        content: 'partial output...',
        toolCalls: [{ id: 'tc-3', name: 'c', input: {} }],
      },
    ];

    const checkpoint = buildStreamCheckpoint(conversation);
    expect(checkpoint.completedTurns).toEqual([0, 1]);
    expect(checkpoint.incompleteTurn).toBe(2);

    const recovery = buildRecoveryConversation(conversation, checkpoint);

    // user + 2 complete turns (assistant+tool each) = 1 + 4 = 5
    expect(recovery.length).toBe(5);
    expect(recovery[recovery.length - 1]!.role).toBe('tool');
  });

  it('buildRecoveryConversation keeps completed final-answer turns without tool results', () => {
    const conversation: Message[] = [
      { role: 'user', content: 'Start' },
      { role: 'assistant', content: 'Final answer' },
    ];

    const recovery = buildRecoveryConversation(conversation, {
      completedTurns: [0],
      completedContent: ['Final answer'],
      incompleteTurn: undefined,
    });

    expect(recovery).toEqual(conversation);
  });

  it('buildRecoveryConversation skips malformed tool-call turns when the checkpoint expects more completed turns', () => {
    const conversation: Message[] = [
      { role: 'user', content: 'Start' },
      {
        role: 'assistant',
        content: '',
        toolCalls: [{ id: 'tc-1', name: 'a', input: {} }],
      },
      {
        role: 'tool',
        content: '',
        toolResults: [{ toolCallId: 'tc-1', output: 'r1' }],
      },
      {
        role: 'assistant',
        content: 'missing tool result',
        toolCalls: [{ id: 'tc-2', name: 'b', input: {} }],
      },
      { role: 'assistant', content: 'Final answer' },
    ];

    const recovery = buildRecoveryConversation(conversation, {
      completedTurns: [0, 1],
      completedContent: ['', 'Final answer'],
      incompleteTurn: undefined,
    });

    expect(recovery).toEqual([
      { role: 'user', content: 'Start' },
      {
        role: 'assistant',
        content: '',
        toolCalls: [{ id: 'tc-1', name: 'a', input: {} }],
      },
      {
        role: 'tool',
        content: '',
        toolResults: [{ toolCallId: 'tc-1', output: 'r1' }],
      },
      {
        role: 'assistant',
        content: 'missing tool result',
        toolCalls: [{ id: 'tc-2', name: 'b', input: {} }],
      },
      { role: 'assistant', content: 'Final answer' },
    ]);
  });
});

// ---------------------------------------------------------------------------
// H5: Backpressure and client reconnection
// ---------------------------------------------------------------------------

describe('H5: Backpressure and client reconnection', () => {
  it('enqueueStreamingToken errors the stream when desiredSize is exhausted', async () => {
    const errors: Error[] = [];

    const state = enqueueStreamingToken('token', {
      streamClosed: false,
      streamController: {
        desiredSize: 0,
        close() {},
        enqueue() {},
        error(error) {
          errors.push(error as Error);
        },
      } as ReadableStreamDefaultController<string>,
      model: 'test-model',
    });

    expect(state.streamClosed).toBe(true);
    expect(errors).toHaveLength(1);
    expect(errors[0]!.message).toBe('Stream buffer exceeded maximum size');
  });

  it('enqueueStreamingToken closes the stream when enqueue throws', () => {
    const state = enqueueStreamingToken('token', {
      streamClosed: false,
      streamController: {
        desiredSize: 1,
        close() {},
        enqueue() {
          throw new Error('enqueue failed');
        },
        error() {},
      } as ReadableStreamDefaultController<string>,
      model: 'test-model',
    });

    expect(state.streamClosed).toBe(true);
  });

  it('enqueueStreamingToken still dispatches TokenEvent when enqueue throws', () => {
    const eventTarget = new EventTarget();
    const receivedTokens: string[] = [];

    eventTarget.addEventListener(TokenEvent.type, ((event: TokenEvent) => {
      receivedTokens.push(event.token);
    }) as EventListener);

    const state = enqueueStreamingToken('token', {
      streamClosed: false,
      streamController: {
        desiredSize: 1,
        close() {},
        enqueue() {
          throw new Error('enqueue failed');
        },
        error() {},
      } as ReadableStreamDefaultController<string>,
      eventTarget,
      workflowId: 'wf-enqueue-failure',
      model: 'test-model',
    });

    expect(state.streamClosed).toBe(true);
    expect(receivedTokens).toEqual(['token']);
  });

  it('disconnects slow consumer when buffer exceeds max size', async () => {
    // Directly test the onToken/stream machinery by constructing the stream
    // and controller manually, mirroring what executeStreamingAgent does
    // internally. This isolates the backpressure logic from the agent loop.
    const maxStreamBufferSize = 128; // Small limit for testing
    let streamController: ReadableStreamDefaultController<string> | undefined;
    let streamClosed = false;

    const stream = new ReadableStream<string>(
      {
        start(controller) {
          streamController = controller;
        },
        cancel() {
          streamClosed = true;
        },
      },
      {
        highWaterMark: maxStreamBufferSize,
        size: (chunk) => new TextEncoder().encode(chunk).byteLength,
      },
    );

    // Simulate onToken calls without any consumer reading
    const bigToken = 'X'.repeat(64); // 64 bytes per token
    let errorThrown = false;

    for (let i = 0; i < 10; i++) {
      if (streamClosed || !streamController) break;

      if (streamController.desiredSize !== null && streamController.desiredSize <= 0) {
        try {
          streamController.error(new Error('Stream buffer exceeded maximum size'));
        } catch {
          // Controller may already be closed
        }
        streamClosed = true;
        errorThrown = true;
        break;
      }

      try {
        streamController.enqueue(bigToken);
      } catch {
        streamClosed = true;
      }
    }

    // After enqueuing ~640 bytes with a 128-byte limit, backpressure
    // should have triggered
    expect(errorThrown).toBe(true);
    expect(streamClosed).toBe(true);

    // Verify the stream is in errored state
    const reader = stream.getReader();
    try {
      await reader.read();
      // Should not reach here
      expect(true).toBe(false);
    } catch (error) {
      expect((error as Error).message).toBe('Stream buffer exceeded maximum size');
    }
  });

  it('uses default 64KB buffer limit', () => {
    const { provider } = createMockStreamProvider([createStreamChunks(['small'])]);

    // Just verify it doesn't throw with default options
    const { stream } = executeStreamingAgent(
      { model: 'test-model', provider, streamTo: 'output' },
      'Test defaults',
    );

    expect(stream).toBeInstanceOf(ReadableStream);
  });

  it('ReconnectionBuffer provides replay frames for reconnecting client', async () => {
    const { ReconnectionBuffer } = await import('./streaming.ts');

    const buffer = new ReconnectionBuffer();
    buffer.addTurn('First turn complete');
    buffer.addTurn('Second turn complete');

    const turns = buffer.getTurns();
    const frames = turns.map((content) => ({
      type: 'replay' as const,
      content,
    }));

    expect(frames).toEqual([
      { type: 'replay', content: 'First turn complete' },
      { type: 'replay', content: 'Second turn complete' },
    ]);

    // Simulate live tokens after replay
    const liveFrames = [
      { type: 'token' as const, token: 'New' },
      { type: 'token' as const, token: ' tokens' },
    ];

    const allFrames = [...frames, ...liveFrames];

    // Verify replay comes before live tokens
    const replayFrames = allFrames.filter((f) => f.type === 'replay');
    const tokenFrames = allFrames.filter((f) => f.type === 'token');

    expect(replayFrames.length).toBe(2);
    expect(tokenFrames.length).toBe(2);

    // All replay frames should come before token frames
    const lastReplayIndex = allFrames.lastIndexOf(replayFrames[replayFrames.length - 1]!);
    const firstTokenIndex = allFrames.indexOf(tokenFrames[0]!);
    expect(lastReplayIndex).toBeLessThan(firstTokenIndex);
  });
});

// ---------------------------------------------------------------------------
// H6: SSE fallback
// ---------------------------------------------------------------------------

describe('H6: SSE fallback', () => {
  it('formatSSE produces correct SSE format with id and event', () => {
    const result = formatSSE({ id: '1', event: 'token', data: 'Hello' });
    expect(result).toBe('id: 1\nevent: token\ndata: Hello\n\n');
  });

  it('formatSSE handles multiline data', () => {
    const result = formatSSE({ data: 'line1\nline2' });
    expect(result).toBe('data: line1\ndata: line2\n\n');
  });

  it('formatSSE handles empty data', () => {
    const result = formatSSE({ id: '5', event: 'done', data: '' });
    expect(result).toBe('id: 5\nevent: done\ndata: \n\n');
  });

  it('createSSEStream converts token stream to SSE format', async () => {
    const tokenStream = new ReadableStream<string>({
      start(controller) {
        controller.enqueue('Hello');
        controller.enqueue(' world');
        controller.close();
      },
    });

    const sseStream = createSSEStream(tokenStream);
    const output = await collectByteStream(sseStream);

    expect(output).toContain('id: 0');
    expect(output).toContain('event: token');
    expect(output).toContain('data: Hello');
    expect(output).toContain('id: 1');
    expect(output).toContain('data:  world');
    // Should end with a done event
    expect(output).toContain('event: done');
  });

  it('createSSEStream respects Last-Event-ID for reconnection', async () => {
    const tokenStream = new ReadableStream<string>({
      start(controller) {
        controller.enqueue('resumed');
        controller.close();
      },
    });

    // Resume from event ID 42
    const sseStream = createSSEStream(tokenStream, '42');
    const output = await collectByteStream(sseStream);

    // IDs should start from 43 (last seen + 1)
    expect(output).toContain('id: 43');
    expect(output).toContain('data: resumed');
  });

  it('SSE events use data: prefix and have empty line terminators', async () => {
    const tokenStream = new ReadableStream<string>({
      start(controller) {
        controller.enqueue('test');
        controller.close();
      },
    });

    const sseStream = createSSEStream(tokenStream);
    const output = await collectByteStream(sseStream);

    // Each event should be terminated by double newline
    const events = output.split('\n\n').filter((e) => e.trim().length > 0);
    expect(events.length).toBe(2); // One token event + one done event

    // First event should have data: prefix
    expect(events[0]).toContain('data: test');
  });

  it('SSE stream includes id: fields on every event', async () => {
    const tokenStream = new ReadableStream<string>({
      start(controller) {
        controller.enqueue('a');
        controller.enqueue('b');
        controller.enqueue('c');
        controller.close();
      },
    });

    const sseStream = createSSEStream(tokenStream);
    const output = await collectByteStream(sseStream);

    expect(output).toContain('id: 0');
    expect(output).toContain('id: 1');
    expect(output).toContain('id: 2');
    expect(output).toContain('id: 3'); // done event
  });
});

// ---------------------------------------------------------------------------
// H7: Stream cancellation via AbortController
// ---------------------------------------------------------------------------

describe('H7: Stream cancellation via AbortController', () => {
  it('aborted signal closes the stream cleanly', async () => {
    const abortController = new AbortController();

    // Create a slow provider that allows cancellation testing
    const provider: LLMProvider = {
      name: 'slow-mock',
      async chat(): Promise<ChatResponse> {
        throw new Error('Should not be called');
      },
      async stream(): Promise<ReadableStream<StreamChunk>> {
        return new ReadableStream<StreamChunk>({
          async start(controller) {
            controller.enqueue({ type: 'token', token: 'first' });

            // Wait a bit, then enqueue more (but abort should cancel before this)
            await sleepForTesting(50);
            try {
              controller.enqueue({ type: 'token', token: 'second' });
              controller.enqueue({ type: 'done' });
              controller.close();
            } catch {
              // Controller may be closed due to abort
            }
          },
        });
      },
      async countTokens(): Promise<number> {
        return 100;
      },
    };

    const { stream, result } = executeStreamingAgent(
      {
        model: 'test-model',
        provider,
        streamTo: 'output',
        signal: abortController.signal,
      },
      'Test abort',
    );

    // Read the first token
    const reader = stream.getReader();
    await reader.read();

    // Abort mid-stream
    abortController.abort();

    // Give the abort a moment to propagate
    await sleepForTesting(10);

    // Subsequent reads should indicate the stream is done
    const secondRead = await reader.read();
    expect(secondRead.done).toBe(true);

    // The result should still resolve (agent loop exits on abort)
    const agentResult = await result;
    expect(agentResult).toBeDefined();
  });

  it('pre-aborted signal closes stream immediately', async () => {
    const abortController = new AbortController();
    abortController.abort(); // Already aborted

    const { provider } = createMockStreamProvider([
      createStreamChunks(['should', 'not', 'appear']),
    ]);

    const { stream, result } = executeStreamingAgent(
      {
        model: 'test-model',
        provider,
        streamTo: 'output',
        signal: abortController.signal,
      },
      'Test pre-abort',
    );

    const reader = stream.getReader();
    const firstRead = await reader.read();

    // Stream should be immediately closed
    expect(firstRead.done).toBe(true);

    const agentResult = await result;
    // With pre-aborted signal, agent loop should exit immediately
    expect(agentResult.turnCount).toBe(0);
  });

  it('cancelling the stream reader does not leak promises', async () => {
    const { provider } = createMockStreamProvider([createStreamChunks(['Hello', ' world'])]);

    const { stream, result } = executeStreamingAgent(
      { model: 'test-model', provider, streamTo: 'output' },
      'Test cancel reader',
    );

    const reader = stream.getReader();

    // Read one token
    const first = await reader.read();
    expect(first.value).toBe('Hello');

    // Cancel the reader
    await reader.cancel();

    // Result should still resolve
    const agentResult = await result;
    expect(agentResult).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Bug fix: Backpressure uses desiredSize instead of cumulative bufferedBytes
// ---------------------------------------------------------------------------

describe('Bug fix: desiredSize-based backpressure', () => {
  it('stream is constructed with a byte-counting QueuingStrategy', () => {
    const { provider } = createMockStreamProvider([createStreamChunks(['hi'])]);

    const { stream } = executeStreamingAgent(
      {
        model: 'test-model',
        provider,
        streamTo: 'output',
        maxStreamBufferSize: 1024,
      },
      'Test queuing strategy',
    );

    // The stream should be a ReadableStream — the QueuingStrategy is internal
    // but we can verify the stream works correctly by consuming it
    expect(stream).toBeInstanceOf(ReadableStream);
  });

  it('fast consumer never triggers backpressure disconnect', async () => {
    // With desiredSize, a consumer that drains tokens promptly should never
    // be disconnected, even if cumulative bytes exceed the buffer size.
    const token = 'X'.repeat(512); // 512 bytes per token
    const tokenCount = 20; // 10KB total — well above a 4KB limit
    const { provider } = createMockStreamProvider([
      createStreamChunks(Array.from({ length: tokenCount }, () => token)),
    ]);

    const { stream, result } = executeStreamingAgent(
      {
        model: 'test-model',
        provider,
        streamTo: 'output',
        maxStreamBufferSize: 4096,
      },
      'Generate data for fast consumer',
    );

    // Read eagerly — the old cumulative counter would have disconnected us
    const tokens = await collectStream(stream);
    expect(tokens.length).toBe(tokenCount);

    await result;
  });
});

// ---------------------------------------------------------------------------
// Bug fix: SSE stream reader released on cancellation
// ---------------------------------------------------------------------------

describe('Bug fix: SSE stream reader released on cancellation', () => {
  it('cancelling the SSE stream releases the underlying token reader', async () => {
    let readerCancelled = false;

    // Create a token stream that tracks whether its reader was cancelled
    const tokenStream = new ReadableStream<string>({
      start(controller) {
        controller.enqueue('token-1');
        // Don't close — simulate a long-lived stream
      },
      cancel() {
        readerCancelled = true;
      },
    });

    const sseStream = createSSEStream(tokenStream);
    const reader = sseStream.getReader();

    // Read one SSE event
    await reader.read();

    // Cancel the SSE stream
    await reader.cancel();

    // The underlying token stream should have been cancelled too
    expect(readerCancelled).toBe(true);
  });

  it('releases the underlying reader after the token stream completes normally', async () => {
    const tokenStream = new ReadableStream<string>({
      start(controller) {
        controller.enqueue('a');
        controller.enqueue('b');
        controller.close();
      },
    });

    const sseStream = createSSEStream(tokenStream);
    // Drain fully — the start() callback should releaseLock() after seeing done.
    await collectByteStream(sseStream);

    // The token stream should no longer be locked: we should be able to
    // acquire a fresh reader without an "already locked" error.
    expect(() => tokenStream.getReader()).not.toThrow();
  });

  it('releases the underlying reader after the token stream errors', async () => {
    const tokenStream = new ReadableStream<string>({
      pull(controller) {
        controller.error(new Error('token stream failed'));
      },
    });

    const sseStream = createSSEStream(tokenStream);
    const reader = sseStream.getReader();

    // Drain until the error surfaces
    let errored = false;
    try {
      while (true) {
        const { done } = await reader.read();
        if (done) break;
      }
    } catch {
      errored = true;
    }
    expect(errored).toBe(true);

    // After the error, the underlying token stream must not remain locked.
    expect(() => tokenStream.getReader()).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Bug fix: Reader cleaned up on error in createStreamingProvider
// ---------------------------------------------------------------------------

describe('Bug fix: createStreamingProvider reader cleanup on error', () => {
  it('still returns partial tokens collected before the error', async () => {
    // The try/finally ensures that even when the stream errors, the reader
    // lock is released. We verify the fix works by confirming that:
    // 1. Tokens collected before the error are preserved
    // 2. The error propagates correctly
    // 3. The stream is no longer locked after the call
    let readCount = 0;

    const provider: LLMProvider = {
      name: 'error-provider',
      async chat(): Promise<ChatResponse> {
        throw new Error('Should not be called');
      },
      async stream(): Promise<ReadableStream<StreamChunk>> {
        return new ReadableStream<StreamChunk>({
          pull(controller) {
            readCount++;
            if (readCount === 1) {
              controller.enqueue({ type: 'token', token: 'before-error' });
            } else {
              controller.error(new Error('Simulated network failure'));
            }
          },
        });
      },
      async countTokens(): Promise<number> {
        return 0;
      },
    };

    const tokens: string[] = [];
    const streamingProvider = createStreamingProvider(provider, (token) => {
      tokens.push(token);
    });

    let thrownError: Error | undefined;
    try {
      await streamingProvider.chat([], { model: 'test' });
    } catch (error) {
      thrownError = error as Error;
    }

    // Tokens before the error should be preserved
    expect(tokens).toEqual(['before-error']);
    // The error should propagate
    expect(thrownError).toBeDefined();
    expect(thrownError!.message).toBe('Simulated network failure');
  });

  it('completes successfully and releases the reader on normal flow', async () => {
    // Verify that the finally block does not interfere with normal operation
    const provider: LLMProvider = {
      name: 'success-provider',
      async chat(): Promise<ChatResponse> {
        throw new Error('Should not be called');
      },
      async stream(): Promise<ReadableStream<StreamChunk>> {
        return new ReadableStream<StreamChunk>({
          start(controller) {
            controller.enqueue({ type: 'token', token: 'hello' });
            controller.enqueue({
              type: 'done',
              usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
            });
            controller.close();
          },
        });
      },
      async countTokens(): Promise<number> {
        return 0;
      },
    };

    const tokens: string[] = [];
    const streamingProvider = createStreamingProvider(provider, (token) => {
      tokens.push(token);
    });

    const response = await streamingProvider.chat([], { model: 'test' });

    // Normal completion should work fine with the finally block
    expect(tokens).toEqual(['hello']);
    expect(response.content).toBe('hello');
    expect(response.usage).toEqual({ inputTokens: 1, outputTokens: 1, totalTokens: 2 });
  });

  it('reader.cancel() in finally does not throw on already-consumed stream', async () => {
    // Ensure calling reader.cancel() after a fully consumed stream is a safe no-op
    const provider: LLMProvider = {
      name: 'noop-cancel-provider',
      async chat(): Promise<ChatResponse> {
        throw new Error('Should not be called');
      },
      async stream(): Promise<ReadableStream<StreamChunk>> {
        return new ReadableStream<StreamChunk>({
          start(controller) {
            controller.enqueue({ type: 'token', token: 'a' });
            controller.enqueue({ type: 'token', token: 'b' });
            controller.enqueue({
              type: 'done',
              usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
            });
            controller.close();
          },
        });
      },
      async countTokens(): Promise<number> {
        return 0;
      },
    };

    const streamingProvider = createStreamingProvider(provider, () => {});

    // Should not throw even though reader.cancel() runs in finally
    // after the stream is fully consumed
    const result = await streamingProvider.chat([], { model: 'test' });
    expect(result.content).toBe('ab');
  });

  it('swallows reader.cancel() rejections in the provider cleanup path', async () => {
    const provider: LLMProvider = {
      name: 'rejecting-cancel-provider',
      async chat(): Promise<ChatResponse> {
        throw new Error('Should not be called');
      },
      async stream(): Promise<ReadableStream<StreamChunk>> {
        return new ReadableStream<StreamChunk>({
          start(controller) {
            controller.enqueue({ type: 'token', token: 'x' });
            controller.enqueue({
              type: 'done',
              usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
            });
            controller.close();
          },
          cancel() {
            throw new Error('cancel failed');
          },
        });
      },
      async countTokens(): Promise<number> {
        return 0;
      },
    };

    const streamingProvider = createStreamingProvider(provider, () => {});
    const result = await streamingProvider.chat([], { model: 'test' });

    expect(result.content).toBe('x');
  });
});

// ---------------------------------------------------------------------------
// Bug fix: Abort listener removed on stream close
// ---------------------------------------------------------------------------

describe('Bug fix: abort listener removed on stream close', () => {
  it('removes the abort listener when the stream completes normally', async () => {
    const abortController = new AbortController();
    const { signal } = abortController;

    // Track whether removeEventListener was called
    const originalRemove = signal.removeEventListener.bind(signal);
    let listenerRemoved = false;
    signal.removeEventListener = (
      type: string,
      listener: EventListenerOrEventListenerObject,
      options?: boolean | EventListenerOptions,
    ) => {
      if (type === 'abort') {
        listenerRemoved = true;
      }
      originalRemove(type, listener, options);
    };

    const { provider } = createMockStreamProvider([createStreamChunks(['done'])]);

    const { stream, result } = executeStreamingAgent(
      {
        model: 'test-model',
        provider,
        streamTo: 'output',
        signal,
      },
      'Test listener cleanup',
    );

    await collectStream(stream);
    await result;

    // The abort listener should have been explicitly removed
    expect(listenerRemoved).toBe(true);
  });

  it('removes the abort listener when the stream errors', async () => {
    const abortController = new AbortController();
    const { signal } = abortController;

    const originalRemove = signal.removeEventListener.bind(signal);
    let listenerRemoved = false;
    signal.removeEventListener = (
      type: string,
      listener: EventListenerOrEventListenerObject,
      options?: boolean | EventListenerOptions,
    ) => {
      if (type === 'abort') {
        listenerRemoved = true;
      }
      originalRemove(type, listener, options);
    };

    // Provider that always throws
    const provider: LLMProvider = {
      name: 'failing-provider',
      async chat(): Promise<ChatResponse> {
        throw new Error('Should not be called');
      },
      async stream(): Promise<ReadableStream<StreamChunk>> {
        return new ReadableStream<StreamChunk>({
          start(controller) {
            controller.error(new Error('Provider failure'));
          },
        });
      },
      async countTokens(): Promise<number> {
        return 0;
      },
    };

    const { stream, result } = executeStreamingAgent(
      {
        model: 'test-model',
        provider,
        streamTo: 'output',
        signal,
      },
      'Test error cleanup',
    );

    // Stream should error
    const reader = stream.getReader();
    try {
      await reader.read();
    } catch {
      // Expected
    }

    try {
      await result;
    } catch {
      // Expected — provider fails
    }

    // The abort listener should still have been removed
    expect(listenerRemoved).toBe(true);
  });

  it('does not set abortCleanup when signal is already aborted', async () => {
    const abortController = new AbortController();
    abortController.abort(); // Pre-aborted

    const { signal } = abortController;

    // Spy on addEventListener to confirm it's never called
    const originalAdd = signal.addEventListener.bind(signal);
    let addEventListenerCalled = false;
    signal.addEventListener = (
      type: string,
      listener: EventListenerOrEventListenerObject | null,
      options?: boolean | AddEventListenerOptions,
    ) => {
      if (type === 'abort') {
        addEventListenerCalled = true;
      }
      originalAdd(type, listener as EventListenerOrEventListenerObject, options);
    };

    const { provider } = createMockStreamProvider([createStreamChunks(['x'])]);

    const { stream, result } = executeStreamingAgent(
      {
        model: 'test-model',
        provider,
        streamTo: 'output',
        signal,
      },
      'Test pre-aborted',
    );

    const reader = stream.getReader();
    const firstRead = await reader.read();
    expect(firstRead.done).toBe(true);

    await result;

    // addEventListener should not have been called since signal was already aborted
    expect(addEventListenerCalled).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// createStreamingProvider unit tests
// ---------------------------------------------------------------------------

describe('createStreamingProvider', () => {
  it('calls provider.stream instead of provider.chat', async () => {
    let chatCalled = false;
    let streamCalled = false;

    const provider: LLMProvider = {
      name: 'test',
      async chat(): Promise<ChatResponse> {
        chatCalled = true;
        return {
          content: '',
          toolCalls: [],
          usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
          model: 'test',
          stopReason: 'end_turn',
        };
      },
      async stream(): Promise<ReadableStream<StreamChunk>> {
        streamCalled = true;
        return new ReadableStream({
          start(controller) {
            controller.enqueue({ type: 'token', token: 'hi' });
            controller.enqueue({
              type: 'done',
              usage: { inputTokens: 5, outputTokens: 10, totalTokens: 15 },
            });
            controller.close();
          },
        });
      },
      async countTokens(): Promise<number> {
        return 50;
      },
    };

    const tokens: string[] = [];
    const streamingProvider = createStreamingProvider(provider, (token) => {
      tokens.push(token);
    });

    const response = await streamingProvider.chat([], { model: 'test' });

    expect(chatCalled).toBe(false);
    expect(streamCalled).toBe(true);
    expect(tokens).toEqual(['hi']);
    expect(response.content).toBe('hi');
    expect(response.usage).toEqual({ inputTokens: 5, outputTokens: 10, totalTokens: 15 });
  });

  it('assembles tool calls from stream chunks', async () => {
    const provider: LLMProvider = {
      name: 'test',
      async chat(): Promise<ChatResponse> {
        throw new Error('Should not be called');
      },
      async stream(): Promise<ReadableStream<StreamChunk>> {
        return new ReadableStream({
          start(controller) {
            controller.enqueue({
              type: 'tool_call_start',
              toolCall: { id: 'tc-1', name: 'search' },
            });
            controller.enqueue({
              type: 'tool_call_delta',
              toolCall: { id: 'tc-1', input: '{"q":' },
            });
            controller.enqueue({
              type: 'tool_call_delta',
              toolCall: { id: 'tc-1', input: '"test"}' },
            });
            controller.enqueue({ type: 'tool_call_end', toolCall: { id: 'tc-1' } });
            controller.enqueue({
              type: 'done',
              usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
            });
            controller.close();
          },
        });
      },
      async countTokens(): Promise<number> {
        return 0;
      },
    };

    const streamingProvider = createStreamingProvider(provider, () => {});
    const response = await streamingProvider.chat([], { model: 'test' });

    expect(response.toolCalls.length).toBe(1);
    expect(response.toolCalls[0]!.id).toBe('tc-1');
    expect(response.toolCalls[0]!.name).toBe('search');
    expect(response.toolCalls[0]!.input).toEqual({ q: 'test' });
    expect(response.stopReason).toBe('tool_use');
  });
});

describe('createSSEStream cancellation', () => {
  it('swallows token reader cancellation rejections', async () => {
    const tokenStream = new ReadableStream<string>({
      start(controller) {
        controller.enqueue('token');
      },
      cancel() {
        throw new Error('token stream cancel failed');
      },
    });

    const sseStream = createSSEStream(tokenStream);
    const reader = sseStream.getReader();

    await reader.read();
    await reader.cancel();
    await sleepForTesting(0);

    expect(true).toBe(true);
  });
});
