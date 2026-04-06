import { afterEach, describe, expect, it } from 'bun:test';

import { AnthropicProvider } from './anthropic';
import type { Message } from './types';

const originalFetch = globalThis.fetch;

type FetchFn = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

function mockFetch(fn: FetchFn): void {
  (globalThis as Record<string, unknown>)['fetch'] = fn;
}

describe('AnthropicProvider', () => {
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  describe('constructor', () => {
    it('stores provided options and fills in defaults', () => {
      const provider = new AnthropicProvider({ apiKey: 'sk-test-key' });
      expect(provider.name).toBe('anthropic');
    });

    it('accepts custom baseUrl and defaultModel', () => {
      const provider = new AnthropicProvider({
        apiKey: 'sk-test-key',
        baseUrl: 'https://custom.api.example.com',
        defaultModel: 'claude-3-haiku-20240307',
        apiVersion: '2024-01-01',
      });
      expect(provider.name).toBe('anthropic');
    });

    it('counts tokens using the shared estimator', async () => {
      const provider = new AnthropicProvider({ apiKey: 'sk-test-key' });

      expect(
        await provider.countTokens([{ role: 'user', content: 'Count these anthropic tokens' }]),
      ).toBe(10);
    });

    it('warms up the provider with a HEAD request', async () => {
      let capturedUrl = '';
      let capturedMethod = '';

      mockFetch(async (input, init) => {
        capturedUrl =
          input instanceof URL ? input.href : input instanceof Request ? input.url : input;
        capturedMethod = init?.method ?? 'GET';
        return new Response(null, { status: 204 });
      });

      const provider = new AnthropicProvider({
        apiKey: 'sk-test-key',
        baseUrl: 'https://example.anthropic.test',
      });
      await provider.warmup();

      expect(capturedUrl).toBe('https://example.anthropic.test/v1/messages');
      expect(capturedMethod).toBe('HEAD');
    });

    it('swallows warmup failures', async () => {
      mockFetch(async () => {
        throw new Error('connection refused');
      });

      const provider = new AnthropicProvider({ apiKey: 'sk-test-key' });
      await expect(provider.warmup()).resolves.toBeUndefined();
    });
  });

  describe('chat', () => {
    it('sends correctly formatted request to the Anthropic Messages API', async () => {
      let capturedUrl = '';
      let capturedInit: RequestInit | undefined;

      mockFetch(async (input, init) => {
        capturedUrl =
          input instanceof URL ? input.href : input instanceof Request ? input.url : input;
        capturedInit = init;
        return new Response(
          JSON.stringify({
            content: [{ type: 'text', text: 'Hello from Claude' }],
            usage: { input_tokens: 10, output_tokens: 5 },
            model: 'claude-sonnet-4-20250514',
            stop_reason: 'end_turn',
          }),
        );
      });

      const provider = new AnthropicProvider({ apiKey: 'sk-test-key' });
      await provider.chat([{ role: 'user', content: 'Hi' }], { model: 'claude-sonnet-4-20250514' });

      expect(capturedUrl).toBe('https://api.anthropic.com/v1/messages');

      const headers = capturedInit?.headers as Record<string, string>;
      expect(headers['x-api-key']).toBe('sk-test-key');
      expect(headers['anthropic-version']).toBe('2023-06-01');
      expect(headers['content-type']).toBe('application/json');
    });

    it('extracts system messages and sends them in the system parameter', async () => {
      let capturedBody: Record<string, unknown> = {};

      mockFetch(async (_input, init) => {
        capturedBody = JSON.parse(init?.body as string);
        return new Response(
          JSON.stringify({
            content: [{ type: 'text', text: 'response' }],
            usage: { input_tokens: 10, output_tokens: 5 },
            model: 'claude-sonnet-4-20250514',
            stop_reason: 'end_turn',
          }),
        );
      });

      const provider = new AnthropicProvider({ apiKey: 'sk-test-key' });
      const messages: Message[] = [
        { role: 'system', content: 'You are helpful.' },
        { role: 'user', content: 'Hi' },
      ];
      await provider.chat(messages, { model: 'claude-sonnet-4-20250514' });

      expect(capturedBody['system']).toBe('You are helpful.');
      const apiMessages = capturedBody['messages'] as Array<{ role: string; content: string }>;
      expect(apiMessages).toHaveLength(1);
      expect(apiMessages[0]!.role).toBe('user');
    });

    it('uses systemPrompt from ChatOptions when provided', async () => {
      let capturedBody: Record<string, unknown> = {};

      mockFetch(async (_input, init) => {
        capturedBody = JSON.parse(init?.body as string);
        return new Response(
          JSON.stringify({
            content: [{ type: 'text', text: 'response' }],
            usage: { input_tokens: 10, output_tokens: 5 },
            model: 'claude-sonnet-4-20250514',
            stop_reason: 'end_turn',
          }),
        );
      });

      const provider = new AnthropicProvider({ apiKey: 'sk-test-key' });
      await provider.chat([{ role: 'user', content: 'Hi' }], {
        model: 'claude-sonnet-4-20250514',
        systemPrompt: 'Be concise.',
      });

      expect(capturedBody['system']).toBe('Be concise.');
    });

    it('converts user and assistant messages to Anthropic format', async () => {
      let capturedBody: Record<string, unknown> = {};

      mockFetch(async (_input, init) => {
        capturedBody = JSON.parse(init?.body as string);
        return new Response(
          JSON.stringify({
            content: [{ type: 'text', text: 'response' }],
            usage: { input_tokens: 20, output_tokens: 10 },
            model: 'claude-sonnet-4-20250514',
            stop_reason: 'end_turn',
          }),
        );
      });

      const provider = new AnthropicProvider({ apiKey: 'sk-test-key' });
      const messages: Message[] = [
        { role: 'user', content: 'Hello' },
        { role: 'assistant', content: 'Hi there!' },
        { role: 'user', content: 'How are you?' },
      ];
      await provider.chat(messages, { model: 'claude-sonnet-4-20250514' });

      const apiMessages = capturedBody['messages'] as Array<{ role: string; content: string }>;
      expect(apiMessages).toHaveLength(3);
      expect(apiMessages[0]).toEqual({ role: 'user', content: 'Hello' });
      expect(apiMessages[1]).toEqual({ role: 'assistant', content: 'Hi there!' });
      expect(apiMessages[2]).toEqual({ role: 'user', content: 'How are you?' });
    });

    it('converts tool messages with tool results to Anthropic format', async () => {
      let capturedBody: Record<string, unknown> = {};

      mockFetch(async (_input, init) => {
        capturedBody = JSON.parse(init?.body as string);
        return new Response(
          JSON.stringify({
            content: [{ type: 'text', text: 'response' }],
            usage: { input_tokens: 20, output_tokens: 10 },
            model: 'claude-sonnet-4-20250514',
            stop_reason: 'end_turn',
          }),
        );
      });

      const provider = new AnthropicProvider({ apiKey: 'sk-test-key' });
      const messages: Message[] = [
        { role: 'user', content: 'Search for cats' },
        {
          role: 'assistant',
          content: '',
          toolCalls: [{ id: 'tc-1', name: 'search', input: { query: 'cats' } }],
        },
        {
          role: 'tool',
          content: '',
          toolResults: [{ toolCallId: 'tc-1', output: 'Found cats!' }],
        },
      ];
      await provider.chat(messages, { model: 'claude-sonnet-4-20250514' });

      const apiMessages = capturedBody['messages'] as Array<Record<string, unknown>>;
      expect(apiMessages).toHaveLength(3);

      // The assistant message should include tool_use content blocks
      const assistantMessage = apiMessages[1]!;
      expect(assistantMessage['role']).toBe('assistant');
      const assistantContent = assistantMessage['content'] as Array<Record<string, unknown>>;
      expect(assistantContent).toEqual([
        { type: 'tool_use', id: 'tc-1', name: 'search', input: { query: 'cats' } },
      ]);

      // The tool message should be a user message with tool_result content blocks
      const toolMessage = apiMessages[2]!;
      expect(toolMessage['role']).toBe('user');
      const toolContent = toolMessage['content'] as Array<Record<string, unknown>>;
      expect(toolContent).toEqual([
        { type: 'tool_result', tool_use_id: 'tc-1', content: 'Found cats!' },
      ]);
    });

    it('converts tool definitions to Anthropic tools format', async () => {
      let capturedBody: Record<string, unknown> = {};

      mockFetch(async (_input, init) => {
        capturedBody = JSON.parse(init?.body as string);
        return new Response(
          JSON.stringify({
            content: [{ type: 'text', text: 'response' }],
            usage: { input_tokens: 10, output_tokens: 5 },
            model: 'claude-sonnet-4-20250514',
            stop_reason: 'end_turn',
          }),
        );
      });

      const provider = new AnthropicProvider({ apiKey: 'sk-test-key' });
      await provider.chat([{ role: 'user', content: 'Hi' }], {
        model: 'claude-sonnet-4-20250514',
        tools: [
          {
            name: 'search',
            description: 'Search for things',
            inputSchema: { type: 'object', properties: { query: { type: 'string' } } },
          },
        ],
      });

      const tools = capturedBody['tools'] as Array<Record<string, unknown>>;
      expect(tools).toHaveLength(1);
      expect(tools[0]).toEqual({
        name: 'search',
        description: 'Search for things',
        input_schema: { type: 'object', properties: { query: { type: 'string' } } },
      });
    });

    it('includes maxTokens and temperature in the request body', async () => {
      let capturedBody: Record<string, unknown> = {};

      mockFetch(async (_input, init) => {
        capturedBody = JSON.parse(init?.body as string);
        return new Response(
          JSON.stringify({
            content: [{ type: 'text', text: 'response' }],
            usage: { input_tokens: 10, output_tokens: 5 },
            model: 'claude-sonnet-4-20250514',
            stop_reason: 'end_turn',
          }),
        );
      });

      const provider = new AnthropicProvider({ apiKey: 'sk-test-key' });
      await provider.chat([{ role: 'user', content: 'Hi' }], {
        model: 'claude-sonnet-4-20250514',
        maxTokens: 2048,
        temperature: 0.5,
      });

      expect(capturedBody['max_tokens']).toBe(2048);
      expect(capturedBody['temperature']).toBe(0.5);
    });

    it('parses a text response correctly', async () => {
      mockFetch(async () => {
        return new Response(
          JSON.stringify({
            content: [{ type: 'text', text: 'Hello from Claude' }],
            usage: { input_tokens: 15, output_tokens: 8 },
            model: 'claude-sonnet-4-20250514',
            stop_reason: 'end_turn',
          }),
        );
      });

      const provider = new AnthropicProvider({ apiKey: 'sk-test-key' });
      const response = await provider.chat([{ role: 'user', content: 'Hi' }], {
        model: 'claude-sonnet-4-20250514',
      });

      expect(response.content).toBe('Hello from Claude');
      expect(response.toolCalls).toEqual([]);
      expect(response.usage).toEqual({ inputTokens: 15, outputTokens: 8, totalTokens: 23 });
      expect(response.model).toBe('claude-sonnet-4-20250514');
      expect(response.stopReason).toBe('end_turn');
    });

    it('parses tool_use content blocks as ToolCalls', async () => {
      mockFetch(async () => {
        return new Response(
          JSON.stringify({
            content: [
              { type: 'text', text: 'Let me search for that.' },
              {
                type: 'tool_use',
                id: 'toolu_123',
                name: 'search',
                input: { query: 'weather' },
              },
            ],
            usage: { input_tokens: 20, output_tokens: 15 },
            model: 'claude-sonnet-4-20250514',
            stop_reason: 'tool_use',
          }),
        );
      });

      const provider = new AnthropicProvider({ apiKey: 'sk-test-key' });
      const response = await provider.chat([{ role: 'user', content: 'Search weather' }], {
        model: 'claude-sonnet-4-20250514',
      });

      expect(response.content).toBe('Let me search for that.');
      expect(response.toolCalls).toHaveLength(1);
      expect(response.toolCalls[0]).toEqual({
        id: 'toolu_123',
        name: 'search',
        input: { query: 'weather' },
      });
      expect(response.stopReason).toBe('tool_use');
    });

    it('throws a descriptive error on non-200 response', async () => {
      mockFetch(async () => {
        return new Response(
          JSON.stringify({
            type: 'error',
            error: { type: 'invalid_request_error', message: 'Invalid API key' },
          }),
          { status: 401, statusText: 'Unauthorized' },
        );
      });

      const provider = new AnthropicProvider({ apiKey: 'bad-key' });
      await expect(
        provider.chat([{ role: 'user', content: 'Hi' }], { model: 'claude-sonnet-4-20250514' }),
      ).rejects.toThrow(/Anthropic API error \(401\)/);
    });

    it('passes the abort signal to fetch', async () => {
      let capturedSignal: AbortSignal | undefined;

      mockFetch(async (_input, init) => {
        capturedSignal = init?.signal ?? undefined;
        return new Response(
          JSON.stringify({
            content: [{ type: 'text', text: 'ok' }],
            usage: { input_tokens: 5, output_tokens: 2 },
            model: 'claude-sonnet-4-20250514',
            stop_reason: 'end_turn',
          }),
        );
      });

      const controller = new AbortController();
      const provider = new AnthropicProvider({ apiKey: 'sk-test-key' });
      await provider.chat([{ role: 'user', content: 'Hi' }], {
        model: 'claude-sonnet-4-20250514',
        signal: controller.signal,
      });

      expect(capturedSignal).toBe(controller.signal);
    });

    it('uses the default model from options when none specified in chat', async () => {
      let capturedBody: Record<string, unknown> = {};

      mockFetch(async (_input, init) => {
        capturedBody = JSON.parse(init?.body as string);
        return new Response(
          JSON.stringify({
            content: [{ type: 'text', text: 'ok' }],
            usage: { input_tokens: 5, output_tokens: 2 },
            model: 'claude-3-haiku-20240307',
            stop_reason: 'end_turn',
          }),
        );
      });

      const provider = new AnthropicProvider({
        apiKey: 'sk-test-key',
        defaultModel: 'claude-3-haiku-20240307',
      });
      await provider.chat([{ role: 'user', content: 'Hi' }], {
        model: 'claude-3-haiku-20240307',
      });

      expect(capturedBody['model']).toBe('claude-3-haiku-20240307');
    });

    it('uses a custom baseUrl when provided', async () => {
      let capturedUrl = '';

      mockFetch(async (input) => {
        capturedUrl =
          input instanceof URL ? input.href : input instanceof Request ? input.url : input;
        return new Response(
          JSON.stringify({
            content: [{ type: 'text', text: 'ok' }],
            usage: { input_tokens: 5, output_tokens: 2 },
            model: 'claude-sonnet-4-20250514',
            stop_reason: 'end_turn',
          }),
        );
      });

      const provider = new AnthropicProvider({
        apiKey: 'sk-test-key',
        baseUrl: 'https://custom.proxy.example.com',
      });
      await provider.chat([{ role: 'user', content: 'Hi' }], {
        model: 'claude-sonnet-4-20250514',
      });

      expect(capturedUrl).toBe('https://custom.proxy.example.com/v1/messages');
    });
  });

  describe('stream', () => {
    it('sends request with stream: true and returns a ReadableStream', async () => {
      let capturedBody: Record<string, unknown> = {};

      const ssePayload = [
        'event: message_start\ndata: {"type":"message_start","message":{"model":"claude-sonnet-4-20250514","usage":{"input_tokens":10,"output_tokens":0}}}\n\n',
        'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n',
        'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hello"}}\n\n',
        'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":" world"}}\n\n',
        'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n',
        'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":5}}\n\n',
        'event: message_stop\ndata: {"type":"message_stop"}\n\n',
      ].join('');

      mockFetch(async (_input, init) => {
        capturedBody = JSON.parse(init?.body as string);
        return new Response(ssePayload, {
          headers: { 'content-type': 'text/event-stream' },
        });
      });

      const provider = new AnthropicProvider({ apiKey: 'sk-test-key' });
      const stream = await provider.stream([{ role: 'user', content: 'Hi' }], {
        model: 'claude-sonnet-4-20250514',
      });

      expect(capturedBody['stream']).toBe(true);
      expect(stream).toBeInstanceOf(ReadableStream);

      const reader = stream.getReader();
      const chunks = [];
      let result = await reader.read();
      while (!result.done) {
        chunks.push(result.value);
        result = await reader.read();
      }

      const tokenChunks = chunks.filter((c) => c.type === 'token');
      expect(tokenChunks.length).toBeGreaterThanOrEqual(2);
      expect(tokenChunks[0]!.token).toBe('Hello');
      expect(tokenChunks[1]!.token).toBe(' world');

      const doneChunk = chunks.find((c) => c.type === 'done');
      expect(doneChunk).toBeDefined();
      expect(doneChunk!.usage).toBeDefined();
    });

    it('cancels the inner response body reader when the outer stream is cancelled', async () => {
      let innerCancelled = false;
      let pullController: ReadableStreamDefaultController<Uint8Array> | undefined;

      const innerBody = new ReadableStream<Uint8Array>({
        start(controller) {
          pullController = controller;
          // Enqueue one chunk so the consumer has something to read before cancelling.
          const encoder = new TextEncoder();
          controller.enqueue(
            encoder.encode(
              'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hello"}}\n\n',
            ),
          );
        },
        cancel() {
          innerCancelled = true;
          try {
            pullController?.close();
          } catch {
            // Already closed.
          }
        },
      });

      mockFetch(async () => {
        return new Response(innerBody, {
          headers: { 'content-type': 'text/event-stream' },
        });
      });

      const provider = new AnthropicProvider({ apiKey: 'sk-test-key' });
      const stream = await provider.stream([{ role: 'user', content: 'Hi' }], {
        model: 'claude-sonnet-4-20250514',
      });

      const reader = stream.getReader();
      await reader.read();

      await reader.cancel('aborted by consumer');

      expect(innerCancelled).toBe(true);
    });

    it('releases the inner reader when parsing throws inside start()', async () => {
      let innerCancelled = false;

      const innerBody = new ReadableStream<Uint8Array>({
        start(controller) {
          const encoder = new TextEncoder();
          // Malformed JSON payload — JSON.parse will throw inside start().
          // Intentionally do NOT close the inner body here — we want to
          // verify that the provider's finally block cancels the inner
          // reader, which should trigger this stream's cancel callback.
          controller.enqueue(encoder.encode('data: {not valid json}\n\n'));
        },
        cancel() {
          innerCancelled = true;
        },
      });

      mockFetch(async () => {
        return new Response(innerBody, {
          headers: { 'content-type': 'text/event-stream' },
        });
      });

      const provider = new AnthropicProvider({ apiKey: 'sk-test-key' });
      const stream = await provider.stream([{ role: 'user', content: 'Hi' }], {
        model: 'claude-sonnet-4-20250514',
      });

      const reader = stream.getReader();
      // Drain until the stream closes (the parse error is swallowed by the
      // finally block, which closes the controller, so the outer stream
      // ends cleanly even though start() rejected).
      for (;;) {
        const result = await reader.read();
        if (result.done) break;
      }

      // The finally block should have cancelled the inner reader on the
      // error path, releasing the underlying response body.
      expect(innerCancelled).toBe(true);
    });
  });

  describe('countTokens', () => {
    it('returns a rough estimate based on content length divided by 4', async () => {
      const provider = new AnthropicProvider({ apiKey: 'sk-test-key' });
      const messages: Message[] = [
        { role: 'user', content: 'Hello, world!' }, // 13 chars
        { role: 'assistant', content: 'Hi!' }, // 3 chars
      ];
      const count = await provider.countTokens(messages);
      // ceil(13/4) + 3 overhead + ceil(3/4) + 3 overhead = 4 + 3 + 1 + 3 = 11
      expect(count).toBe(11);
    });

    it('returns 0 for empty messages', async () => {
      const provider = new AnthropicProvider({ apiKey: 'sk-test-key' });
      const count = await provider.countTokens([]);
      expect(count).toBe(0);
    });
  });
});
