import { KEYS } from '../../storage/interface.ts';
import { decode, encode } from '../codec.ts';
import type {
  ContextOperationRequest,
  StoredStreamChunk,
  StreamReference,
  StreamSink,
} from '../context.ts';
import { cleanupPartialStreamChunks, createCleanupErrorReporter } from '../engine-helpers.ts';
import type { EngineInternals } from './internals.ts';
import { STREAM_CHUNK_KIND, TOKENS_STREAM_KEY, notifyWorkflowFeedCommit } from './workflow-feed.ts';

type StreamOperation = Extract<ContextOperationRequest, { type: 'stream' }>;

export type StreamOperationCallbacks = {
  runOperationWithResult: (
    workflowId: string,
    operation: StreamOperation,
    execute: () => Promise<unknown>,
  ) => Promise<void>;
  handleCleanupError: (source: string, error: unknown, workflowId?: string) => void;
};

export async function getStreamChunksFromInternals(
  internals: EngineInternals,
  workflowId: string,
  key: string,
  options?: { after?: number },
): Promise<StoredStreamChunk[]> {
  const after = options?.after;
  const prefix = KEYS.streamChunkPrefix(workflowId, key);
  const chunks: StoredStreamChunk[] = [];
  const scanOptions =
    after !== undefined && after >= 0
      ? { gt: KEYS.streamChunk(workflowId, key, after) }
      : undefined;

  for await (const [storageKey, chunkBytes] of internals.storage.scan(prefix, scanOptions)) {
    const sequenceText = storageKey.slice(prefix.length);
    const sequence = Number.parseInt(sequenceText, 10);
    if (!Number.isSafeInteger(sequence) || sequence < 0) {
      continue;
    }

    chunks.push({
      sequence,
      value: decode(chunkBytes),
    });
  }

  return chunks;
}

export async function processStreamOperation(
  internals: EngineInternals,
  workflowId: string,
  operation: StreamOperation,
  callbacks: StreamOperationCallbacks,
): Promise<void> {
  return callbacks.runOperationWithResult(workflowId, operation, () =>
    createStreamReferenceFromInternals(internals, workflowId, operation, callbacks),
  );
}

export async function createStreamReferenceFromInternals(
  internals: EngineInternals,
  workflowId: string,
  operation: StreamOperation,
  callbacks: Pick<StreamOperationCallbacks, 'handleCleanupError'>,
): Promise<StreamReference> {
  const sink: StreamSink = {
    heartbeat: (details?: unknown) => {
      internals.heartbeatDetails.set(workflowId, details);
    },
  };

  const writtenKeys: string[] = [];
  try {
    const streamSummary = await writeStreamChunksFromInternals(
      internals,
      workflowId,
      operation,
      operation.fn(sink),
      writtenKeys,
    );
    const reference: StreamReference = {
      key: operation.key,
      workflowId,
      chunkCount: streamSummary.chunkCount,
      totalSizeBytes: streamSummary.totalSizeBytes,
    };
    await internals.storage.put(KEYS.streamMetadata(workflowId, operation.key), encode(reference));
    return reference;
  } catch (error) {
    await cleanupStreamChunksFromInternals(
      internals,
      workflowId,
      operation.key,
      writtenKeys,
      callbacks,
    );
    throw error;
  }
}

export async function writeStreamChunksFromInternals(
  internals: EngineInternals,
  workflowId: string,
  operation: StreamOperation,
  asyncGenerator: AsyncGenerator<unknown, void, unknown>,
  writtenKeys: string[],
): Promise<{ chunkCount: number; totalSizeBytes: number }> {
  let chunkCount = 0;
  let totalSizeBytes = 0;

  for await (const chunk of asyncGenerator) {
    const encoded = encode(chunk);
    const sequence = chunkCount;
    const chunkKey = KEYS.streamChunk(workflowId, operation.key, sequence);
    await internals.storage.put(chunkKey, encoded);
    writtenKeys.push(chunkKey);
    totalSizeBytes += encoded.byteLength;
    chunkCount++;
    // Use wallclock `Date.now()` rather than the engine's `getNow`
    // hook: stream chunks carry no durable timestamp, and perturbing
    // the injected clock that tests use to assert timeline durations
    // would silently affect unrelated test expectations.
    // Only the `tokens` stream key is surfaced through the feed
    // backend's `tokens` selector. Other stream keys are internal to the
    // workflow and don't have a feed mount, so firing notifications for them
    // would just burn CPU walking empty listener buckets.
    if (operation.key === TOKENS_STREAM_KEY) {
      notifyWorkflowFeedCommit(internals, workflowId, 'tokens', {
        workflowId,
        selector: 'tokens',
        kind: STREAM_CHUNK_KIND,
        sequence,
        // Stream chunks carry no durable timestamp. `Date.now()`
        // rather than `internals.options.getNow()` avoids perturbing
        // the injected clock that tests use to assert timeline
        // durations.
        timestamp: Date.now(),
        payload: chunk,
      });
    }
  }

  return { chunkCount, totalSizeBytes };
}

export async function cleanupStreamChunksFromInternals(
  internals: EngineInternals,
  workflowId: string,
  key: string,
  writtenKeys: string[],
  callbacks: Pick<StreamOperationCallbacks, 'handleCleanupError'>,
): Promise<void> {
  await cleanupPartialStreamChunks(
    internals.storage,
    workflowId,
    key,
    writtenKeys,
    createCleanupErrorReporter(callbacks.handleCleanupError, workflowId),
  );
}
