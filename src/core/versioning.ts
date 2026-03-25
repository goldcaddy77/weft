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
// Error
// ---------------------------------------------------------------------------

/**
 * Thrown when a workflow's stored version does not match its registered
 * version and no migration path is available or the migration failed.
 */
export class VersionMismatchError extends Error {
  readonly workflowId: string;
  readonly storedVersion: string;
  readonly registeredVersion: string;
  readonly workflowType: string;

  constructor(
    workflowId: string,
    workflowType: string,
    storedVersion: string,
    registeredVersion: string,
  ) {
    super(
      `Version mismatch for workflow "${workflowType}" (${workflowId}): ` +
        `stored version ${storedVersion} does not match registered version ${registeredVersion}`,
    );
    this.name = 'VersionMismatchError';
    this.workflowId = workflowId;
    this.workflowType = workflowType;
    this.storedVersion = storedVersion;
    this.registeredVersion = registeredVersion;
  }
}
