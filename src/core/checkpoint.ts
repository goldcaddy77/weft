/**
 * Checkpoint serialization, deserialization, creation, advancement,
 * and development-mode validation.
 *
 * @module checkpoint
 */

import { decode, encode, validateCloneable } from './codec.ts';
import { validateSessionStateLocals } from './session-state.ts';
import type { Checkpoint, SearchAttributeValue, Serializer, WorkflowId } from './types.ts';

// ---------------------------------------------------------------------------
// Public interfaces
// ---------------------------------------------------------------------------

export interface CheckpointValidationResult {
  valid: boolean;
  divergences: CheckpointDivergence[];
  sizeBytes: number;
}

export interface CheckpointDivergence {
  path: string;
  original: unknown;
  deserialized: unknown;
  suggestion: string;
}

// ---------------------------------------------------------------------------
// Serialization
// ---------------------------------------------------------------------------

/** Serialize a Checkpoint to bytes. */
export function serializeCheckpoint(checkpoint: Checkpoint, serializer?: Serializer): Uint8Array {
  if (serializer) {
    return serializer.serialize(checkpoint);
  }
  return encode(checkpoint);
}

/** Deserialize bytes to a Checkpoint. Throws if invalid. */
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
// Creation and advancement
// ---------------------------------------------------------------------------

/** Create a fresh checkpoint for a new workflow. */
export function createCheckpoint(
  workflowId: WorkflowId,
  version: string,
  now?: number,
): Checkpoint {
  return {
    workflowId,
    step: 0,
    locals: {},
    accumulatedResults: [],
    pendingSignals: [],
    searchAttributes: {},
    version,
    createdAt: now ?? Date.now(),
  };
}

/** Advance a checkpoint to the next step with new locals. */
export function advanceCheckpoint(
  checkpoint: Checkpoint,
  locals: Record<string, unknown>,
  options?: {
    searchAttributes?: Record<string, SearchAttributeValue>;
    accumulatedResults?: Array<[number, unknown]>;
    now?: number;
  },
): Checkpoint {
  return {
    workflowId: checkpoint.workflowId,
    step: checkpoint.step + 1,
    locals,
    accumulatedResults: options?.accumulatedResults ?? checkpoint.accumulatedResults,
    pendingSignals: checkpoint.pendingSignals,
    searchAttributes: {
      ...checkpoint.searchAttributes,
      ...options?.searchAttributes,
    },
    version: checkpoint.version,
    createdAt: options?.now ?? Date.now(),
  };
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

/** Development mode: validate checkpoint round-trips cleanly through serialization. */
export function validateCheckpointRoundTrip(
  checkpoint: Checkpoint,
  serializer?: Serializer,
): CheckpointValidationResult {
  // First, check for non-cloneable values
  const cloneResult = validateCloneable(checkpoint);
  if (!cloneResult.valid) {
    const divergences: CheckpointDivergence[] = cloneResult.errors.map((error) => ({
      path: error.path,
      original: error.value,
      deserialized: undefined,
      suggestion: error.suggestion,
    }));

    // Still compute size if possible, but use 0 if serialization would fail
    let sizeBytes = 0;
    try {
      sizeBytes = serializeCheckpoint(checkpoint, serializer).byteLength;
    } catch {
      // Serialization failed due to non-cloneable values; size stays 0
    }

    return { valid: false, divergences, sizeBytes };
  }

  // Serialize and deserialize
  const bytes = serializeCheckpoint(checkpoint, serializer);
  const restored = deserializeCheckpoint(bytes, serializer);

  // Deep compare
  const divergences: CheckpointDivergence[] = [];
  compareValues(checkpoint, restored, '', divergences);

  return {
    valid: divergences.length === 0,
    divergences,
    sizeBytes: bytes.byteLength,
  };
}

/** Get the serialized size of a checkpoint in bytes. */
export function checkpointSizeBytes(checkpoint: Checkpoint, serializer?: Serializer): number {
  return serializeCheckpoint(checkpoint, serializer).byteLength;
}

// ---------------------------------------------------------------------------
// Shape validation (internal)
// ---------------------------------------------------------------------------

function validateCheckpointShape(value: unknown): asserts value is Checkpoint {
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

// ---------------------------------------------------------------------------
// Deep comparison (internal)
// ---------------------------------------------------------------------------

function compareValues(
  original: unknown,
  deserialized: unknown,
  path: string,
  divergences: CheckpointDivergence[],
): void {
  // Same reference or both nullish
  if (original === deserialized) return;

  // Handle null/undefined
  if (
    original === null ||
    original === undefined ||
    deserialized === null ||
    deserialized === undefined
  ) {
    if (original !== deserialized) {
      divergences.push({
        path: path || '(root)',
        original,
        deserialized,
        suggestion: 'Value changed during serialization round-trip.',
      });
    }
    return;
  }

  if (compareDateValues(original, deserialized, path, divergences)) {
    return;
  }

  if (compareRegExpValues(original, deserialized, path, divergences)) {
    return;
  }

  if (compareMapValues(original, deserialized, path, divergences)) {
    return;
  }

  if (compareSetValues(original, deserialized, path, divergences)) {
    return;
  }

  // Type mismatch
  if (typeof original !== typeof deserialized) {
    divergences.push({
      path: path || '(root)',
      original,
      deserialized,
      suggestion: `Type changed from ${typeof original} to ${typeof deserialized} during round-trip.`,
    });
    return;
  }

  // Primitives
  if (typeof original !== 'object') {
    if (original !== deserialized) {
      divergences.push({
        path: path || '(root)',
        original,
        deserialized,
        suggestion: 'Primitive value changed during round-trip.',
      });
    }
    return;
  }

  if (Array.isArray(original) && Array.isArray(deserialized)) {
    compareArrayValues(original, deserialized, path, divergences);
    return;
  }

  compareRecordValues(
    original as Record<string, unknown>,
    deserialized as Record<string, unknown>,
    path,
    divergences,
  );
}

function checkpointPath(path: string): string {
  return path || '(root)';
}

function recordDivergence(
  divergences: CheckpointDivergence[],
  path: string,
  original: unknown,
  deserialized: unknown,
  suggestion: string,
): void {
  divergences.push({
    path: checkpointPath(path),
    original,
    deserialized,
    suggestion,
  });
}

function compareDateValues(
  original: unknown,
  deserialized: unknown,
  path: string,
  divergences: CheckpointDivergence[],
): boolean {
  if (!(original instanceof Date && deserialized instanceof Date)) {
    return false;
  }

  if (original.getTime() !== deserialized.getTime()) {
    recordDivergence(
      divergences,
      path,
      original,
      deserialized,
      'Date value changed during round-trip.',
    );
  }

  return true;
}

function compareRegExpValues(
  original: unknown,
  deserialized: unknown,
  path: string,
  divergences: CheckpointDivergence[],
): boolean {
  if (!(original instanceof RegExp && deserialized instanceof RegExp)) {
    return false;
  }

  if (original.source !== deserialized.source || original.flags !== deserialized.flags) {
    recordDivergence(
      divergences,
      path,
      original,
      deserialized,
      'RegExp value changed during round-trip.',
    );
  }

  return true;
}

function compareMapValues(
  original: unknown,
  deserialized: unknown,
  path: string,
  divergences: CheckpointDivergence[],
): boolean {
  if (!(original instanceof Map && deserialized instanceof Map)) {
    return false;
  }

  for (const [key] of original) {
    const keyPath = path ? `${path}.Map(${String(key)})` : `Map(${String(key)})`;
    if (!deserialized.has(key)) {
      recordDivergence(
        divergences,
        keyPath,
        original.get(key),
        undefined,
        'Map key missing after round-trip.',
      );
      continue;
    }

    compareValues(original.get(key), deserialized.get(key), keyPath, divergences);
  }

  for (const [key] of deserialized) {
    if (original.has(key)) {
      continue;
    }

    const keyPath = path ? `${path}.Map(${String(key)})` : `Map(${String(key)})`;
    recordDivergence(
      divergences,
      keyPath,
      undefined,
      deserialized.get(key),
      'Extra Map key appeared after round-trip.',
    );
  }

  return true;
}

function compareSetValues(
  original: unknown,
  deserialized: unknown,
  path: string,
  divergences: CheckpointDivergence[],
): boolean {
  if (!(original instanceof Set && deserialized instanceof Set)) {
    return false;
  }

  const originalValues = [...original.values()];
  const deserializedValues = [...deserialized.values()];
  if (originalValues.length !== deserializedValues.length) {
    recordDivergence(
      divergences,
      path,
      original,
      deserialized,
      'Set size changed during round-trip.',
    );
    return true;
  }

  for (let index = 0; index < originalValues.length; index++) {
    const elementPath = path ? `${path}.Set[${index}]` : `Set[${index}]`;
    compareValues(originalValues[index], deserializedValues[index], elementPath, divergences);
  }

  return true;
}

function compareArrayValues(
  original: unknown[],
  deserialized: unknown[],
  path: string,
  divergences: CheckpointDivergence[],
): void {
  const maxLength = Math.max(original.length, deserialized.length);
  for (let index = 0; index < maxLength; index++) {
    const elementPath = path ? `${path}[${index}]` : `[${index}]`;
    if (index >= original.length) {
      recordDivergence(
        divergences,
        elementPath,
        undefined,
        deserialized[index],
        'Extra array element appeared after round-trip.',
      );
      continue;
    }

    if (index >= deserialized.length) {
      recordDivergence(
        divergences,
        elementPath,
        original[index],
        undefined,
        'Array element missing after round-trip.',
      );
      continue;
    }

    compareValues(original[index], deserialized[index], elementPath, divergences);
  }
}

function compareRecordValues(
  original: Record<string, unknown>,
  deserialized: Record<string, unknown>,
  path: string,
  divergences: CheckpointDivergence[],
): void {
  const allKeys = new Set([...Object.keys(original), ...Object.keys(deserialized)]);

  for (const key of allKeys) {
    const propertyPath = path ? `${path}.${key}` : key;
    if (!(key in original)) {
      recordDivergence(
        divergences,
        propertyPath,
        undefined,
        deserialized[key],
        'Extra key appeared in deserialized object.',
      );
      continue;
    }

    if (!(key in deserialized)) {
      recordDivergence(
        divergences,
        propertyPath,
        original[key],
        undefined,
        'Key missing from deserialized object.',
      );
      continue;
    }

    compareValues(original[key], deserialized[key], propertyPath, divergences);
  }
}
