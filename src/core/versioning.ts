/**
 * Workflow version comparison and checkpoint migration.
 *
 * Provides utilities for detecting version mismatches between stored
 * and registered workflow definitions, running checkpoint migrations,
 * and building atomic batch operations for version updates.
 *
 * @module versioning
 */

import type { BatchOperation } from '../storage/interface.ts';
import { KEYS } from '../storage/interface.ts';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Default version string assigned when no version is specified. */
export const DEFAULT_WORKFLOW_VERSION = '0.0.0';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type VersionCompatibility = 'compatible' | 'needs-migration' | 'resume-as-is';

// ---------------------------------------------------------------------------
// Version comparison
// ---------------------------------------------------------------------------

/**
 * Compare a stored workflow version with the currently registered version.
 *
 * - `"compatible"` — versions match; no action needed.
 * - `"needs-migration"` — versions differ and a migration function is available.
 * - `"resume-as-is"` — versions differ but no migration is available; the
 *   workflow will resume with the existing checkpoint as-is.
 */
export function checkVersionCompatibility(
  storedVersion: string,
  registeredVersion: string,
  hasMigration: boolean,
): VersionCompatibility {
  if (storedVersion === registeredVersion) {
    return 'compatible';
  }

  return hasMigration ? 'needs-migration' : 'resume-as-is';
}

// ---------------------------------------------------------------------------
// Checkpoint migration
// ---------------------------------------------------------------------------

/**
 * Run a migration function on checkpoint data, transforming it from one
 * version to another.
 *
 * The caller is responsible for serializing the result back to bytes if needed.
 */
export function migrateCheckpoint(
  checkpointData: unknown,
  fromVersion: string,
  _toVersion: string,
  migrate: (checkpoint: unknown, fromVersion: string) => unknown,
): unknown {
  return migrate(checkpointData, fromVersion);
}

// ---------------------------------------------------------------------------
// Batch operations for atomic version updates
// ---------------------------------------------------------------------------

/**
 * Build batch operations that atomically update the checkpoint and workflow
 * state after a successful migration.
 *
 * The returned operations are suitable for passing to `Storage.batch()`.
 */
export function buildVersionUpdateOperations(
  workflowId: string,
  newCheckpointBytes: Uint8Array,
  _newVersion: string,
  workflowStateBytes: Uint8Array,
): BatchOperation[] {
  return [
    { type: 'put', key: KEYS.checkpoint(workflowId), value: newCheckpointBytes },
    { type: 'put', key: KEYS.workflow(workflowId), value: workflowStateBytes },
  ];
}

// ---------------------------------------------------------------------------
// Checkpoint shape diffing
// ---------------------------------------------------------------------------

/** Description of a single field-level difference between checkpoint shapes. */
export type FieldDiff =
  | { field: string; change: 'added'; newType: string }
  | { field: string; change: 'removed'; oldType: string }
  | { field: string; change: 'type-changed'; oldType: string; newType: string };

/** Shape descriptor: maps field names to their type names (e.g., `"string"`, `"object"`). */
export type ShapeDescriptor = Record<string, string>;

/**
 * Compare two checkpoint shape descriptors and return the field-level diffs.
 *
 * Returns an empty array when the shapes are identical.
 */
export function diffCheckpointShapes(
  oldShape: ShapeDescriptor,
  newShape: ShapeDescriptor,
): FieldDiff[] {
  const diffs: FieldDiff[] = [];
  const allKeys = new Set([...Object.keys(oldShape), ...Object.keys(newShape)]);

  for (const key of allKeys) {
    const inOld = key in oldShape;
    const inNew = key in newShape;

    if (inOld && !inNew) {
      diffs.push({ field: key, change: 'removed', oldType: oldShape[key]! });
    } else if (!inOld && inNew) {
      diffs.push({ field: key, change: 'added', newType: newShape[key]! });
    } else if (inOld && inNew && oldShape[key] !== newShape[key]) {
      diffs.push({
        field: key,
        change: 'type-changed',
        oldType: oldShape[key]!,
        newType: newShape[key]!,
      });
    }
  }

  return diffs;
}

/**
 * Infer a shape descriptor from an arbitrary value by walking its top-level keys
 * and recording the `typeof` of each value.
 */
export function inferShape(value: unknown): ShapeDescriptor {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return {};
  }
  const shape: ShapeDescriptor = {};
  for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
    shape[key] = val === null ? 'null' : Array.isArray(val) ? 'array' : typeof val;
  }
  return shape;
}

/** Format field diffs into a human-readable summary. */
function formatFieldDiffs(diffs: FieldDiff[]): string {
  if (diffs.length === 0) return '';

  const lines = diffs.map((diff) => {
    switch (diff.change) {
      case 'added':
        return `  - field \`${diff.field}\` was added (type: ${diff.newType})`;
      case 'removed':
        return `  - field \`${diff.field}\` was removed (was: ${diff.oldType})`;
      case 'type-changed':
        return `  - field \`${diff.field}\` changed type: ${diff.oldType} → ${diff.newType}`;
    }
  });

  return `\nCheckpoint shape changes:\n${lines.join('\n')}`;
}

// ---------------------------------------------------------------------------
// Error
// ---------------------------------------------------------------------------

/** Options for providing shape information to VersionMismatchError. */
export type ShapeDiffOptions = {
  oldShape: ShapeDescriptor;
  newShape: ShapeDescriptor;
};

/**
 * Thrown when a workflow's stored version does not match its registered
 * version and no migration path is available or the migration failed.
 *
 * When shape information is provided, the error message includes a
 * field-level diff describing exactly which fields changed.
 */
export class VersionMismatchError extends Error {
  readonly workflowId: string;
  readonly storedVersion: string;
  readonly registeredVersion: string;
  readonly workflowType: string;
  readonly fieldDiffs: FieldDiff[] | undefined;

  constructor(
    workflowId: string,
    workflowType: string,
    storedVersion: string,
    registeredVersion: string,
    shapeDiff?: ShapeDiffOptions,
  ) {
    const diffs = shapeDiff
      ? diffCheckpointShapes(shapeDiff.oldShape, shapeDiff.newShape)
      : undefined;

    const baseMessage =
      `Version mismatch for workflow "${workflowType}" (${workflowId}): ` +
      `stored version ${storedVersion} does not match registered version ${registeredVersion}`;

    const diffSuffix = diffs && diffs.length > 0 ? formatFieldDiffs(diffs) : '';

    super(baseMessage + diffSuffix);
    this.name = 'VersionMismatchError';
    this.workflowId = workflowId;
    this.workflowType = workflowType;
    this.storedVersion = storedVersion;
    this.registeredVersion = registeredVersion;
    this.fieldDiffs = diffs;
  }
}
