import type { AgentOptions, AgentResult } from '../agent/types.ts';
import type { TokenUsage, ToolCall } from '../providers/types.ts';

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

export type PendingStreamingToolCall = {
  id: string;
  name: string;
  input: string;
};

export type StreamingChatState = {
  content: string;
  usage: TokenUsage;
  toolCalls: ToolCall[];
  pendingToolCalls: Map<string, PendingStreamingToolCall>;
};

export type StreamingTokenEnqueueState = {
  streamClosed: boolean;
  streamController: ReadableStreamDefaultController<string> | undefined;
  eventTarget?: EventTarget | undefined;
  workflowId?: string | undefined;
  model: string;
};

export interface StreamCheckpoint {
  /** Completed turn indices. */
  completedTurns: number[];
  /** Accumulated text from completed turns. */
  completedContent: string[];
  /** The turn index that was in progress when the crash occurred. */
  incompleteTurn: number | undefined;
}

export interface SSEEvent {
  id?: string;
  event?: string;
  data: string;
}
