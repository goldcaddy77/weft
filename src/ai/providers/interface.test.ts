import { describe, expect, it } from 'bun:test';

import type { ChatOptions, LLMProvider } from './interface';
import type { ChatResponse, Message, StreamChunk } from './types';

describe('LLMProvider', () => {
  it('can be implemented as a mock provider', () => {
    const mockProvider: LLMProvider = {
      name: 'mock-provider',

      async chat(_messages: Message[], _options: ChatOptions): Promise<ChatResponse> {
        return {
          content: 'mock response',
          toolCalls: [],
          usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
          model: 'mock-model',
          stopReason: 'end_turn',
        };
      },

      async stream(
        _messages: Message[],
        _options: ChatOptions,
      ): Promise<ReadableStream<StreamChunk>> {
        return new ReadableStream<StreamChunk>({
          start(controller) {
            controller.enqueue({ type: 'token', token: 'hello' });
            controller.enqueue({
              type: 'done',
              usage: { inputTokens: 5, outputTokens: 2, totalTokens: 7 },
            });
            controller.close();
          },
        });
      },

      async countTokens(_messages: Message[]): Promise<number> {
        return 42;
      },
    };

    expect(mockProvider.name).toBe('mock-provider');
  });

  it('mock provider chat returns expected response', async () => {
    const mockProvider: LLMProvider = {
      name: 'test',
      async chat(): Promise<ChatResponse> {
        return {
          content: 'test response',
          toolCalls: [{ id: 'tc-1', name: 'search', input: { query: 'test' } }],
          usage: { inputTokens: 20, outputTokens: 10, totalTokens: 30 },
          model: 'test-model',
          stopReason: 'tool_use',
        };
      },
      async stream(): Promise<ReadableStream<StreamChunk>> {
        return new ReadableStream();
      },
      async countTokens(): Promise<number> {
        return 0;
      },
    };

    const response = await mockProvider.chat([{ role: 'user', content: 'Hello' }], {
      model: 'test-model',
    });

    expect(response.content).toBe('test response');
    expect(response.toolCalls).toHaveLength(1);
    expect(response.stopReason).toBe('tool_use');
  });

  it('mock provider stream returns a readable stream', async () => {
    const chunks: StreamChunk[] = [];
    const mockProvider: LLMProvider = {
      name: 'stream-test',
      async chat(): Promise<ChatResponse> {
        return {
          content: '',
          toolCalls: [],
          usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
          model: 'test',
          stopReason: 'end_turn',
        };
      },
      async stream(): Promise<ReadableStream<StreamChunk>> {
        return new ReadableStream<StreamChunk>({
          start(controller) {
            controller.enqueue({ type: 'token', token: 'Hi' });
            controller.enqueue({ type: 'token', token: ' there' });
            controller.enqueue({
              type: 'done',
              usage: { inputTokens: 3, outputTokens: 2, totalTokens: 5 },
            });
            controller.close();
          },
        });
      },
      async countTokens(): Promise<number> {
        return 0;
      },
    };

    const stream = await mockProvider.stream([{ role: 'user', content: 'Hi' }], {
      model: 'test-model',
    });
    const reader = stream.getReader();

    let result = await reader.read();
    while (!result.done) {
      chunks.push(result.value);
      result = await reader.read();
    }

    expect(chunks).toHaveLength(3);
    expect(chunks[0].type).toBe('token');
    expect(chunks[0].token).toBe('Hi');
    expect(chunks[2].type).toBe('done');
  });

  it('mock provider countTokens returns a number', async () => {
    const mockProvider: LLMProvider = {
      name: 'count-test',
      async chat(): Promise<ChatResponse> {
        return {
          content: '',
          toolCalls: [],
          usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
          model: 'test',
          stopReason: 'end_turn',
        };
      },
      async stream(): Promise<ReadableStream<StreamChunk>> {
        return new ReadableStream();
      },
      async countTokens(messages: Message[]): Promise<number> {
        return messages.reduce((sum, m) => sum + m.content.length, 0);
      },
    };

    const count = await mockProvider.countTokens([
      { role: 'user', content: 'Hello' },
      { role: 'assistant', content: 'Hi' },
    ]);

    expect(count).toBe(7);
  });
});

describe('ChatOptions', () => {
  it('requires model and allows optional fields', () => {
    const minimal: ChatOptions = { model: 'claude-3-opus' };
    expect(minimal.model).toBe('claude-3-opus');

    const full: ChatOptions = {
      model: 'claude-3-opus',
      tools: [
        {
          name: 'search',
          description: 'Search things',
          inputSchema: { type: 'object' },
        },
      ],
      maxTokens: 4096,
      temperature: 0.7,
      signal: new AbortController().signal,
      systemPrompt: 'You are a helpful assistant.',
    };
    expect(full.tools).toHaveLength(1);
    expect(full.maxTokens).toBe(4096);
    expect(full.temperature).toBe(0.7);
    expect(full.systemPrompt).toBe('You are a helpful assistant.');
  });
});
