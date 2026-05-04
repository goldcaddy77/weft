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

import { executeAgentLoop } from '../agent.ts';
import { createStreamingProvider } from './provider-wrapper.ts';
import { enqueueStreamingToken } from './token-enqueue.ts';
import type { StreamingAgentOptions, StreamingAgentResult } from './types.ts';

export * from './checkpoint.ts';
export * from './provider-wrapper.ts';
export * from './sse.ts';
export * from './token-enqueue.ts';
export type {
  SSEEvent,
  StreamCheckpoint,
  StreamDestination,
  StreamFrame,
  StreamingAgentOptions,
  StreamingAgentResult,
  StreamingTokenEnqueueState,
} from './types.ts';

const textEncoder = new TextEncoder();

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
    const nextState = enqueueStreamingToken(token, {
      streamClosed,
      streamController,
      eventTarget,
      workflowId,
      model: options.model,
    });
    streamClosed = nextState.streamClosed;
    streamController = nextState.streamController;
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
