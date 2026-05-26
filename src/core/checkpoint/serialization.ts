import { decode, encode } from '../codec.ts';
import { validateSessionStateLocals } from '../session-state.ts';
import type { Checkpoint, Serializer } from '../types.ts';
import {
  CURRENT_CHECKPOINT_SCHEMA_VERSION,
  CheckpointSchemaVersionError,
  WORKER_REPLAY_SIGNATURE_FORMAT,
} from '../types/checkpoint.ts';

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

export function validateCheckpointShape(value: unknown): asserts value is Checkpoint {
  const record = assertCheckpointRecord(value);
  assertStringField(record, 'workflowId');
  assertNumberField(record, 'step');
  assertRecordField(record, 'locals');
  validateSessionStateLocals(record['locals'] as Record<string, unknown>);
  normalizeAccumulatedResults(record);
  validateWorkerReplaySignatures(record);
  assertArrayField(record, 'pendingSignals');
  assertRecordField(record, 'searchAttributes');
  assertStringField(record, 'version');
  assertNumberField(record, 'createdAt');
  assertCurrentSchemaVersion(record);
}

function validateWorkerReplaySignatures(record: Record<string, unknown>): void {
  if (!('workerReplaySignatures' in record) || record['workerReplaySignatures'] === undefined) {
    return;
  }

  const signatures = record['workerReplaySignatures'];
  if (!Array.isArray(signatures)) {
    throw new Error('Invalid checkpoint: invalid "workerReplaySignatures" (expected array)');
  }

  for (const entry of signatures) {
    validateWorkerReplaySignatureEntry(entry);
  }
}

function validateWorkerReplaySignatureEntry(value: unknown): void {
  if (!Array.isArray(value) || value.length !== 2) {
    throw new Error('Invalid checkpoint: invalid "workerReplaySignatures" entry');
  }

  const [step, signature] = value;
  validateWorkerReplaySignatureStep(step);
  validateWorkerReplaySignatureRecord(assertWorkerReplaySignatureRecord(signature));
}

function validateWorkerReplaySignatureStep(step: unknown): void {
  if (typeof step !== 'number' || !Number.isSafeInteger(step) || step < 0) {
    throw new Error('Invalid checkpoint: invalid "workerReplaySignatures" step');
  }
}

function assertWorkerReplaySignatureRecord(signature: unknown): Record<string, unknown> {
  if (typeof signature !== 'object' || signature === null) {
    throw new Error('Invalid checkpoint: invalid "workerReplaySignatures" signature');
  }
  return signature as Record<string, unknown>;
}

function validateWorkerReplaySignatureRecord(record: Record<string, unknown>): void {
  if (record['format'] !== WORKER_REPLAY_SIGNATURE_FORMAT) {
    throw new Error('Invalid checkpoint: invalid "workerReplaySignatures" format');
  }
  if (typeof record['operationType'] !== 'string') {
    throw new Error('Invalid checkpoint: invalid "workerReplaySignatures" operationType');
  }
  if (typeof record['stableFieldsDigest'] !== 'string') {
    throw new Error('Invalid checkpoint: invalid "workerReplaySignatures" stableFieldsDigest');
  }
  validateWorkerReplaySignatureByteLength(record['stableFieldsByteLength']);
}

function validateWorkerReplaySignatureByteLength(value: unknown): void {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new Error('Invalid checkpoint: invalid "workerReplaySignatures" stableFieldsByteLength');
  }
}

function assertCheckpointRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null) {
    throw new Error('Invalid checkpoint: expected an object');
  }

  return value as Record<string, unknown>;
}

function assertStringField(record: Record<string, unknown>, field: string): void {
  if (typeof record[field] !== 'string') {
    throw new Error(`Invalid checkpoint: missing or invalid "${field}" (expected string)`);
  }
}

function assertNumberField(record: Record<string, unknown>, field: string): void {
  if (typeof record[field] !== 'number') {
    throw new Error(`Invalid checkpoint: missing or invalid "${field}" (expected number)`);
  }
}

function assertRecordField(record: Record<string, unknown>, field: string): void {
  if (typeof record[field] !== 'object' || record[field] === null) {
    throw new Error(`Invalid checkpoint: missing or invalid "${field}" (expected object)`);
  }
}

function assertArrayField(record: Record<string, unknown>, field: string): void {
  if (!Array.isArray(record[field])) {
    throw new Error(`Invalid checkpoint: missing or invalid "${field}" (expected array)`);
  }
}

function normalizeAccumulatedResults(record: Record<string, unknown>): void {
  if (!('accumulatedResults' in record)) {
    record['accumulatedResults'] = [];
    return;
  }

  if (!Array.isArray(record['accumulatedResults'])) {
    throw new Error('Invalid checkpoint: invalid "accumulatedResults" (expected array)');
  }
}

function assertCurrentSchemaVersion(record: Record<string, unknown>): void {
  const schemaVersion = record['schemaVersion'];
  if (schemaVersion === undefined) {
    throw new CheckpointSchemaVersionError('pre-versioned', CURRENT_CHECKPOINT_SCHEMA_VERSION);
  }
  if (typeof schemaVersion !== 'number' || !Number.isSafeInteger(schemaVersion)) {
    throw new Error(
      'Invalid checkpoint: missing or invalid "schemaVersion" (expected integer number)',
    );
  }
  if (schemaVersion !== CURRENT_CHECKPOINT_SCHEMA_VERSION) {
    throw new CheckpointSchemaVersionError(schemaVersion, CURRENT_CHECKPOINT_SCHEMA_VERSION);
  }
}
