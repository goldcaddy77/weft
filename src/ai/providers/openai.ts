import type { ChatOptions, LLMProvider } from './interface';
import type { ChatResponse, Message, StreamChunk, ToolCall, ToolDefinition } from './types';

import { estimateTokens } from '../token-counting.ts';

export interface OpenAIProviderOptions {
  apiKey: string;
  baseUrl?: string;
  defaultModel?: string;
  organization?: string;
}

interface ResolvedOpenAIProviderOptions {
  apiKey: string;
  baseUrl: string;
  defaultModel: string;
  organization: string;
}

export class OpenAIProvider implements LLMProvider {
  readonly name = 'openai';
  #options: ResolvedOpenAIProviderOptions;

  constructor(options: OpenAIProviderOptions) {
    this.#options = {
      apiKey: options.apiKey,
      baseUrl: options.baseUrl ?? 'https://api.openai.com/v1',
      defaultModel: options.defaultModel ?? 'gpt-4o',
      organization: options.organization ?? '',
    };
  }

  async chat(messages: Message[], options: ChatOptions): Promise<ChatResponse> {
    const body = this.#buildRequestBody(messages, options);

    const init: RequestInit = {
      method: 'POST',
      headers: this.#buildHeaders(),
      body: JSON.stringify(body),
    };

    if (options.signal) {
      init.signal = options.signal;
    }

    const response = await fetch(`${this.#options.baseUrl}/chat/completions`, init);

    if (!response.ok) {
      const errorBody = await response.text();
      throw new Error(`OpenAI API error (${response.status}): ${errorBody}`);
    }

    const data = (await response.json()) as Record<string, unknown>;
    return this.#parseResponse(data);
  }

  async stream(messages: Message[], options: ChatOptions): Promise<ReadableStream<StreamChunk>> {
    const body = this.#buildRequestBody(messages, options);
    body['stream'] = true;
    body['stream_options'] = { include_usage: true };

    const init: RequestInit = {
      method: 'POST',
      headers: this.#buildHeaders(),
      body: JSON.stringify(body),
    };

    if (options.signal) {
      init.signal = options.signal;
    }

    const response = await fetch(`${this.#options.baseUrl}/chat/completions`, init);

    if (!response.ok) {
      const errorBody = await response.text();
      throw new Error(`OpenAI API error (${response.status}): ${errorBody}`);
    }

    const rawBody = response.body;
    if (!rawBody) {
      throw new Error('OpenAI API returned no response body for stream');
    }

    return new ReadableStream<StreamChunk>({
      async start(controller) {
        const reader = rawBody.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        let lastUsage:
          | { inputTokens: number; outputTokens: number; totalTokens: number }
          | undefined;

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
              if (jsonString === '[DONE]') {
                const doneChunk: StreamChunk = { type: 'done' };
                if (lastUsage) {
                  doneChunk.usage = lastUsage;
                }
                controller.enqueue(doneChunk);
                continue;
              }
              if (jsonString === '') continue;

              const event = JSON.parse(jsonString) as Record<string, unknown>;
              const choices = event['choices'] as Array<Record<string, unknown>> | undefined;

              if (choices && choices.length > 0) {
                const choice = choices[0]!;
                const delta = choice['delta'] as Record<string, unknown> | undefined;

                if (delta) {
                  const content = delta['content'] as string | undefined;
                  if (content) {
                    controller.enqueue({ type: 'token', token: content });
                  }
                }
              }

              const usage = event['usage'] as Record<string, number> | undefined;
              if (usage) {
                lastUsage = {
                  inputTokens: usage['prompt_tokens'] ?? 0,
                  outputTokens: usage['completion_tokens'] ?? 0,
                  totalTokens: usage['total_tokens'] ?? 0,
                };
              }
            }
          }
        } finally {
          controller.close();
        }
      },
    });
  }

  async countTokens(messages: Message[]): Promise<number> {
    return estimateTokens(messages);
  }

  async warmup(): Promise<void> {
    const controller = new AbortController();
    const timeout = setTimeout(controller.abort.bind(controller), 3000);
    try {
      await fetch(`${this.#options.baseUrl}/chat/completions`, {
        method: 'HEAD',
        signal: controller.signal,
      });
    } catch {
      // Best-effort: silently swallow connection errors and timeouts.
    } finally {
      clearTimeout(timeout);
    }
  }

  #buildHeaders(): Record<string, string> {
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      authorization: `Bearer ${this.#options.apiKey}`,
    };

    if (this.#options.organization) {
      headers['openai-organization'] = this.#options.organization;
    }

    return headers;
  }

  #buildRequestBody(messages: Message[], options: ChatOptions): Record<string, unknown> {
    const body: Record<string, unknown> = {
      model: options.model,
    };

    if (options.maxTokens !== undefined) {
      body['max_tokens'] = options.maxTokens;
    }

    if (options.temperature !== undefined) {
      body['temperature'] = options.temperature;
    }

    const apiMessages: Array<Record<string, unknown>> = [];

    // Prepend systemPrompt as a system message if provided
    if (options.systemPrompt) {
      apiMessages.push({ role: 'system', content: options.systemPrompt });
    }

    for (const message of messages) {
      apiMessages.push(this.#convertMessage(message));
    }

    body['messages'] = apiMessages;

    if (options.tools && options.tools.length > 0) {
      body['tools'] = options.tools.map((tool) => this.#convertToolDefinition(tool));
    }

    return body;
  }

  #convertMessage(message: Message): Record<string, unknown> {
    // Assistant messages with tool calls
    if (message.role === 'assistant' && message.toolCalls && message.toolCalls.length > 0) {
      return {
        role: 'assistant',
        content: message.content || null,
        tool_calls: message.toolCalls.map((toolCall) => ({
          id: toolCall.id,
          type: 'function',
          function: {
            name: toolCall.name,
            arguments: JSON.stringify(toolCall.input),
          },
        })),
      };
    }

    // Tool result messages: each result becomes a separate tool message
    // For simplicity, we send the first result as the message
    if (message.role === 'tool' && message.toolResults && message.toolResults.length > 0) {
      const result = message.toolResults[0]!;
      return {
        role: 'tool',
        tool_call_id: result.toolCallId,
        content: result.output,
      };
    }

    return { role: message.role, content: message.content };
  }

  #convertToolDefinition(tool: ToolDefinition): Record<string, unknown> {
    return {
      type: 'function',
      function: {
        name: tool.name,
        description: tool.description,
        parameters: tool.inputSchema,
      },
    };
  }

  #parseResponse(data: Record<string, unknown>): ChatResponse {
    const choices = data['choices'] as Array<Record<string, unknown>>;
    const usage = data['usage'] as Record<string, number>;
    const model = data['model'] as string;

    const choice = choices[0]!;
    const message = choice['message'] as Record<string, unknown>;
    const finishReason = choice['finish_reason'] as string;

    const content = (message['content'] as string | null) ?? '';
    const toolCalls: ToolCall[] = [];

    const rawToolCalls = message['tool_calls'] as Array<Record<string, unknown>> | undefined;
    if (rawToolCalls) {
      for (const rawCall of rawToolCalls) {
        const functionData = rawCall['function'] as Record<string, string>;
        toolCalls.push({
          id: rawCall['id'] as string,
          name: functionData['name']!,
          input: JSON.parse(functionData['arguments']!),
        });
      }
    }

    const response: ChatResponse = {
      content,
      toolCalls,
      usage: {
        inputTokens: usage['prompt_tokens'] ?? 0,
        outputTokens: usage['completion_tokens'] ?? 0,
        totalTokens: usage['total_tokens'] ?? 0,
      },
      model,
      stopReason: this.#mapFinishReason(finishReason),
    };

    // OpenAI reasoning models (o1, o3, etc.) may include reasoning content
    const reasoningTrace = message['reasoning_content'] as string | undefined;
    if (reasoningTrace) {
      response.reasoningTrace = reasoningTrace;
    }

    return response;
  }

  #mapFinishReason(finishReason: string): 'end_turn' | 'tool_use' | 'max_tokens' | 'stop_sequence' {
    switch (finishReason) {
      case 'stop':
        return 'end_turn';
      case 'tool_calls':
        return 'tool_use';
      case 'length':
        return 'max_tokens';
      case 'content_filter':
        return 'stop_sequence';
      default:
        return 'end_turn';
    }
  }
}
