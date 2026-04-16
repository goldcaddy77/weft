import type { RetentionOverview, RetentionPolicy } from '../api-client.ts';

const RETENTION_STATUS_LABELS: Array<keyof RetentionPolicy> = [
  'completed',
  'failed',
  'cancelled',
  'timedOut',
];

function formatRetentionMilliseconds(milliseconds: number): string {
  if (milliseconds % 86_400_000 === 0) {
    return `${milliseconds / 86_400_000}d`;
  }
  if (milliseconds % 3_600_000 === 0) {
    return `${milliseconds / 3_600_000}h`;
  }
  if (milliseconds % 60_000 === 0) {
    return `${milliseconds / 60_000}m`;
  }
  if (milliseconds % 1000 === 0) {
    return `${milliseconds / 1000}s`;
  }
  return `${milliseconds}ms`;
}

export function formatRetentionDuration(retention: RetentionPolicy | null): string {
  if (retention === null) {
    return 'Not configured';
  }

  const segments: string[] = [];
  for (const key of RETENTION_STATUS_LABELS) {
    const value = retention[key];
    if (value === undefined) continue;

    const label = key === 'timedOut' ? 'timed out' : key;
    segments.push(`${label} ${formatRetentionMilliseconds(value)}`);
  }

  return segments.length > 0 ? segments.join(', ') : 'Not configured';
}

function formatNextSweepAt(nextSweepAt: number | null): string {
  if (nextSweepAt === null) {
    return 'Not scheduled';
  }

  return new Date(nextSweepAt)
    .toISOString()
    .replace('T', ' ')
    .replace(/\.\d{3}Z$/, ' UTC');
}

export function buildWorkflowRetentionRows(overview: RetentionOverview): {
  nextSweepAt: string;
  workflowTypes: Array<{ type: string; source: string; retention: string }>;
} {
  return {
    nextSweepAt: formatNextSweepAt(overview.nextSweepAt),
    workflowTypes: overview.workflowTypes.map((workflowType) => ({
      type: workflowType.type,
      source:
        workflowType.source === 'engine'
          ? 'Engine default'
          : workflowType.source === 'workflow'
            ? 'Workflow override'
            : 'Not configured',
      retention: formatRetentionDuration(workflowType.retention),
    })),
  };
}
