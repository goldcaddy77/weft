import { afterEach, describe, expect, it } from 'bun:test';

import { OpenAIProvider } from './openai';
import type { Message } from './types';

const originalFetch = globalThis.fetch;

describe('OpenAIProvider', () => {
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  describe('constructor', () => {
    it('stores provided options and fills in defaults', () => {
      const provider = new OpenAIProvider({ apiKey: 'sk-test-key' });
      expect(provider.name).toBe('openai');
    });

    it('accepts custom baseUrl, defaultModel, and organization', () => {
      const provider = new OpenAIProvider({
        apiKey: 'sk-test-key',
        baseUrl: 'https://custom.openai.example.com/v1',
        defaultModel: 'gpt-4-turbo',
        organization: 'org-abc123',
      });
      expect(provider.name).toBe('openai');
    });
  });

  describe('chat', () => {
    it('sends correctly formatted request to the OpenAI Chat Completions API', async () => {
      let capturedUrl = '';
      let capturedInit: RequestInit | undefined;

      globalThis.fetch = async (input: string | URL | Request, init?: RequestInit) => {
        capturedUrl =
          input instanceof URL ? input.href : input instanceof Request ? input.url : input;
        capturedInit = init;
        return new Response(
          JSON.stringify({
            choices: [
              {
                message: { role: 'assistant', content: 'Hello!' },
                finish_reason: 'stop',
              },
            ],
            usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
            model: 'gpt-4o',
          }),
        );
      };

      const provider = new OpenAIProvider({ apiKey: 'sk-test-key' });
      await provider.chat([{ role: 'user', content: 'Hi' }], { model: 'gpt-4o' });

      expect(capturedUrl).toBe('https://api.openai.com/v1/chat/completions');

      const headers = capturedInit?.headers as Record<string, string>;
      expect(headers['authorization']).toBe('Bearer sk-test-key');
      expect(headers['content-type']).toBe('application/json');
    });

    it('includes the organization header when provided', async () => {
      let capturedInit: RequestInit | undefined;

      globalThis.fetch = async (_input: RequestInfo | URL, init?: RequestInit) => {
        capturedInit = init;
        return new Response(
          JSON.stringify({
            choices: [
              {
                message: { role: 'assistant', content: 'Hello!' },
                finish_reason: 'stop',
              },
            ],
            usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
            model: 'gpt-4o',
          }),
        );
      };

      const provider = new OpenAIProvider({
        apiKey: 'sk-test-key',
        organization: 'org-abc123',
      });
      await provider.chat([{ role: 'user', content: 'Hi' }], { model: 'gpt-4o' });

      const headers = capturedInit?.headers as Record<string, string>;
      expect(headers['openai-organization']).toBe('org-abc123');
    });

    it('converts messages to OpenAI format with role and content', async () => {
      let capturedBody: Record<string, unknown> = {};

      globalThis.fetch = async (_input: RequestInfo | URL, init?: RequestInit) => {
        capturedBody = JSON.parse(init?.body as string);
        return new Response(
          JSON.stringify({
            choices: [
              {
                message: { role: 'assistant', content: 'response' },
                finish_reason: 'stop',
              },
            ],
            usage: { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30 },
            model: 'gpt-4o',
          }),
        );
      };

      const provider = new OpenAIProvider({ apiKey: 'sk-test-key' });
      const messages: Message[] = [
        { role: 'system', content: 'You are helpful.' },
        { role: 'user', content: 'Hello' },
        { role: 'assistant', content: 'Hi!' },
      ];
      await provider.chat(messages, { model: 'gpt-4o' });

      const apiMessages = capturedBody.messages as Array<{ role: string; content: string }>;
      expect(apiMessages).toHaveLength(3);
      expect(apiMessages[0]).toEqual({ role: 'system', content: 'You are helpful.' });
      expect(apiMessages[1]).toEqual({ role: 'user', content: 'Hello' });
      expect(apiMessages[2]).toEqual({ role: 'assistant', content: 'Hi!' });
    });

    it('prepends systemPrompt from ChatOptions as a system message', async () => {
      let capturedBody: Record<string, unknown> = {};

      globalThis.fetch = async (_input: RequestInfo | URL, init?: RequestInit) => {
        capturedBody = JSON.parse(init?.body as string);
        return new Response(
          JSON.stringify({
            choices: [
              {
                message: { role: 'assistant', content: 'response' },
                finish_reason: 'stop',
              },
            ],
            usage: { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30 },
            model: 'gpt-4o',
          }),
        );
      };

      const provider = new OpenAIProvider({ apiKey: 'sk-test-key' });
      await provider.chat([{ role: 'user', content: 'Hi' }], {
        model: 'gpt-4o',
        systemPrompt: 'Be concise.',
      });

      const apiMessages = capturedBody.messages as Array<{ role: string; content: string }>;
      expect(apiMessages[0]).toEqual({ role: 'system', content: 'Be concise.' });
      expect(apiMessages[1]).toEqual({ role: 'user', content: 'Hi' });
    });

    it('converts tool definitions to OpenAI function tools format', async () => {
      let capturedBody: Record<string, unknown> = {};

      globalThis.fetch = async (_input: RequestInfo | URL, init?: RequestInit) => {
        capturedBody = JSON.parse(init?.body as string);
        return new Response(
          JSON.stringify({
            choices: [
              {
                message: { role: 'assistant', content: 'response' },
                finish_reason: 'stop',
              },
            ],
            usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
            model: 'gpt-4o',
          }),
        );
      };

      const provider = new OpenAIProvider({ apiKey: 'sk-test-key' });
      await provider.chat([{ role: 'user', content: 'Hi' }], {
        model: 'gpt-4o',
        tools: [
          {
            name: 'search',
            description: 'Search for things',
            inputSchema: { type: 'object', properties: { query: { type: 'string' } } },
          },
        ],
      });

      const tools = capturedBody.tools as Array<Record<string, unknown>>;
      expect(tools).toHaveLength(1);
      expect(tools[0]).toEqual({
        type: 'function',
        function: {
          name: 'search',
          description: 'Search for things',
          parameters: { type: 'object', properties: { query: { type: 'string' } } },
        },
      });
    });

    it('converts assistant messages with tool calls to OpenAI format', async () => {
      let capturedBody: Record<string, unknown> = {};

      globalThis.fetch = async (_input: RequestInfo | URL, init?: RequestInit) => {
        capturedBody = JSON.parse(init?.body as string);
        return new Response(
          JSON.stringify({
            choices: [
              {
                message: { role: 'assistant', content: 'response' },
                finish_reason: 'stop',
              },
            ],
            usage: { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30 },
            model: 'gpt-4o',
          }),
        );
      };

      const provider = new OpenAIProvider({ apiKey: 'sk-test-key' });
      const messages: Message[] = [
        { role: 'user', content: 'Search for cats' },
        {
          role: 'assistant',
          content: '',
          toolCalls: [{ id: 'call_123', name: 'search', input: { query: 'cats' } }],
        },
        {
          role: 'tool',
          content: '',
          toolResults: [{ toolCallId: 'call_123', output: 'Found cats!' }],
        },
      ];
      await provider.chat(messages, { model: 'gpt-4o' });

      const apiMessages = capturedBody.messages as Array<Record<string, unknown>>;
      expect(apiMessages).toHaveLength(3);

      // Assistant message with tool_calls
      const assistantMessage = apiMessages[1]!;
      expect(assistantMessage.role).toBe('assistant');
      const toolCalls = assistantMessage.tool_calls as Array<Record<string, unknown>>;
      expect(toolCalls).toHaveLength(1);
      expect(toolCalls[0]).toEqual({
        id: 'call_123',
        type: 'function',
        function: { name: 'search', arguments: '{"query":"cats"}' },
      });

      // Tool result message
      const toolMessage = apiMessages[2]!;
      expect(toolMessage.role).toBe('tool');
      expect(toolMessage.tool_call_id).toBe('call_123');
      expect(toolMessage.content).toBe('Found cats!');
    });

    it('includes maxTokens and temperature in request body', async () => {
      let capturedBody: Record<string, unknown> = {};

      globalThis.fetch = async (_input: RequestInfo | URL, init?: RequestInit) => {
        capturedBody = JSON.parse(init?.body as string);
        return new Response(
          JSON.stringify({
            choices: [
              {
                message: { role: 'assistant', content: 'response' },
                finish_reason: 'stop',
              },
            ],
            usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
            model: 'gpt-4o',
          }),
        );
      };

      const provider = new OpenAIProvider({ apiKey: 'sk-test-key' });
      await provider.chat([{ role: 'user', content: 'Hi' }], {
        model: 'gpt-4o',
        maxTokens: 4096,
        temperature: 0.7,
      });

      expect(capturedBody.max_tokens).toBe(4096);
      expect(capturedBody.temperature).toBe(0.7);
    });

    it('parses a text response correctly', async () => {
      globalThis.fetch = async () => {
        return new Response(
          JSON.stringify({
            choices: [
              {
                message: { role: 'assistant', content: 'Hello from GPT!' },
                finish_reason: 'stop',
              },
            ],
            usage: { prompt_tokens: 12, completion_tokens: 7, total_tokens: 19 },
            model: 'gpt-4o',
          }),
        );
      };

      const provider = new OpenAIProvider({ apiKey: 'sk-test-key' });
      const response = await provider.chat([{ role: 'user', content: 'Hi' }], { model: 'gpt-4o' });

      expect(response.content).toBe('Hello from GPT!');
      expect(response.toolCalls).toEqual([]);
      expect(response.usage).toEqual({ inputTokens: 12, outputTokens: 7, totalTokens: 19 });
      expect(response.model).toBe('gpt-4o');
      expect(response.stopReason).toBe('end_turn');
    });

    it('parses tool call response correctly', async () => {
      globalThis.fetch = async () => {
        return new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  role: 'assistant',
                  content: null,
                  tool_calls: [
                    {
                      id: 'call_abc',
                      type: 'function',
                      function: { name: 'search', arguments: '{"query":"weather"}' },
                    },
                  ],
                },
                finish_reason: 'tool_calls',
              },
            ],
            usage: { prompt_tokens: 20, completion_tokens: 15, total_tokens: 35 },
            model: 'gpt-4o',
          }),
        );
      };

      const provider = new OpenAIProvider({ apiKey: 'sk-test-key' });
      const response = await provider.chat([{ role: 'user', content: 'Search weather' }], {
        model: 'gpt-4o',
      });

      expect(response.content).toBe('');
      expect(response.toolCalls).toHaveLength(1);
      expect(response.toolCalls[0]).toEqual({
        id: 'call_abc',
        name: 'search',
        input: { query: 'weather' },
      });
      expect(response.stopReason).toBe('tool_use');
    });

    it('throws a descriptive error on non-200 response', async () => {
      globalThis.fetch = async () => {
        return new Response(
          JSON.stringify({
            error: { message: 'Invalid API key', type: 'invalid_request_error' },
          }),
          { status: 401, statusText: 'Unauthorized' },
        );
      };

      const provider = new OpenAIProvider({ apiKey: 'bad-key' });
      await expect(
        provider.chat([{ role: 'user', content: 'Hi' }], { model: 'gpt-4o' }),
      ).rejects.toThrow(/OpenAI API error \(401\)/);
    });

    it('passes the abort signal to fetch', async () => {
      let capturedSignal: AbortSignal | undefined;

      globalThis.fetch = async (_input: RequestInfo | URL, init?: RequestInit) => {
        capturedSignal = init?.signal ?? undefined;
        return new Response(
          JSON.stringify({
            choices: [
              {
                message: { role: 'assistant', content: 'ok' },
                finish_reason: 'stop',
              },
            ],
            usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 },
            model: 'gpt-4o',
          }),
        );
      };

      const controller = new AbortController();
      const provider = new OpenAIProvider({ apiKey: 'sk-test-key' });
      await provider.chat([{ role: 'user', content: 'Hi' }], {
        model: 'gpt-4o',
        signal: controller.signal,
      });

      expect(capturedSignal).toBe(controller.signal);
    });

    it('uses a custom baseUrl when provided', async () => {
      let capturedUrl = '';

      globalThis.fetch = async (input: string | URL | Request) => {
        capturedUrl =
          input instanceof URL ? input.href : input instanceof Request ? input.url : input;
        return new Response(
          JSON.stringify({
            choices: [
              {
                message: { role: 'assistant', content: 'ok' },
                finish_reason: 'stop',
              },
            ],
            usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 },
            model: 'gpt-4o',
          }),
        );
      };

      const provider = new OpenAIProvider({
        apiKey: 'sk-test-key',
        baseUrl: 'https://custom.openai.example.com/v1',
      });
      await provider.chat([{ role: 'user', content: 'Hi' }], { model: 'gpt-4o' });

      expect(capturedUrl).toBe('https://custom.openai.example.com/v1/chat/completions');
    });
  });

  describe('stream', () => {
    it('sends request with stream: true and returns a ReadableStream', async () => {
      let capturedBody: Record<string, unknown> = {};

      const ssePayload = [
        'data: {"id":"chatcmpl-1","object":"chat.completion.chunk","model":"gpt-4o","choices":[{"index":0,"delta":{"role":"assistant","content":""},"finish_reason":null}]}\n\n',
        'data: {"id":"chatcmpl-1","object":"chat.completion.chunk","model":"gpt-4o","choices":[{"index":0,"delta":{"content":"Hello"},"finish_reason":null}]}\n\n',
        'data: {"id":"chatcmpl-1","object":"chat.completion.chunk","model":"gpt-4o","choices":[{"index":0,"delta":{"content":" world"},"finish_reason":null}]}\n\n',
        'data: {"id":"chatcmpl-1","object":"chat.completion.chunk","model":"gpt-4o","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":10,"completion_tokens":5,"total_tokens":15}}\n\n',
        'data: [DONE]\n\n',
      ].join('');

      globalThis.fetch = async (_input: RequestInfo | URL, init?: RequestInit) => {
        capturedBody = JSON.parse(init?.body as string);
        return new Response(ssePayload, {
          headers: { 'content-type': 'text/event-stream' },
        });
      };

      const provider = new OpenAIProvider({ apiKey: 'sk-test-key' });
      const stream = await provider.stream([{ role: 'user', content: 'Hi' }], {
        model: 'gpt-4o',
      });

      expect(capturedBody.stream).toBe(true);
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
    });
  });

  describe('countTokens', () => {
    it('returns a rough estimate based on content length divided by 4', async () => {
      const provider = new OpenAIProvider({ apiKey: 'sk-test-key' });
      const messages: Message[] = [
        { role: 'user', content: 'Hello, world!' }, // 13 chars
        { role: 'assistant', content: 'Hi!' }, // 3 chars
      ];
      const count = await provider.countTokens(messages);
      // (13 + 3) / 4 = 4
      expect(count).toBe(4);
    });

    it('returns 0 for empty messages', async () => {
      const provider = new OpenAIProvider({ apiKey: 'sk-test-key' });
      const count = await provider.countTokens([]);
      expect(count).toBe(0);
    });
  });
});
