/**
 * Recommendation engine for Weft diagnostics.
 *
 * Analyzes database health, workflow statistics, and queue statistics
 * to produce actionable recommendations ordered by severity.
 *
 * @module diagnostics/recommendations
 */

import type {
  DatabaseHealth,
  QueueStatistics,
  Recommendation,
  WorkflowStatistics,
} from './types.ts';
import { THRESHOLDS } from './types.ts';

/**
 * Generate recommendations based on diagnostic data.
 *
 * Rules are checked in a fixed order so that the most critical issues
 * appear first in the returned array.
 *
 * @example
 * ```ts
 * import { MemoryStorage, collectDiagnostics, generateRecommendations } from 'weft';
 *
 * await using storage = new MemoryStorage();
 * const report = await collectDiagnostics(storage, ':memory:');
 * const recs = generateRecommendations({
 *   database: report.database,
 *   workflows: report.workflows,
 *   queues: report.queues,
 * });
 * console.log(recs.length); // 0 for a healthy instance
 * ```
 */
export function generateRecommendations(
  report: {
    database: DatabaseHealth;
    workflows: WorkflowStatistics;
    queues: QueueStatistics[];
  },
  thresholds?: Partial<{ [K in keyof typeof THRESHOLDS]: number }>,
): Recommendation[] {
  const merged = { ...THRESHOLDS, ...thresholds };
  const recommendations: Recommendation[] = [];

  const { database, workflows, queues } = report;

  // 1. Integrity failure
  if (!database.integrityOk) {
    recommendations.push({
      severity: 'critical',
      section: 'database',
      message: `Database integrity check failed: ${database.integrityError}`,
    });
  }

  // 2 & 3. Database size (critical > 95%, warning > 80%, but not both)
  if (database.sizeLimitBytes > 0) {
    const fraction = database.sizeBytes / database.sizeLimitBytes;
    if (fraction > merged.databaseSizeCriticalFraction) {
      recommendations.push({
        severity: 'critical',
        section: 'database',
        message: `Database is at ${(fraction * 100).toFixed(1)}% capacity (${formatBytes(database.sizeBytes)} / ${formatBytes(database.sizeLimitBytes)}).`,
      });
    } else if (fraction > merged.databaseSizeWarningFraction) {
      recommendations.push({
        severity: 'warning',
        section: 'database',
        message: `Database is at ${(fraction * 100).toFixed(1)}% capacity (${formatBytes(database.sizeBytes)} / ${formatBytes(database.sizeLimitBytes)}).`,
      });
    }
  }

  // 4. WAL size
  if (database.walSizeBytes !== null && database.walSizeBytes > merged.walSizeWarningBytes) {
    recommendations.push({
      severity: 'warning',
      section: 'database',
      message: `WAL file is ${formatBytes(database.walSizeBytes)}, which may indicate stalled checkpointing.`,
    });
  }

  // 5. Fragmentation
  if (database.fragmentationPercent > merged.fragmentationVacuumPercent) {
    recommendations.push({
      severity: 'warning',
      section: 'database',
      message: `Database fragmentation is ${database.fragmentationPercent.toFixed(1)}%. Running VACUUM is recommended.`,
    });
  }

  // 6. Long-running workflow
  if (
    workflows.longestRunning &&
    workflows.longestRunning.elapsedMilliseconds > merged.longRunningWorkflowMilliseconds
  ) {
    recommendations.push({
      severity: 'warning',
      section: 'workflows',
      message: `Workflow "${workflows.longestRunning.id}" has been running for ${formatDuration(workflows.longestRunning.elapsedMilliseconds)}. Consider setting an executionTimeout to prevent runaway workflows.`,
    });
  }

  // 7. Large checkpoint
  if (
    workflows.largestCheckpoint &&
    workflows.largestCheckpoint.sizeBytes > merged.largeCheckpointBytes
  ) {
    recommendations.push({
      severity: 'warning',
      section: 'workflows',
      message: `Workflow "${workflows.largestCheckpoint.workflowId}" has a ${formatBytes(workflows.largestCheckpoint.sizeBytes)} checkpoint. Consider reducing state size to improve serialization performance.`,
    });
  }

  // 8. Queues with pending work but nothing in-flight
  for (const queue of queues) {
    if (queue.pendingCount > 0 && queue.inflightCount === 0) {
      recommendations.push({
        severity: 'warning',
        section: 'activities',
        message: `Queue "${queue.name}" has ${queue.pendingCount} pending operation(s) but nothing in-flight. Workers may be stopped or disconnected.`,
      });
    }
  }

  return recommendations;
}

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

function formatDuration(milliseconds: number): string {
  const seconds = Math.floor(milliseconds / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);

  if (days > 0) return `${days}d ${hours % 24}h`;
  if (hours > 0) return `${hours}h ${minutes % 60}m`;
  if (minutes > 0) return `${minutes}m ${seconds % 60}s`;
  return `${seconds}s`;
}
