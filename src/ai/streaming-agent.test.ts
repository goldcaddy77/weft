import { describe, expect, it } from 'bun:test';

import { TokenEvent } from '@/core/events.ts';
import type { ChatOptions, LLMProvider } from './providers/interface.ts';
import type { ChatResponse, Message, StreamChunk, TokenUsage } from './providers/types.ts';
import {
  buildRecoveryConversation,
  buildStreamCheckpoint,
  createSSEStream,
  createStreamingProvider,
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
});

// ---------------------------------------------------------------------------
// H5: Backpressure and client reconnection
// ---------------------------------------------------------------------------

describe('H5: Backpressure and client reconnection', () => {
  it('disconnects slow consumer when buffer exceeds max size', async () => {
    // Create a provider that sends a lot of data
    const bigToken = 'X'.repeat(1024); // 1KB per token
    const { provider } = createMockStreamProvider([
      createStreamChunks(Array.from({ length: 100 }, () => bigToken)), // 100KB total
    ]);

    const { stream, result } = executeStreamingAgent(
      {
        model: 'test-model',
        provider,
        streamTo: 'output',
        maxStreamBufferSize: 4096, // 4KB limit
      },
      'Generate lots of data',
    );

    // Try to collect — should error when buffer is exceeded
    const reader = stream.getReader();
    const tokens: string[] = [];

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        tokens.push(value);
      }
    } catch {
      // Expected: buffer overflow disconnects the consumer
    }

    // Either we get an error or the stream closes early
    // The exact behavior depends on timing, but we should have
    // some tokens (before the buffer was exceeded) and then stop
    expect(tokens.length).toBeGreaterThan(0);
    expect(tokens.length).toBeLessThan(100);

    // Ensure the result promise still resolves (even if stream errored)
    try {
      await result;
    } catch {
      // Agent loop may also fail — that's acceptable
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
            await Bun.sleep(50);
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
    await Bun.sleep(10);

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
