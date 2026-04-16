import { describe, expect, it } from 'bun:test';

import { buildWorkflowRetentionRows, formatRetentionDuration } from './workflow-retention.ts';

describe('workflow retention utilities', () => {
  it('formats retention durations for dashboard display', () => {
    expect(formatRetentionDuration({ completed: 300_000 })).toBe('completed 5m');
    expect(formatRetentionDuration({ completed: 300_000, failed: 3_600_000 })).toBe(
      'completed 5m, failed 1h',
    );
    expect(formatRetentionDuration(null)).toBe('Not configured');
  });

  it('Acceptance criteria: dashboard shows retention policy per workflow type and next scheduled sweep', () => {
    const rows = buildWorkflowRetentionRows({
      sweepIntervalMs: 300_000,
      sweepBatchSize: 1000,
      nextSweepAt: 1_700_000_000_123,
      defaultRetention: { completed: 300_000 },
      workflowTypes: [
        {
          type: 'default-policy',
          source: 'engine',
          retention: { completed: 300_000 },
        },
        {
          type: 'workflow-override',
          source: 'workflow',
          retention: { completed: 3_600_000, failed: 7_200_000 },
        },
      ],
    });

    expect(rows.nextSweepAt).toBe('2023-11-14 22:13:20 UTC');
    expect(rows.workflowTypes).toEqual([
      {
        type: 'default-policy',
        source: 'Engine default',
        retention: 'completed 5m',
      },
      {
        type: 'workflow-override',
        source: 'Workflow override',
        retention: 'completed 1h, failed 2h',
      },
    ]);
  });
});
