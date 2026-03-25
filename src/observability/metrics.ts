/**
 * Metric definitions for Weft observability.
 *
 * These constants describe the metrics emitted by Weft interceptors. They
 * follow OpenTelemetry semantic conventions where applicable, and can be
 * consumed by any metrics backend that accepts name/description/unit tuples.
 *
 * @module metrics
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type MetricType = 'counter' | 'gauge' | 'histogram';

export interface MetricDefinition {
  name: string;
  description: string;
  unit: string;
  type: MetricType;
}

// ---------------------------------------------------------------------------
// Metric catalogue
// ---------------------------------------------------------------------------

/** Metric names and descriptions for Weft observability. */
export const METRICS = {
  workflowDuration: {
    name: 'weft.workflow.duration',
    description: 'Duration of workflow execution in milliseconds',
    unit: 'ms',
    type: 'histogram' as const,
  },
  activityDuration: {
    name: 'weft.activity.duration',
    description: 'Duration of activity execution in milliseconds',
    unit: 'ms',
    type: 'histogram' as const,
  },
  activityAttempts: {
    name: 'weft.activity.attempts',
    description: 'Number of attempts per activity',
    unit: 'attempts',
    type: 'histogram' as const,
  },
  workflowActive: {
    name: 'weft.workflow.active',
    description: 'Number of currently active workflows',
    unit: 'workflows',
    type: 'gauge' as const,
  },
  workflowStarted: {
    name: 'weft.workflow.started',
    description: 'Total workflows started',
    unit: 'workflows',
    type: 'counter' as const,
  },
  workflowCompleted: {
    name: 'weft.workflow.completed',
    description: 'Total workflows completed',
    unit: 'workflows',
    type: 'counter' as const,
  },
  workflowFailed: {
    name: 'weft.workflow.failed',
    description: 'Total workflows failed',
    unit: 'workflows',
    type: 'counter' as const,
  },
} as const;
