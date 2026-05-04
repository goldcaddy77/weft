import type { SSEEvent } from './types.ts';

const textEncoder = new TextEncoder();

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
  let readerReleased = false;

  const releaseReader = (): void => {
    if (readerReleased) return;
    try {
      reader.releaseLock();
      readerReleased = true;
    } catch {
      // releaseLock() throws when there are still pending reads — for
      // example, when `cancel()` fires while `start()` is awaiting
      // `reader.read()`. Leave `readerReleased` false so the subsequent
      // call from `start()`'s finally (after the pending read settles)
      // gets another chance to release the lock.
    }
  };

  return new ReadableStream<Uint8Array>({
    async start(controller) {
      reader = tokenStream.getReader();

      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) {
            const doneEvent = formatSSE({
              id: String(eventId),
              event: 'done',
              data: '',
            });
            controller.enqueue(encoder.encode(doneEvent));
            controller.close();
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
          // Controller may already be closed.
        }
      } finally {
        // Single release path: the reader must be unlocked exactly once so
        // the caller can inspect or reuse the underlying token stream after
        // this outer stream settles. Guarded by `readerReleased` so neither
        // the normal nor the error path can double-release.
        releaseReader();
      }
    },
    cancel() {
      reader?.cancel().catch(() => {});
      releaseReader();
    },
  });
}
