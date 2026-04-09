/**
 * Tests for the weft validate design-time linter.
 *
 * Covers the three anti-pattern checks:
 * - unbounded-retry: maxAttempts = Infinity
 * - stateful-without-compensator: non-idempotent activity with no compensate
 * - (formatting) formatValidationReport produces expected output
 */

import { describe, expect, it } from 'bun:test';

import type { ActivityDefinition, WorkflowRegistration } from '../core/types.ts';
import { formatValidationReport, validateRegistrations } from './validate.ts';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeRegistration(_name: string): WorkflowRegistration {
  return {
    handler: async function* () {
      return 'done';
    },
  };
}

function makeActivity(
  name: string,
  overrides: Partial<ActivityDefinition> = {},
): ActivityDefinition {
  return {
    name,
    execute: async (input: unknown) => input,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// 1. Clean registrations pass with no issues
// ---------------------------------------------------------------------------

describe('validateRegistrations', () => {
  it('returns valid=true and no issues for a clean registration with no activities', () => {
    const registrations = { myWorkflow: makeRegistration('myWorkflow') };
    const report = validateRegistrations(registrations);

    expect(report.valid).toBe(true);
    expect(report.issues).toHaveLength(0);
    expect(report.workflowCount).toBe(1);
  });

  it('returns valid=true for an idempotent activity without compensator', () => {
    const registrations = { wf: makeRegistration('wf') };
    const activities: ActivityDefinition[] = [makeActivity('readDb', { idempotent: true })];

    const report = validateRegistrations(registrations, activities);
    expect(report.valid).toBe(true);
    expect(report.issues).toHaveLength(0);
  });

  it('returns valid=true for a non-idempotent activity that has a compensator', () => {
    const registrations = { wf: makeRegistration('wf') };
    const activities: ActivityDefinition[] = [
      makeActivity('charge', {
        idempotent: false,
        compensate: async () => {},
      }),
    ];

    const report = validateRegistrations(registrations, activities);
    expect(report.valid).toBe(true);
    expect(report.issues).toHaveLength(0);
  });

  // ---------------------------------------------------------------------------
  // 2. Unbounded retry
  // ---------------------------------------------------------------------------

  it('reports error for activity with maxAttempts = Infinity', () => {
    const registrations = { wf: makeRegistration('wf') };
    const activities: ActivityDefinition[] = [
      // idempotent: true to suppress the stateful-without-compensator warning,
      // so we can assert on exactly one issue (the unbounded-retry error).
      makeActivity('flaky', {
        idempotent: true,
        retry: {
          maxAttempts: Infinity,
          initialBackoff: '1s',
          backoffMultiplier: 2,
          maxBackoff: '30s',
        },
      }),
    ];

    const report = validateRegistrations(registrations, activities);
    expect(report.valid).toBe(false);
    expect(report.issues).toHaveLength(1);
    expect(report.issues[0]!.code).toBe('unbounded-retry');
    expect(report.issues[0]!.severity).toBe('error');
    expect(report.issues[0]!.activityName).toBe('flaky');
  });

  it('does not flag activity with finite maxAttempts', () => {
    const registrations = { wf: makeRegistration('wf') };
    const activities: ActivityDefinition[] = [
      makeActivity('reliable', {
        retry: { maxAttempts: 5, initialBackoff: '1s', backoffMultiplier: 2, maxBackoff: '30s' },
        compensate: async () => {},
      }),
    ];

    const report = validateRegistrations(registrations, activities);
    const retryIssues = report.issues.filter((i) => i.code === 'unbounded-retry');
    expect(retryIssues).toHaveLength(0);
  });

  // ---------------------------------------------------------------------------
  // 3. Stateful without compensator
  // ---------------------------------------------------------------------------

  it('reports warning for non-idempotent activity without compensator', () => {
    const registrations = { wf: makeRegistration('wf') };
    const activities: ActivityDefinition[] = [makeActivity('sendEmail', { idempotent: false })];

    const report = validateRegistrations(registrations, activities);
    expect(report.valid).toBe(true); // warnings don't set valid=false
    const issue = report.issues.find((i) => i.code === 'stateful-without-compensator');
    expect(issue).toBeDefined();
    expect(issue!.severity).toBe('warning');
    expect(issue!.activityName).toBe('sendEmail');
  });

  it('warnings do not make valid=false (only errors do)', () => {
    const registrations = { wf: makeRegistration('wf') };
    const activities: ActivityDefinition[] = [
      makeActivity('sideEffect', { idempotent: false }), // warning
    ];

    const report = validateRegistrations(registrations, activities);
    expect(report.valid).toBe(true);
    expect(report.issues.some((i) => i.severity === 'warning')).toBe(true);
    expect(report.issues.some((i) => i.severity === 'error')).toBe(false);
  });

  it('multiple issues accumulate across multiple activities', () => {
    const registrations = { wf: makeRegistration('wf') };
    const activities: ActivityDefinition[] = [
      makeActivity('a', {
        retry: {
          maxAttempts: Infinity,
          initialBackoff: '1s',
          backoffMultiplier: 2,
          maxBackoff: '30s',
        },
        compensate: async () => {},
      }),
      makeActivity('b', { idempotent: false }), // warning
      makeActivity('c', {
        retry: {
          maxAttempts: Infinity,
          initialBackoff: '1s',
          backoffMultiplier: 2,
          maxBackoff: '30s',
        },
        idempotent: false,
      }), // both error + warning
    ];

    const report = validateRegistrations(registrations, activities);
    expect(report.valid).toBe(false);
    const errors = report.issues.filter((i) => i.severity === 'error');
    const warnings = report.issues.filter((i) => i.severity === 'warning');
    expect(errors.length).toBeGreaterThanOrEqual(2);
    expect(warnings.length).toBeGreaterThanOrEqual(1);
  });

  it('empty registrations and no activities returns valid with 0 workflows', () => {
    const report = validateRegistrations({});
    expect(report.valid).toBe(true);
    expect(report.workflowCount).toBe(0);
    expect(report.issues).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// 4. formatValidationReport
// ---------------------------------------------------------------------------

describe('formatValidationReport', () => {
  it('shows no-issues message when report is clean', () => {
    const report = validateRegistrations({ wf: makeRegistration('wf') });
    const output = formatValidationReport(report, 'my-workflow.ts');

    expect(output).toContain('my-workflow.ts');
    expect(output).toContain('No issues found.');
  });

  it('includes issue code and severity in output', () => {
    const report = validateRegistrations({ wf: makeRegistration('wf') }, [
      makeActivity('pay', {
        idempotent: true,
        retry: {
          maxAttempts: Infinity,
          initialBackoff: '1s',
          backoffMultiplier: 2,
          maxBackoff: '30s',
        },
      }),
    ]);
    const output = formatValidationReport(report, 'entry.ts');

    expect(output).toContain('error');
    expect(output).toContain('unbounded-retry');
    expect(output).toContain('pay');
  });
});
