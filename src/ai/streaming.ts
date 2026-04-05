import { TokenEvent } from '../core/events.ts';

import type { StreamChunk } from './providers/types.ts';

export interface MultiplexerOptions {
  maxBufferSize?: number;
}

/** Multiplexes a single source stream to multiple consumers without duplicating the source. */
export class StreamMultiplexer {
  #source: ReadableStream<StreamChunk>;
  #consumers: Set<ReadableStreamDefaultController<StreamChunk>>;
  #buffer: StreamChunk[];
  #maxBufferSize: number;
  #started: boolean;
  #finished: boolean;
  #reader: ReadableStreamDefaultReader<StreamChunk> | undefined;

  constructor(source: ReadableStream<StreamChunk>, options?: MultiplexerOptions) {
    this.#source = source;
    this.#consumers = new Set();
    this.#buffer = [];
    this.#maxBufferSize = options?.maxBufferSize ?? 1000;
    this.#started = false;
    this.#finished = false;
  }

  /** Create a new consumer stream. Late consumers receive buffered chunks first. */
  createConsumer(): ReadableStream<StreamChunk> {
    let controllerRef: ReadableStreamDefaultController<StreamChunk> | undefined;

    return new ReadableStream<StreamChunk>({
      start: (controller) => {
        controllerRef = controller;

        // If the source is already fully consumed, replay the buffer and close
        if (this.#finished) {
          for (const chunk of this.#buffer) {
            controller.enqueue(chunk);
          }
          controller.close();
          return;
        }

        // Replay any buffered chunks for late consumers
        for (const chunk of this.#buffer) {
          controller.enqueue(chunk);
        }

        this.#consumers.add(controller);

        if (!this.#started) {
          this.#started = true;
          void this.#pump();
        }
      },
      cancel: () => {
        if (controllerRef) {
          this.#consumers.delete(controllerRef);
        }
      },
    });
  }

  /** Number of active consumers. */
  get consumerCount(): number {
    return this.#consumers.size;
  }

  /** Cancel the source and all consumers. */
  cancel(): void {
    if (this.#reader) {
      this.#reader.cancel().catch(() => {});
    }

    for (const controller of this.#consumers) {
      try {
        controller.close();
      } catch {
        // Controller may already be closed
      }
    }
    this.#consumers.clear();
    this.#finished = true;
  }

  async #pump(): Promise<void> {
    this.#reader = this.#source.getReader();

    try {
      while (true) {
        const { done, value } = await this.#reader.read();

        if (done) {
          this.#finished = true;
          for (const controller of this.#consumers) {
            try {
              controller.close();
            } catch {
              // Controller may already be closed
            }
          }
          this.#consumers.clear();
          return;
        }

        // Buffer the chunk for late consumers
        this.#buffer.push(value);
        if (this.#buffer.length > this.#maxBufferSize) {
          this.#buffer.shift();
        }

        // Broadcast to all active consumers
        for (const controller of this.#consumers) {
          try {
            controller.enqueue(value);
          } catch {
            this.#consumers.delete(controller);
          }
        }
      }
    } catch {
      // Source stream errored or was cancelled
      this.#finished = true;
      this.#buffer = [];
      for (const controller of this.#consumers) {
        try {
          controller.close();
        } catch {
          // Controller may already be closed
        }
      }
      this.#consumers.clear();
    }
  }
}

/** Bridges a ReadableStream to an EventTarget, dispatching TokenEvent for each token chunk. */
export class TokenBridge {
  #target: EventTarget;
  #workflowId: string;
  #model: string;

  constructor(target: EventTarget, workflowId: string, model: string) {
    this.#target = target;
    this.#workflowId = workflowId;
    this.#model = model;
  }

  /** Pipe a stream through the bridge, dispatching events for each token. Returns accumulated text. */
  async pipe(stream: ReadableStream<StreamChunk>): Promise<string> {
    const reader = stream.getReader();
    let accumulated = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      if (value.type === 'token' && value.token !== undefined) {
        accumulated += value.token;
        this.#target.dispatchEvent(new TokenEvent(this.#workflowId, value.token, this.#model));
      }
    }

    return accumulated;
  }
}

/** Default byte budget: 10 MB. */
const DEFAULT_MAX_BYTES = 10 * 1024 * 1024;

export interface ReconnectionBufferOptions {
  maxTurns?: number;
  /** Maximum cumulative byte size of buffered turns. Defaults to 10 MB. */
  maxBytes?: number;
}

/** Accumulates completed turn text for reconnecting clients. */
export class ReconnectionBuffer {
  #turns: string[];
  #maxTurns: number;
  #maxBytes: number;
  #currentBytes: number;

  constructor(options?: ReconnectionBufferOptions) {
    this.#turns = [];
    this.#maxTurns = options?.maxTurns ?? 10;
    this.#maxBytes = options?.maxBytes ?? DEFAULT_MAX_BYTES;
    this.#currentBytes = 0;
  }

  /** Record a completed turn's text. */
  addTurn(text: string): void {
    const turnBytes = estimateTurnBytes(text);
    this.#turns.push(text);
    this.#currentBytes += turnBytes;

    // Enforce turn count limit
    while (this.#turns.length > this.#maxTurns) {
      const evicted = this.#turns.shift()!;
      this.#currentBytes -= estimateTurnBytes(evicted);
    }

    // Enforce byte budget by evicting oldest turns
    while (this.#currentBytes > this.#maxBytes && this.#turns.length > 1) {
      const evicted = this.#turns.shift()!;
      this.#currentBytes -= estimateTurnBytes(evicted);
    }
  }

  /** Get all buffered turns for replay. */
  getTurns(): string[] {
    return [...this.#turns];
  }

  /** Get the current number of buffered turns. */
  get turnCount(): number {
    return this.#turns.length;
  }

  /** Get the estimated byte size of all buffered turns. */
  get currentBytes(): number {
    return this.#currentBytes;
  }

  /** Clear the buffer. */
  clear(): void {
    this.#turns = [];
    this.#currentBytes = 0;
  }
}

/** Estimate the byte size of a turn string. Uses 2 bytes per char as a rough UTF-16 approximation. */
function estimateTurnBytes(text: string): number {
  return text.length * 2;
}
