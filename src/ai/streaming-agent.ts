/**
 * First-class streaming support for the agent loop.
 *
 * Wraps {@link executeAgentLoop} to provide a `ReadableStream<string>` of
 * tokens when `streamTo: "output"` is configured. Bridges tokens to
 * EventTarget, integrates with {@link StreamMultiplexer}, supports crash
 * recovery mid-stream, backpressure, and AbortController cancellation.
 *
 * @module streaming-agent
 */

import { TokenEvent } from '../core/events.ts';
import type { AgentOptions, AgentResult } from './agent.ts';
import { executeAgentLoop } from './agent.ts';
import type { LLMProvider } from './providers/interface.ts';
import type {
  ChatResponse,
  Message,
  StreamChunk,
  TokenUsage,
  ToolCall,
} from './providers/types.ts';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type StreamDestination = 'output';

export interface StreamingAgentOptions extends AgentOptions {
  /** When set to "output", the agent returns a ReadableStream of tokens. */
  streamTo?: StreamDestination | undefined;
  /** Maximum buffer size in bytes before a slow consumer is disconnected. Defaults to 65536 (64KB). */
  maxStreamBufferSize?: number | undefined;
}

export interface StreamingAgentResult {
  /** The readable stream of token strings. Only present when streamTo is "output". */
  stream: ReadableStream<string>;
  /** A promise that resolves to the full AgentResult once the agent loop completes. */
  result: Promise<AgentResult>;
}

/** Frame types used for replay buffer and live streaming. */
export type StreamFrame = { type: 'replay'; content: string } | { type: 'token'; token: string };

/** Shared encoder instance — avoids allocation per token in the hot path. */
const textEncoder = new TextEncoder();

type PendingStreamingToolCall = {
  id: string;
  name: string;
  input: string;
};

type StreamingChatState = {
  content: string;
  usage: TokenUsage;
  toolCalls: ToolCall[];
  pendingToolCalls: Map<string, PendingStreamingToolCall>;
};

function createStreamingChatState(): StreamingChatState {
  return {
    content: '',
    usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
    toolCalls: [],
    pendingToolCalls: new Map<string, PendingStreamingToolCall>(),
  };
}

function appendToolCallInput(pendingToolCall: PendingStreamingToolCall, input: unknown): void {
  if (input === undefined) {
    return;
  }

  pendingToolCall.input += typeof input === 'string' ? input : JSON.stringify(input);
}

function finalizePendingToolCall(toolCallId: string, state: StreamingChatState): void {
  const pendingToolCall = state.pendingToolCalls.get(toolCallId);
  if (!pendingToolCall) {
    return;
  }

  let parsedInput: unknown;
  try {
    parsedInput = JSON.parse(pendingToolCall.input);
  } catch {
    parsedInput = pendingToolCall.input || {};
  }

  state.toolCalls.push({
    id: pendingToolCall.id,
    name: pendingToolCall.name,
    input: parsedInput,
  });
  state.pendingToolCalls.delete(toolCallId);
}

function handleStreamingChunk(
  chunk: StreamChunk,
  state: StreamingChatState,
  onToken: (token: string) => void,
): void {
  switch (chunk.type) {
    case 'token':
      if (chunk.token !== undefined) {
        state.content += chunk.token;
        onToken(chunk.token);
      }
      return;
    case 'tool_call_start':
      if (chunk.toolCall?.id) {
        state.pendingToolCalls.set(chunk.toolCall.id, {
          id: chunk.toolCall.id,
          name: chunk.toolCall.name ?? '',
          input: '',
        });
      }
      return;
    case 'tool_call_delta':
      if (chunk.toolCall?.id) {
        const pendingToolCall = state.pendingToolCalls.get(chunk.toolCall.id);
        if (pendingToolCall) {
          appendToolCallInput(pendingToolCall, chunk.toolCall.input);
        }
      }
      return;
    case 'tool_call_end':
      if (chunk.toolCall?.id) {
        finalizePendingToolCall(chunk.toolCall.id, state);
      }
      return;
    case 'done':
      if (chunk.usage) {
        state.usage = chunk.usage;
      }
      return;
  }
}

// ---------------------------------------------------------------------------
// Streaming wrapper for LLM provider
// ---------------------------------------------------------------------------

/**
 * Wraps an LLMProvider's `chat` method to use `stream` instead, collecting
 * tokens through a callback while still returning a full ChatResponse.
 */
export function createStreamingProvider(
  provider: LLMProvider,
  onToken: (token: string) => void,
): LLMProvider {
  return {
    name: provider.name,

    async chat(
      messages: Message[],
      options: import('./providers/interface.ts').ChatOptions,
    ): Promise<ChatResponse> {
      const stream = await provider.stream(messages, options);
      const reader = stream.getReader();
      const state = createStreamingChatState();

      try {
        while (true) {
          const chunk = await reader.read();
          if (chunk.done) break;
          handleStreamingChunk(chunk.value, state, onToken);
        }
      } finally {
        reader.cancel().catch(() => {});
      }

      return {
        content: state.content,
        toolCalls: state.toolCalls,
        usage: state.usage,
        model: options.model,
        stopReason: state.toolCalls.length > 0 ? 'tool_use' : 'end_turn',
      };
    },

    async stream(messages: Message[], options: import('./providers/interface.ts').ChatOptions) {
      return provider.stream(messages, options);
    },

    async countTokens(messages: Message[]): Promise<number> {
      return provider.countTokens(messages);
    },
  };
}

// ---------------------------------------------------------------------------
// executeStreamingAgent
// ---------------------------------------------------------------------------

/**
 * Execute the agent loop with first-class streaming support.
 *
 * When `streamTo: "output"` is configured, returns a `StreamingAgentResult`
 * containing a `ReadableStream<string>` that emits tokens as they arrive
 * from the LLM provider, plus a promise for the full result.
 *
 * The stream is wired to dispatch `TokenEvent` on the provided `eventTarget`
 * and respects `AbortController` cancellation via the `signal` option.
 */
export function executeStreamingAgent(
  options: StreamingAgentOptions,
  input: string,
): StreamingAgentResult {
  const {
    streamTo,
    eventTarget,
    workflowId,
    signal,
    maxStreamBufferSize = 65_536,
    ...restOptions
  } = options;

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
      size: (chunk) => textEncoder.encode(chunk).byteLength,
    },
  );

  // Token callback — enqueue tokens into the stream and optionally dispatch events
  const onToken = (token: string): void => {
    if (streamClosed || !streamController) return;

    // Backpressure: use the Web Streams API's built-in queue tracking.
    // When desiredSize drops to zero or below, the consumer is falling behind
    // and the internal queue has exceeded the highWaterMark we configured.
    if (streamController.desiredSize !== null && streamController.desiredSize <= 0) {
      try {
        streamController.error(new Error('Stream buffer exceeded maximum size'));
      } catch {
        // Controller may already be closed
      }
      streamClosed = true;
      return;
    }

    try {
      streamController.enqueue(token);
    } catch {
      streamClosed = true;
    }

    // Dispatch TokenEvent if eventTarget is provided
    if (eventTarget && workflowId) {
      eventTarget.dispatchEvent(new TokenEvent(workflowId, token, options.model));
    }
  };

  // Create a streaming provider wrapper
  const streamingProvider = createStreamingProvider(options.provider, onToken);

  // Handle abort signal
  let abortCleanup: (() => void) | undefined;

  if (signal) {
    const onAbort = (): void => {
      if (!streamClosed && streamController) {
        try {
          streamController.close();
        } catch {
          // Controller may already be closed
        }
        streamClosed = true;
      }
    };

    if (signal.aborted) {
      onAbort();
    } else {
      signal.addEventListener('abort', onAbort, { once: true });
      abortCleanup = () => signal.removeEventListener('abort', onAbort);
    }
  }

  // Execute the agent loop with the streaming provider
  const resultPromise = executeAgentLoop(
    {
      ...restOptions,
      provider: streamingProvider,
      eventTarget,
      workflowId,
      signal,
      model: options.model,
    },
    input,
  ).then(
    (result) => {
      abortCleanup?.();
      // Close the stream when the agent loop completes
      if (!streamClosed && streamController) {
        try {
          streamController.close();
        } catch {
          // Controller may already be closed
        }
        streamClosed = true;
      }
      return result;
    },
    (error) => {
      abortCleanup?.();
      // Error the stream if the agent loop fails
      if (!streamClosed && streamController) {
        try {
          streamController.error(error);
        } catch {
          // Controller may already be closed
        }
        streamClosed = true;
      }
      throw error;
    },
  );

  return { stream, result: resultPromise };
}

// ---------------------------------------------------------------------------
// Crash recovery support
// ---------------------------------------------------------------------------

export interface StreamCheckpoint {
  /** Completed turn indices. */
  completedTurns: number[];
  /** Accumulated text from completed turns. */
  completedContent: string[];
  /** The turn index that was in progress when the crash occurred. */
  incompleteTurn: number | undefined;
}

/**
 * Build a checkpoint from a partial agent conversation.
 * Identifies which turns completed (have both assistant and tool messages)
 * and which turn was incomplete at crash time.
 */
export function buildStreamCheckpoint(conversation: Message[]): StreamCheckpoint {
  const checkpoint: StreamCheckpoint = {
    completedTurns: [],
    completedContent: [],
    incompleteTurn: undefined,
  };

  let turnIndex = 0;
  let i = 0;

  // Skip system message
  if (conversation.length > 0 && conversation[0]!.role === 'system') {
    i = 1;
  }

  // Skip initial user message
  if (i < conversation.length && conversation[i]!.role === 'user') {
    i++;
  }

  while (i < conversation.length) {
    const message = conversation[i]!;

    if (message.role === 'assistant') {
      // Check if there's a following tool message (meaning this turn completed)
      const hasToolCalls = message.toolCalls && message.toolCalls.length > 0;

      if (hasToolCalls) {
        // Look for the corresponding tool result
        const nextMessage = i + 1 < conversation.length ? conversation[i + 1] : undefined;
        if (nextMessage?.role === 'tool') {
          // Complete turn with tool calls
          checkpoint.completedTurns.push(turnIndex);
          checkpoint.completedContent.push(message.content);
          i += 2; // Skip past the tool result
          turnIndex++;
          continue;
        }
        // Incomplete turn — assistant sent tool calls but no result came back
        checkpoint.incompleteTurn = turnIndex;
        break;
      }

      // Assistant message without tool calls = final answer turn
      // If it's the last message, it was the final complete turn
      if (i === conversation.length - 1) {
        checkpoint.completedTurns.push(turnIndex);
        checkpoint.completedContent.push(message.content);
      } else {
        checkpoint.incompleteTurn = turnIndex;
      }
      break;
    }

    i++;
    turnIndex++;
  }

  // If we exited the loop without finding an incomplete turn and the last
  // assistant message had no tool calls, the conversation might have been
  // interrupted between turns
  if (
    checkpoint.incompleteTurn === undefined &&
    conversation.length > 0 &&
    conversation[conversation.length - 1]!.role === 'assistant' &&
    !conversation[conversation.length - 1]!.toolCalls?.length
  ) {
    // Last message was a final answer — already captured above
  }

  return checkpoint;
}

/**
 * Build recovery messages from a checkpoint. Returns the conversation
 * prefix that should be sent to the LLM to resume from the incomplete turn.
 */
export function buildRecoveryConversation(
  originalConversation: Message[],
  checkpoint: StreamCheckpoint,
): Message[] {
  const recovery: Message[] = [];

  // Copy system and user messages
  for (const message of originalConversation) {
    if (message.role === 'system' || message.role === 'user') {
      recovery.push(message);
    } else {
      break;
    }
  }

  // Add completed turns
  let i = recovery.length;
  let completedCount = 0;

  while (i < originalConversation.length && completedCount < checkpoint.completedTurns.length) {
    const message = originalConversation[i]!;
    recovery.push(message);

    if (message.role === 'assistant') {
      if (message.toolCalls && message.toolCalls.length > 0) {
        // Include the tool result too
        const nextMessage = originalConversation[i + 1];
        if (nextMessage?.role === 'tool') {
          recovery.push(nextMessage);
          i += 2;
          completedCount++;
          continue;
        }
      } else {
        completedCount++;
      }
    }

    i++;
  }

  // The incomplete turn is discarded — the LLM will re-issue it
  return recovery;
}

// ---------------------------------------------------------------------------
// SSE formatting
// ---------------------------------------------------------------------------

export interface SSEEvent {
  id?: string;
  event?: string;
  data: string;
}

/** Format an event as an SSE string. */
export function formatSSE(event: SSEEvent): string {
  const lines: string[] = [];
  if (event.id !== undefined) lines.push(`id: ${event.id}`);
  if (event.event !== undefined) lines.push(`event: ${event.event}`);

  // Data can be multiline — each line gets its own `data:` prefix
  const dataLines = event.data.split('\n');
  for (const line of dataLines) {
    lines.push(`data: ${line}`);
  }

  lines.push(''); // Empty line terminates the event
  return lines.join('\n') + '\n';
}

/**
 * Create an SSE ReadableStream from a token stream.
 * Each token becomes an SSE event with incrementing IDs.
 * Supports resumption via `lastEventId`.
 */
export function createSSEStream(
  tokenStream: ReadableStream<string>,
  lastEventId?: string,
): ReadableStream<Uint8Array> {
  const encoder = textEncoder;
  const parsed = lastEventId ? parseInt(lastEventId, 10) : NaN;
  let eventId = Number.isNaN(parsed) ? 0 : parsed + 1;

  let reader: ReadableStreamDefaultReader<string>;

  return new ReadableStream<Uint8Array>({
    async start(controller) {
      reader = tokenStream.getReader();

      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) {
            // Send a final "done" event
            const doneEvent = formatSSE({
              id: String(eventId),
              event: 'done',
              data: '',
            });
            controller.enqueue(encoder.encode(doneEvent));
            controller.close();
            // Release the lock so the caller can still inspect or reuse
            // the underlying token stream (e.g., for a second consumer).
            reader.releaseLock();
            return;
          }

          const sseEvent = formatSSE({
            id: String(eventId),
            event: 'token',
            data: value,
          });

          controller.enqueue(encoder.encode(sseEvent));
          eventId++;
        }
      } catch (error) {
        try {
          controller.error(error);
        } catch {
          // Controller may already be closed
        }
        // Release the lock on error too so the token stream isn't left
        // in a locked state with no active reader.
        try {
          reader.releaseLock();
        } catch {
          // releaseLock throws if there are pending reads — ignore.
        }
      }
    },
    cancel() {
      reader?.cancel().catch(() => {});
    },
  });
}
