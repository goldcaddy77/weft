import { describe, expect, it } from 'bun:test';

import { TokenEvent } from '@/core/events.ts';
import type { StreamChunk } from './providers/types.ts';
import { ReconnectionBuffer, StreamMultiplexer, TokenBridge } from './streaming.ts';

function createTestStream(chunks: StreamChunk[]): ReadableStream<StreamChunk> {
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
  });
}

async function collectStream(stream: ReadableStream<StreamChunk>): Promise<StreamChunk[]> {
  const reader = stream.getReader();
  const collected: StreamChunk[] = [];
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    collected.push(value);
  }
  return collected;
}

describe('StreamMultiplexer', () => {
  it('single consumer receives all chunks', async () => {
    const chunks: StreamChunk[] = [
      { type: 'token', token: 'Hello' },
      { type: 'token', token: ' world' },
      { type: 'done' },
    ];

    const multiplexer = new StreamMultiplexer(createTestStream(chunks));
    const consumer = multiplexer.createConsumer();
    const received = await collectStream(consumer);

    expect(received).toEqual(chunks);
  });

  it('two consumers each receive all chunks', async () => {
    const chunks: StreamChunk[] = [
      { type: 'token', token: 'A' },
      { type: 'token', token: 'B' },
      { type: 'done' },
    ];

    const multiplexer = new StreamMultiplexer(createTestStream(chunks));
    const consumer1 = multiplexer.createConsumer();
    const consumer2 = multiplexer.createConsumer();

    const [received1, received2] = await Promise.all([
      collectStream(consumer1),
      collectStream(consumer2),
    ]);

    expect(received1).toEqual(chunks);
    expect(received2).toEqual(chunks);
  });

  it('late consumer gets buffered chunks first', async () => {
    const chunks: StreamChunk[] = [
      { type: 'token', token: 'early' },
      { type: 'token', token: 'late' },
      { type: 'done' },
    ];

    const source = createTestStream(chunks);
    const multiplexer = new StreamMultiplexer(source);

    // Create first consumer to start reading the source
    const consumer1 = multiplexer.createConsumer();
    const received1 = await collectStream(consumer1);

    // Now create a late consumer after source is fully consumed
    const lateConsumer = multiplexer.createConsumer();
    const receivedLate = await collectStream(lateConsumer);

    expect(received1).toEqual(chunks);
    expect(receivedLate).toEqual(chunks);
  });

  it('cancel stops all consumers', async () => {
    let enqueued = false;
    const source = new ReadableStream<StreamChunk>({
      start(controller) {
        controller.enqueue({ type: 'token', token: 'first' });
        enqueued = true;
        // Intentionally never close so we can test cancel
      },
    });

    const multiplexer = new StreamMultiplexer(source);
    const consumer = multiplexer.createConsumer();
    const reader = consumer.getReader();

    // Wait until source has enqueued at least one chunk
    const { value } = await reader.read();
    expect(value).toEqual({ type: 'token', token: 'first' });
    expect(enqueued).toBe(true);

    multiplexer.cancel();

    // After cancel, reading should complete (done = true) or throw
    const result = await reader.read();
    expect(result.done).toBe(true);

    expect(multiplexer.consumerCount).toBe(0);
  });

  it('buffer respects maxBufferSize', async () => {
    const chunks: StreamChunk[] = Array.from({ length: 5 }, (_, index) => ({
      type: 'token' as const,
      token: `chunk-${index}`,
    }));
    chunks.push({ type: 'done' });

    const multiplexer = new StreamMultiplexer(createTestStream(chunks), { maxBufferSize: 3 });

    // Create first consumer to drain the source and fill the buffer
    const consumer1 = multiplexer.createConsumer();
    await collectStream(consumer1);

    // Late consumer should only get the last 3 buffered chunks (due to maxBufferSize)
    const lateConsumer = multiplexer.createConsumer();
    const receivedLate = await collectStream(lateConsumer);

    expect(receivedLate.length).toBe(3);
    // Should have the most recent 3 chunks
    expect(receivedLate).toEqual([
      { type: 'token', token: 'chunk-3' },
      { type: 'token', token: 'chunk-4' },
      { type: 'done' },
    ]);
  });
});

describe('TokenBridge', () => {
  it('dispatches TokenEvent for each token chunk', async () => {
    const target = new EventTarget();
    const bridge = new TokenBridge(target, 'workflow-1', 'gpt-4');

    const receivedTokens: string[] = [];
    target.addEventListener(TokenEvent.type, ((event: TokenEvent) => {
      receivedTokens.push(event.token);
    }) as EventListener);

    const stream = createTestStream([
      { type: 'token', token: 'Hello' },
      { type: 'token', token: ' world' },
      { type: 'done' },
    ]);

    await bridge.pipe(stream);

    expect(receivedTokens).toEqual(['Hello', ' world']);
  });

  it('returns accumulated text', async () => {
    const target = new EventTarget();
    const bridge = new TokenBridge(target, 'workflow-1', 'gpt-4');

    const stream = createTestStream([
      { type: 'token', token: 'Hello' },
      { type: 'token', token: ' world' },
      { type: 'done' },
    ]);

    const result = await bridge.pipe(stream);

    expect(result).toBe('Hello world');
  });

  it('ignores non-token chunks', async () => {
    const target = new EventTarget();
    const bridge = new TokenBridge(target, 'workflow-1', 'gpt-4');

    const receivedTokens: string[] = [];
    target.addEventListener(TokenEvent.type, ((event: TokenEvent) => {
      receivedTokens.push(event.token);
    }) as EventListener);

    const stream = createTestStream([
      { type: 'tool_call_start', toolCall: { id: 'tc-1', name: 'test' } },
      { type: 'token', token: 'visible' },
      { type: 'tool_call_delta', toolCall: { id: 'tc-1' } },
      { type: 'tool_call_end', toolCall: { id: 'tc-1' } },
      { type: 'done' },
    ]);

    const result = await bridge.pipe(stream);

    expect(receivedTokens).toEqual(['visible']);
    expect(result).toBe('visible');
  });
});

describe('StreamMultiplexer consumer cancellation', () => {
  it('removes the consumer when stream is cancelled via reader.cancel()', async () => {
    // Create a source stream that stays open
    let sourceController: ReadableStreamDefaultController<StreamChunk> | undefined;
    const source = new ReadableStream<StreamChunk>({
      start(controller) {
        sourceController = controller;
        controller.enqueue({ type: 'token', token: 'first' });
      },
    });

    const multiplexer = new StreamMultiplexer(source);
    const consumer = multiplexer.createConsumer();
    const reader = consumer.getReader();

    // Read one chunk to confirm consumer is active
    const { value } = await reader.read();
    expect(value).toEqual({ type: 'token', token: 'first' });
    expect(multiplexer.consumerCount).toBe(1);

    // Cancel the consumer's reader, which triggers the cancel callback (lines 57-59)
    await reader.cancel();

    // The consumer should have been removed
    expect(multiplexer.consumerCount).toBe(0);

    // Clean up: close the source and cancel the multiplexer
    if (sourceController) {
      try {
        sourceController.close();
      } catch {
        // May already be closed
      }
    }
    multiplexer.cancel();
  });
});

describe('ReconnectionBuffer', () => {
  it('stores turns', () => {
    const buffer = new ReconnectionBuffer();
    buffer.addTurn('Hello');
    buffer.addTurn('World');

    expect(buffer.turnCount).toBe(2);
  });

  it('respects maxTurns', () => {
    const buffer = new ReconnectionBuffer({ maxTurns: 2 });
    buffer.addTurn('first');
    buffer.addTurn('second');
    buffer.addTurn('third');

    const turns = buffer.getTurns();
    expect(turns).toEqual(['second', 'third']);
    expect(buffer.turnCount).toBe(2);
  });

  it('clear removes all turns', () => {
    const buffer = new ReconnectionBuffer();
    buffer.addTurn('one');
    buffer.addTurn('two');

    buffer.clear();

    expect(buffer.turnCount).toBe(0);
    expect(buffer.getTurns()).toEqual([]);
  });

  it('getTurns returns all stored turns', () => {
    const buffer = new ReconnectionBuffer();
    buffer.addTurn('alpha');
    buffer.addTurn('beta');
    buffer.addTurn('gamma');

    const turns = buffer.getTurns();

    expect(turns).toEqual(['alpha', 'beta', 'gamma']);
    // Ensure it returns a copy, not the internal array
    turns.push('delta');
    expect(buffer.getTurns()).toEqual(['alpha', 'beta', 'gamma']);
  });

  it('evicts oldest turns when byte budget is exceeded', () => {
    // estimateTurnBytes uses text.length * 2, so a 100-char string = 200 bytes
    const buffer = new ReconnectionBuffer({ maxBytes: 400 });

    buffer.addTurn('A'.repeat(100)); // 200 bytes
    buffer.addTurn('B'.repeat(100)); // 200 bytes — total 400, at limit
    buffer.addTurn('C'.repeat(100)); // 200 bytes — would be 600, must evict oldest

    expect(buffer.turnCount).toBe(2);
    expect(buffer.getTurns()).toEqual(['B'.repeat(100), 'C'.repeat(100)]);
  });

  it('tracks currentBytes correctly after eviction', () => {
    const buffer = new ReconnectionBuffer({ maxBytes: 400 });
    buffer.addTurn('A'.repeat(100)); // 200 bytes
    buffer.addTurn('B'.repeat(100)); // 200 bytes
    expect(buffer.currentBytes).toBe(400);

    buffer.addTurn('C'.repeat(100)); // forces eviction of 'A'
    expect(buffer.currentBytes).toBe(400); // 'B' + 'C'
  });

  it('keeps a single oversized turn rather than leaving buffer empty', () => {
    const buffer = new ReconnectionBuffer({ maxBytes: 10 });
    buffer.addTurn('X'.repeat(100)); // 200 bytes, exceeds budget alone

    // The while loop stops at length > 1, so the lone entry is kept
    expect(buffer.turnCount).toBe(1);
    expect(buffer.currentBytes).toBe(200);
  });

  it('resets currentBytes on clear', () => {
    const buffer = new ReconnectionBuffer({ maxBytes: 1000 });
    buffer.addTurn('A'.repeat(100));
    buffer.addTurn('B'.repeat(100));
    expect(buffer.currentBytes).toBe(400);

    buffer.clear();
    expect(buffer.currentBytes).toBe(0);
    expect(buffer.turnCount).toBe(0);
  });

  it('enforces both maxTurns and maxBytes together', () => {
    // maxTurns = 5 but byte budget only fits 2 turns
    const buffer = new ReconnectionBuffer({ maxTurns: 5, maxBytes: 400 });

    buffer.addTurn('A'.repeat(100)); // 200 bytes
    buffer.addTurn('B'.repeat(100)); // 200 bytes
    buffer.addTurn('C'.repeat(100)); // 200 bytes — byte budget forces eviction

    expect(buffer.turnCount).toBe(2);
    expect(buffer.getTurns()).toEqual(['B'.repeat(100), 'C'.repeat(100)]);
  });
});
