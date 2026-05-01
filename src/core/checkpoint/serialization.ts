import { decode, encode } from '../codec.ts';
import { validateSessionStateLocals } from '../session-state.ts';
import type { Checkpoint, Serializer } from '../types.ts';

/**
 * Serialize a Checkpoint to bytes.
 *
 * @example
 * ```ts
 * import { createCheckpoint, serializeCheckpoint } from 'weft';
 *
 * const checkpoint = createCheckpoint('wf-123', '1.0.0');
 * const bytes = serializeCheckpoint(checkpoint);
 * console.log(bytes instanceof Uint8Array); // true
 * console.log(bytes.byteLength > 0);        // true
 * ```
 */
export function serializeCheckpoint(checkpoint: Checkpoint, serializer?: Serializer): Uint8Array {
  if (serializer) {
    return serializer.serialize(checkpoint);
  }
  return encode(checkpoint);
}

/**
 * Deserialize bytes to a Checkpoint. Throws if invalid.
 *
 * @example
 * ```ts
 * import { createCheckpoint, serializeCheckpoint, deserializeCheckpoint } from 'weft';
 *
 * const checkpoint = createCheckpoint('wf-456', '1.0.0');
 * const bytes = serializeCheckpoint(checkpoint);
 * const restored = deserializeCheckpoint(bytes);
 * console.log(restored.workflowId); // 'wf-456'
 * console.log(restored.step);       // 0
 * ```
 */
export function deserializeCheckpoint(bytes: Uint8Array, serializer?: Serializer): Checkpoint {
  let decoded: unknown;

  if (serializer) {
    decoded = serializer.deserialize(bytes);
  } else {
    decoded = decode(bytes);
  }

  validateCheckpointShape(decoded);
  return decoded;
}

// ---------------------------------------------------------------------------
// Shape validation (internal)
// ---------------------------------------------------------------------------

// oxlint-disable-next-line complexity -- ID:core-checkpoint-validate-checkpoint-shape-complexity
export function validateCheckpointShape(value: unknown): asserts value is Checkpoint {
  if (typeof value !== 'object' || value === null) {
    throw new Error('Invalid checkpoint: expected an object');
  }

  const record = value as Record<string, unknown>;

  if (typeof record['workflowId'] !== 'string') {
    throw new Error('Invalid checkpoint: missing or invalid "workflowId" (expected string)');
  }

  if (typeof record['step'] !== 'number') {
    throw new Error('Invalid checkpoint: missing or invalid "step" (expected number)');
  }

  if (typeof record['locals'] !== 'object' || record['locals'] === null) {
    throw new Error('Invalid checkpoint: missing or invalid "locals" (expected object)');
  }

  validateSessionStateLocals(record['locals'] as Record<string, unknown>);

  // Backwards compatibility: treat missing accumulatedResults as empty
  if (!('accumulatedResults' in record)) {
    record['accumulatedResults'] = [];
  } else if (!Array.isArray(record['accumulatedResults'])) {
    throw new Error('Invalid checkpoint: invalid "accumulatedResults" (expected array)');
  }

  if (!Array.isArray(record['pendingSignals'])) {
    throw new Error('Invalid checkpoint: missing or invalid "pendingSignals" (expected array)');
  }

  if (typeof record['searchAttributes'] !== 'object' || record['searchAttributes'] === null) {
    throw new Error('Invalid checkpoint: missing or invalid "searchAttributes" (expected object)');
  }

  if (typeof record['version'] !== 'string') {
    throw new Error('Invalid checkpoint: missing or invalid "version" (expected string)');
  }

  if (typeof record['createdAt'] !== 'number') {
    throw new Error('Invalid checkpoint: missing or invalid "createdAt" (expected number)');
  }
}
