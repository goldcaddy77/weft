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

  it('swallows source cancellation rejections when cancelling the multiplexer', async () => {
    const source = new ReadableStream<StreamChunk>({
      start(controller) {
        controller.enqueue({ type: 'token', token: 'first' });
      },
      cancel() {
        throw new Error('source cancel failed');
      },
    });

    const multiplexer = new StreamMultiplexer(source);
    const reader = multiplexer.createConsumer().getReader();

    await reader.read();

    multiplexer.cancel();
    await Bun.sleep(0);

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

  it('respects maxBytes and evicts oldest turns when budget exceeded', () => {
    // JSON.stringify('x'.repeat(n)).length === n + 2 (the quotes)
    // Pick a budget that fits exactly two 10-character turns (12 bytes each) plus nothing more.
    const buffer = new ReconnectionBuffer({ maxTurns: 100, maxBytes: 30 });

    buffer.addTurn('x'.repeat(10)); // 12 bytes
    buffer.addTurn('y'.repeat(10)); // 24 bytes total
    expect(buffer.turnCount).toBe(2);
    expect(buffer.byteSize).toBe(24);

    // Adding a third 10-char turn pushes total to 36 bytes, which is over the 30-byte budget.
    // The oldest turn should be evicted.
    buffer.addTurn('z'.repeat(10));
    expect(buffer.turnCount).toBe(2);
    expect(buffer.byteSize).toBe(24);
    expect(buffer.getTurns()).toEqual(['y'.repeat(10), 'z'.repeat(10)]);
  });

  it('keeps a single oversized turn rather than wiping the buffer entirely', () => {
    const buffer = new ReconnectionBuffer({ maxBytes: 10 });
    const bigTurn = 'a'.repeat(1000);
    buffer.addTurn(bigTurn);

    // A single turn exceeding the budget is retained so the client can still replay it.
    expect(buffer.turnCount).toBe(1);
    expect(buffer.getTurns()).toEqual([bigTurn]);
  });

  it('maxTurns still applies when byte budget is generous', () => {
    const buffer = new ReconnectionBuffer({ maxTurns: 2, maxBytes: 1024 * 1024 });
    buffer.addTurn('first');
    buffer.addTurn('second');
    buffer.addTurn('third');

    expect(buffer.turnCount).toBe(2);
    expect(buffer.getTurns()).toEqual(['second', 'third']);
  });

  it('clear resets the byte counter', () => {
    const buffer = new ReconnectionBuffer();
    buffer.addTurn('hello');
    expect(buffer.byteSize).toBeGreaterThan(0);

    buffer.clear();
    expect(buffer.byteSize).toBe(0);
    expect(buffer.turnCount).toBe(0);
  });
});

describe('StreamMultiplexer source error', () => {
  it('clears the replay buffer when the source stream errors', async () => {
    let sourceController: ReadableStreamDefaultController<StreamChunk> | undefined;
    const source = new ReadableStream<StreamChunk>({
      start(controller) {
        sourceController = controller;
      },
    });

    const multiplexer = new StreamMultiplexer(source);
    const consumer = multiplexer.createConsumer();
    const reader = consumer.getReader();

    // Enqueue two chunks to populate the replay buffer, then error the source.
    sourceController!.enqueue({ type: 'token', token: 'one' });
    sourceController!.enqueue({ type: 'token', token: 'two' });

    // Drain what's available before the error.
    const firstRead = await reader.read();
    expect(firstRead.value).toEqual({ type: 'token', token: 'one' });
    const secondRead = await reader.read();
    expect(secondRead.value).toEqual({ type: 'token', token: 'two' });

    sourceController!.error(new Error('source boom'));

    // Let the catch block in #pump run.
    const afterError = await reader.read();
    expect(afterError.done).toBe(true);

    // A late consumer attaches after the source has errored. It must NOT receive stale
    // buffered chunks — the buffer should have been cleared on error.
    const lateConsumer = multiplexer.createConsumer();
    const lateReader = lateConsumer.getReader();
    const lateFirst = await lateReader.read();
    expect(lateFirst.done).toBe(true);
  });
});

describe('TokenBridge reader release', () => {
  it('releases the reader after normal completion so the source can be re-read', async () => {
    const stream = createTestStream([{ type: 'token', token: 'Hello' }, { type: 'done' }]);

    const bridge = new TokenBridge(new EventTarget(), 'workflow-1', 'gpt-4');
    await bridge.pipe(stream);

    // After pipe exits normally, attempting to acquire a new reader on the
    // underlying stream must not throw with "already locked".
    expect(() => stream.getReader()).not.toThrow();
  });

  it('releases the reader after an error in the source stream', async () => {
    const stream = new ReadableStream<StreamChunk>({
      pull(controller) {
        controller.error(new Error('source failed'));
      },
    });

    const bridge = new TokenBridge(new EventTarget(), 'workflow-1', 'gpt-4');

    let thrown: Error | undefined;
    try {
      await bridge.pipe(stream);
    } catch (error) {
      thrown = error as Error;
    }

    expect(thrown).toBeDefined();
    // After the finally runs, the stream should no longer be locked.
    expect(() => stream.getReader()).not.toThrow();
  });
});
