/**
 * Shared types and threshold constants for Weft diagnostic commands.
 *
 * Used by `weft doctor` (database health, workflow stats, queue depths,
 * recommendations) and `weft version:check` (version compatibility analysis).
 *
 * @module diagnostics/types
 */

import type { VersionCompatibility } from '../core/versioning.ts';

// ---------------------------------------------------------------------------
// Health status
// ---------------------------------------------------------------------------

export type HealthStatus = 'healthy' | 'warning' | 'critical';

// ---------------------------------------------------------------------------
// Database diagnostics
// ---------------------------------------------------------------------------

export interface DatabaseHealth {
  sizeBytes: number;
  sizeLimitBytes: number;
  walSizeBytes: number | null;
  integrityOk: boolean;
  integrityError: string | null;
  fragmentationPercent: number;
  journalMode: string;
  pageCount: number;
  pageSize: number;
  freelistCount: number;
}

// ---------------------------------------------------------------------------
// Workflow diagnostics
// ---------------------------------------------------------------------------

export interface WorkflowStatusCounts {
  pending: number;
  running: number;
  completed: number;
  failed: number;
  cancelled: number;
  timedOut: number;
}

export interface LongestRunningWorkflow {
  id: string;
  type: string;
  startedAt: number;
  elapsedMilliseconds: number;
  currentStep: number;
}

export interface LargestCheckpoint {
  workflowId: string;
  sizeBytes: number;
}

export interface WorkflowStatistics {
  total: number;
  statusCounts: WorkflowStatusCounts;
  longestRunning: LongestRunningWorkflow | null;
  largestCheckpoint: LargestCheckpoint | null;
}

// ---------------------------------------------------------------------------
// Queue diagnostics
// ---------------------------------------------------------------------------

export interface QueueStatistics {
  name: string;
  pendingCount: number;
  inflightCount: number;
}

// ---------------------------------------------------------------------------
// Recommendations
// ---------------------------------------------------------------------------

export type RecommendationSeverity = 'info' | 'warning' | 'critical';

export interface Recommendation {
  severity: RecommendationSeverity;
  message: string;
  section: 'database' | 'workflows' | 'activities';
}

// ---------------------------------------------------------------------------
// Top-level diagnostic report (weft doctor)
// ---------------------------------------------------------------------------

export interface DiagnosticReport {
  timestamp: number;
  databasePath: string;
  database: DatabaseHealth;
  workflows: WorkflowStatistics;
  queues: QueueStatistics[];
  recommendations: Recommendation[];
}

// ---------------------------------------------------------------------------
// Version check report (weft version:check)
// ---------------------------------------------------------------------------

export interface WorkflowTypeReport {
  type: string;
  storedVersion: string;
  registeredVersion: string;
  runningCount: number;
  compatibility: VersionCompatibility;
  hasMigration: boolean;
}

export interface VersionCheckReport {
  workflowTypes: WorkflowTypeReport[];
  overallVerdict: 'safe' | 'unsafe' | 'needs-migration';
}

// ---------------------------------------------------------------------------
// Thresholds (tunable constants)
// ---------------------------------------------------------------------------

export const THRESHOLDS = {
  /** Fragmentation percent above which VACUUM is recommended. */
  fragmentationVacuumPercent: 20,

  /** WAL size in bytes above which a warning is emitted. */
  walSizeWarningBytes: 100 * 1024 * 1024,

  /** Database size as fraction of limit that triggers a warning. */
  databaseSizeWarningFraction: 0.8,

  /** Database size as fraction of limit that triggers critical. */
  databaseSizeCriticalFraction: 0.95,

  /** Workflow running duration (ms) above which a warning is emitted. */
  longRunningWorkflowMilliseconds: 7 * 24 * 60 * 60 * 1000,

  /** Checkpoint size in bytes above which a warning is emitted. */
  largeCheckpointBytes: 512 * 1024,

  /** Default assumed database size limit (10 GB). */
  defaultDatabaseSizeLimitBytes: 10 * 1024 * 1024 * 1024,
} as const;
