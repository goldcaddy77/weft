/**
 * Shared helper for the streaming fetch-body readers in the OpenAI and
 * Anthropic providers. In Bun, `ReadableStreamDefaultReader.cancel()` does
 * NOT release the reader's lock on the underlying stream — only
 * `releaseLock()` does. Callers that only invoke `cancel()` can leave the
 * response body pinned even though the stream itself is drained, preventing
 * GC of buffered network chunks.
 *
 * This helper performs both steps and swallows errors from either call: the
 * reader may already be in a terminal state by the time we get here (e.g.
 * the consumer cancelled the outer stream, or the source stream errored),
 * and neither path should crash the caller.
 *
 * @internal
 */
export function releaseInnerReader(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  reason?: unknown,
): void {
  reader.cancel(reason).catch(() => {});
  try {
    reader.releaseLock();
  } catch {
    // Ignore: lock was already released (e.g. cancel() resolved first) or
    // the reader is already in a terminal state.
  }
}
