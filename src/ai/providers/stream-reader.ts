/**
 * Shared helper for the streaming fetch-body readers in the OpenAI and
 * Anthropic providers. In Bun, `ReadableStreamDefaultReader.cancel()` does
 * NOT release the reader's lock on the underlying stream — only
 * `releaseLock()` does. Callers that only invoke `cancel()` can leave the
 * response body pinned even though the stream itself is drained, preventing
 * GC of buffered network chunks.
 *
 * This helper awaits `cancel()` first so any pending read operation on the
 * reader is fully settled before calling `releaseLock()` — calling
 * `releaseLock()` while a read is in-flight throws a `TypeError` and leaves
 * the stream locked forever. Both steps swallow errors because the reader
 * may already be in a terminal state when we get here (consumer cancelled
 * the outer stream, source stream errored, etc.), and neither path should
 * crash the caller.
 *
 * @internal
 */
export async function releaseInnerReader(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  reason?: unknown,
): Promise<void> {
  try {
    await reader.cancel(reason);
  } catch {
    // Ignore: reader is already in a terminal state.
  }
  try {
    reader.releaseLock();
  } catch {
    // Ignore: lock was already released or the reader is in a terminal state.
  }
}
