import type { ChatOptions, LLMProvider } from './interface';
import type { ChatResponse, Message, StreamChunk, ToolCall, ToolDefinition } from './types';

import { estimateTokens } from '../token-counting.ts';

export interface AnthropicProviderOptions {
  apiKey: string;
  baseUrl?: string;
  defaultModel?: string;
  apiVersion?: string;
}

interface ResolvedAnthropicProviderOptions {
  apiKey: string;
  baseUrl: string;
  defaultModel: string;
  apiVersion: string;
}

export class AnthropicProvider implements LLMProvider {
  readonly name = 'anthropic';
  #options: ResolvedAnthropicProviderOptions;

  constructor(options: AnthropicProviderOptions) {
    this.#options = {
      apiKey: options.apiKey,
      baseUrl: options.baseUrl ?? 'https://api.anthropic.com',
      defaultModel: options.defaultModel ?? 'claude-sonnet-4-20250514',
      apiVersion: options.apiVersion ?? '2023-06-01',
    };
  }

  async chat(messages: Message[], options: ChatOptions): Promise<ChatResponse> {
    const body = this.#buildRequestBody(messages, options);

    const init: RequestInit = {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': this.#options.apiKey,
        'anthropic-version': this.#options.apiVersion,
      },
      body: JSON.stringify(body),
    };

    if (options.signal) {
      init.signal = options.signal;
    }

    const response = await fetch(`${this.#options.baseUrl}/v1/messages`, init);

    if (!response.ok) {
      const errorBody = await response.text();
      throw new Error(`Anthropic API error (${response.status}): ${errorBody}`);
    }

    const data = (await response.json()) as Record<string, unknown>;
    return this.#parseResponse(data);
  }

  async stream(messages: Message[], options: ChatOptions): Promise<ReadableStream<StreamChunk>> {
    const body = this.#buildRequestBody(messages, options);
    body['stream'] = true;

    const init: RequestInit = {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': this.#options.apiKey,
        'anthropic-version': this.#options.apiVersion,
      },
      body: JSON.stringify(body),
    };

    if (options.signal) {
      init.signal = options.signal;
    }

    const response = await fetch(`${this.#options.baseUrl}/v1/messages`, init);

    if (!response.ok) {
      const errorBody = await response.text();
      throw new Error(`Anthropic API error (${response.status}): ${errorBody}`);
    }

    const rawBody = response.body;
    if (!rawBody) {
      throw new Error('Anthropic API returned no response body for stream');
    }

    let inputTokens = 0;
    let outputTokens = 0;

    const reader = rawBody.getReader();

    return new ReadableStream<StreamChunk>({
      async start(controller) {
        const decoder = new TextDecoder();
        let buffer = '';

        try {
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;

            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split('\n');
            buffer = lines.pop() ?? '';

            for (const line of lines) {
              if (!line.startsWith('data: ')) continue;
              const jsonString = line.slice(6).trim();
              if (jsonString === '' || jsonString === '[DONE]') continue;

              const event = JSON.parse(jsonString) as Record<string, unknown>;
              const eventType = event['type'] as string;

              if (eventType === 'message_start') {
                const message = event['message'] as Record<string, unknown>;
                const usage = message['usage'] as Record<string, number>;
                inputTokens = usage['input_tokens'] ?? 0;
              } else if (eventType === 'content_block_delta') {
                const delta = event['delta'] as Record<string, unknown>;
                if (delta['type'] === 'text_delta') {
                  controller.enqueue({ type: 'token', token: delta['text'] as string });
                }
              } else if (eventType === 'message_delta') {
                const usage = event['usage'] as Record<string, number> | undefined;
                if (usage) {
                  outputTokens = usage['output_tokens'] ?? 0;
                }
              } else if (eventType === 'message_stop') {
                controller.enqueue({
                  type: 'done',
                  usage: {
                    inputTokens,
                    outputTokens,
                    totalTokens: inputTokens + outputTokens,
                  },
                });
              }
            }
          }
        } finally {
          // Release the lock on the underlying response body so it can be
          // garbage-collected. Errors are ignored because the reader may
          // already be in a terminal state when we get here.
          reader.cancel().catch(() => {});
          controller.close();
        }
      },
      cancel(reason) {
        // Consumer aborted (e.g. budget exceeded, workflow cancellation).
        // Propagate the cancel to the inner reader so the fetch response
        // body is released instead of staying locked forever.
        reader.cancel(reason).catch(() => {});
      },
    });
  }

  async countTokens(messages: Message[]): Promise<number> {
    return estimateTokens(messages);
  }

  async warmup(): Promise<void> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 3000);
    try {
      await fetch(`${this.#options.baseUrl}/v1/messages`, {
        method: 'HEAD',
        signal: controller.signal,
      });
    } catch {
      // Best-effort: silently swallow connection errors and timeouts.
    } finally {
      clearTimeout(timeout);
    }
  }

  #buildRequestBody(messages: Message[], options: ChatOptions): Record<string, unknown> {
    const body: Record<string, unknown> = {
      model: options.model,
      max_tokens: options.maxTokens ?? 4096,
    };

    if (options.temperature !== undefined) {
      body['temperature'] = options.temperature;
    }

    // Extract system message from messages or use systemPrompt from options
    const systemMessages = messages.filter((message) => message.role === 'system');
    const nonSystemMessages = messages.filter((message) => message.role !== 'system');

    if (options.systemPrompt) {
      body['system'] = options.systemPrompt;
    } else if (systemMessages.length > 0) {
      body['system'] = systemMessages.map((message) => message.content).join('\n\n');
    }

    body['messages'] = nonSystemMessages.map((message) => this.#convertMessage(message));

    if (options.tools && options.tools.length > 0) {
      body['tools'] = options.tools.map((tool) => this.#convertToolDefinition(tool));
    }

    return body;
  }

  #convertMessage(message: Message): Record<string, unknown> {
    // Assistant messages with tool calls use content blocks
    if (message.role === 'assistant' && message.toolCalls && message.toolCalls.length > 0) {
      const contentBlocks = message.toolCalls.map((toolCall) => ({
        type: 'tool_use',
        id: toolCall.id,
        name: toolCall.name,
        input: toolCall.input,
      }));
      return { role: 'assistant', content: contentBlocks };
    }

    // Tool result messages become user messages with tool_result content blocks
    if (message.role === 'tool' && message.toolResults && message.toolResults.length > 0) {
      const contentBlocks = message.toolResults.map((result) => ({
        type: 'tool_result',
        tool_use_id: result.toolCallId,
        content: result.output,
      }));
      return { role: 'user', content: contentBlocks };
    }

    return { role: message.role, content: message.content };
  }

  #convertToolDefinition(tool: ToolDefinition): Record<string, unknown> {
    return {
      name: tool.name,
      description: tool.description,
      input_schema: tool.inputSchema,
    };
  }

  #parseResponse(data: Record<string, unknown>): ChatResponse {
    const contentBlocks = data['content'] as Array<Record<string, unknown>>;
    const usage = data['usage'] as Record<string, number>;
    const model = data['model'] as string;
    const stopReason = data['stop_reason'] as string;

    let textContent = '';
    let reasoningTrace = '';
    const toolCalls: ToolCall[] = [];

    for (const block of contentBlocks) {
      if (block['type'] === 'text') {
        textContent += block['text'] as string;
      } else if (block['type'] === 'thinking') {
        reasoningTrace += block['thinking'] as string;
      } else if (block['type'] === 'tool_use') {
        toolCalls.push({
          id: block['id'] as string,
          name: block['name'] as string,
          input: block['input'],
        });
      }
    }

    const inputTokens = usage['input_tokens'] ?? 0;
    const outputTokens = usage['output_tokens'] ?? 0;

    const response: ChatResponse = {
      content: textContent,
      toolCalls,
      usage: {
        inputTokens,
        outputTokens,
        totalTokens: inputTokens + outputTokens,
      },
      model,
      stopReason: this.#mapStopReason(stopReason),
    };

    if (reasoningTrace) {
      response.reasoningTrace = reasoningTrace;
    }

    return response;
  }

  #mapStopReason(stopReason: string): 'end_turn' | 'tool_use' | 'max_tokens' | 'stop_sequence' {
    switch (stopReason) {
      case 'end_turn':
        return 'end_turn';
      case 'tool_use':
        return 'tool_use';
      case 'max_tokens':
        return 'max_tokens';
      case 'stop_sequence':
        return 'stop_sequence';
      default:
        return 'end_turn';
    }
  }
}
