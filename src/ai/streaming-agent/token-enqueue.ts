import { TokenEvent } from '../../core/events.ts';
import type { StreamingTokenEnqueueState } from './types.ts';

/** Enqueue a streamed token, applying backpressure and optional TokenEvent dispatching. */
export function enqueueStreamingToken(
  token: string,
  state: StreamingTokenEnqueueState,
): StreamingTokenEnqueueState {
  if (state.streamClosed || !state.streamController) {
    return state;
  }

  // Backpressure: use the Web Streams API's built-in queue tracking.
  // When desiredSize drops to zero or below, the consumer is falling behind
  // and the internal queue has exceeded the highWaterMark we configured.
  if (state.streamController.desiredSize !== null && state.streamController.desiredSize <= 0) {
    try {
      state.streamController.error(new Error('Stream buffer exceeded maximum size'));
    } catch {
      // Controller may already be closed
    }
    return { ...state, streamClosed: true };
  }

  let nextState = state;
  try {
    state.streamController.enqueue(token);
  } catch {
    nextState = { ...state, streamClosed: true };
  }

  if (state.eventTarget && state.workflowId) {
    state.eventTarget.dispatchEvent(new TokenEvent(state.workflowId, token, state.model));
  }

  return nextState;
}

// ---------------------------------------------------------------------------
// Streaming wrapper for LLM provider
// ---------------------------------------------------------------------------
