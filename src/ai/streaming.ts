import { TokenEvent } from '../core/events.ts';

import type { StreamChunk } from './providers/types.ts';

function ignoreStreamError(_error: unknown): void {}

export interface MultiplexerOptions {
  maxBufferSize?: number;
}

/**
 * Multiplexes a single source stream to multiple consumers without duplicating the source.
 *
 * Late consumers receive all buffered chunks before live chunks, up to
 * `maxBufferSize`. Useful when multiple UI panels or loggers must independently
 * consume the same token stream from a single LLM call.
 *
 * @example Fan out one LLM token stream to two independent readers
 * ```ts
 * import { StreamMultiplexer, TokenBridge } from 'weft';
 * import type { StreamChunk } from 'weft';
 *
 * declare const sourceStream: ReadableStream<StreamChunk>;
 * const targetA = new EventTarget();
 * const targetB = new EventTarget();
 *
 * const mux = new StreamMultiplexer(sourceStream);
 *
 * // Create two independent consumers from the same source.
 * const bridgeA = new TokenBridge(targetA, 'workflow-1', 'claude-sonnet-4-5');
 * const bridgeB = new TokenBridge(targetB, 'workflow-1', 'claude-sonnet-4-5');
 *
 * void bridgeA.pipe(mux.createConsumer());
 * void bridgeB.pipe(mux.createConsumer());
 * ```
 */
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
      this.#reader.cancel().catch(ignoreStreamError);
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

  // oxlint-disable-next-line complexity -- ID:ai-streaming-pump-complexity
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
      // Source stream errored or was cancelled. Drop buffered chunks so
      // future consumers attaching after the error cannot replay stale
      // data from the broken source.
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

/**
 * Bridges a ReadableStream to an EventTarget, dispatching {@link TokenEvent} for each token chunk.
 *
 * @example Pipe a streaming LLM response to an engine event target
 * ```ts
 * import { TokenBridge } from 'weft';
 * import type { StreamChunk } from 'weft';
 *
 * declare const stream: ReadableStream<StreamChunk>;
 * const target = new EventTarget();
 *
 * const bridge = new TokenBridge(target, 'workflow-123', 'claude-sonnet-4-5');
 * const fullText = await bridge.pipe(stream);
 * console.log('Complete response:', fullText);
 * ```
 */
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

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        if (value.type === 'token' && value.token !== undefined) {
          accumulated += value.token;
          this.#target.dispatchEvent(new TokenEvent(this.#workflowId, value.token, this.#model));
        }
      }
    } finally {
      // Release the reader so the source stream isn't left locked on early
      // return or error. Cancel first to signal loss of interest (and
      // propagate errors), then release the lock. Awaiting `cancel()`
      // ensures any in-flight read is fully settled before `releaseLock()` —
      // per the Streams spec, `releaseLock()` throws a TypeError if a read
      // is pending, which would silently leave the stream locked forever.
      // Matches the contract documented in `providers/stream-reader.ts`.
      try {
        await reader.cancel();
      } catch {
        // Reader already in a terminal state — ignore.
      }
      try {
        reader.releaseLock();
      } catch {
        // Lock already released or reader in a terminal state — ignore.
      }
    }

    return accumulated;
  }
}

export interface ReconnectionBufferOptions {
  maxTurns?: number;
  /**
   * Approximate maximum byte budget across all buffered turns.
   * Defaults to 10 MB, which is a pragmatic ceiling for in-memory
   * replay buffers: large enough to cover long generated responses,
   * small enough to prevent a single runaway workflow from exhausting
   * process memory. When exceeded, the oldest turns are evicted first.
   */
  maxBytes?: number;
}

const DEFAULT_RECONNECTION_MAX_BYTES = 10 * 1024 * 1024;

/**
 * Accumulates completed turn text for reconnecting clients.
 *
 * Stores the last N turns of agent output so that a client reconnecting after
 * a network interruption can replay missed content. Oldest turns are evicted
 * first when the count or byte limit is reached.
 *
 * @example Replay buffered turns to a reconnected client
 * ```ts
 * import { ReconnectionBuffer } from 'weft';
 *
 * const buffer = new ReconnectionBuffer({ maxTurns: 5, maxBytes: 1_048_576 });
 *
 * buffer.addTurn('First agent response text.');
 * buffer.addTurn('Second agent response text.');
 *
 * // On reconnect, send all buffered turns.
 * for (const turn of buffer.getTurns()) {
 *   console.log('Replaying turn:', turn);
 * }
 * ```
 */
export class ReconnectionBuffer {
  #turns: string[];
  #turnSizes: number[];
  #maxTurns: number;
  #maxBytes: number;
  #totalBytes: number;

  constructor(options?: ReconnectionBufferOptions) {
    this.#turns = [];
    this.#turnSizes = [];
    this.#maxTurns = options?.maxTurns ?? 10;
    this.#maxBytes = options?.maxBytes ?? DEFAULT_RECONNECTION_MAX_BYTES;
    this.#totalBytes = 0;
  }

  /** Record a completed turn's text. */
  addTurn(text: string): void {
    // Approximate byte size: matches the original finding's suggestion
    // of JSON.stringify length. For plain strings this is roughly the
    // character count plus quoting overhead, which is fine as a heuristic.
    const size = JSON.stringify(text).length;
    this.#turns.push(text);
    this.#turnSizes.push(size);
    this.#totalBytes += size;

    // Evict by count first
    while (this.#turns.length > this.#maxTurns) {
      this.#evictOldest();
    }

    // Then evict by byte budget, but always keep at least one turn
    // so a single oversized turn doesn't wipe the buffer entirely.
    while (this.#totalBytes > this.#maxBytes && this.#turns.length > 1) {
      this.#evictOldest();
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

  /** Approximate total byte size of buffered turns. */
  get byteSize(): number {
    return this.#totalBytes;
  }

  /** Clear the buffer. */
  clear(): void {
    this.#turns = [];
    this.#turnSizes = [];
    this.#totalBytes = 0;
  }

  #evictOldest(): void {
    this.#turns.shift();
    const removed = this.#turnSizes.shift() ?? 0;
    this.#totalBytes -= removed;
  }
}
