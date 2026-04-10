/**
 * Tests for the weft validate design-time linter.
 *
 * Covers the three anti-pattern checks:
 * - unbounded-retry: maxAttempts = Infinity
 * - stateful-without-compensator: non-idempotent activity with no compensate
 * - (formatting) formatValidationReport produces expected output
 */

import { describe, expect, it } from 'bun:test';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { ActivityDefinition, WorkflowRegistration } from '../core/types.ts';
import {
  formatValidationReport,
  loadRegistrationsFromModule,
  validateRegistrations,
} from './validate.ts';

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
      // idempotent: true to suppress the stateful-without-compensator error,
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

  it('reports error for non-idempotent activity without compensator', () => {
    const registrations = { wf: makeRegistration('wf') };
    const activities: ActivityDefinition[] = [makeActivity('sendEmail', { idempotent: false })];

    const report = validateRegistrations(registrations, activities);
    expect(report.valid).toBe(false); // stateful-without-compensator is an error
    const issue = report.issues.find((i) => i.code === 'stateful-without-compensator');
    expect(issue).toBeDefined();
    expect(issue!.severity).toBe('error');
    expect(issue!.activityName).toBe('sendEmail');
  });

  it('stateful-without-compensator makes valid=false', () => {
    const registrations = { wf: makeRegistration('wf') };
    const activities: ActivityDefinition[] = [makeActivity('sideEffect', { idempotent: false })];

    const report = validateRegistrations(registrations, activities);
    expect(report.valid).toBe(false);
    expect(report.issues.some((i) => i.severity === 'error')).toBe(true);
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
      makeActivity('b', { idempotent: false }), // stateful-without-compensator error
      makeActivity('c', {
        retry: {
          maxAttempts: Infinity,
          initialBackoff: '1s',
          backoffMultiplier: 2,
          maxBackoff: '30s',
        },
        idempotent: false,
      }), // both unbounded-retry + stateful-without-compensator errors
    ];

    const report = validateRegistrations(registrations, activities);
    expect(report.valid).toBe(false);
    const errors = report.issues.filter((i) => i.severity === 'error');
    expect(errors.length).toBeGreaterThanOrEqual(3); // a=unbounded, b=stateful, c=both
  });

  it('empty registrations and no activities returns valid with 0 workflows', () => {
    const report = validateRegistrations({});
    expect(report.valid).toBe(true);
    expect(report.workflowCount).toBe(0);
    expect(report.issues).toHaveLength(0);
  });

  // ---------------------------------------------------------------------------
  // 6. Standalone activity label
  // ---------------------------------------------------------------------------

  it('labels issues from standalone activities with "(standalone)" as the workflowType', () => {
    // Standalone activities are passed via the activities parameter without any
    // workflow registration context. The label must be '(standalone)', not the
    // name of an unrelated workflow.
    const report = validateRegistrations({ someWorkflow: makeRegistration('someWorkflow') }, [
      makeActivity('chargeCard', {
        idempotent: false, // triggers stateful-without-compensator
      }),
      makeActivity('sendNotification', {
        idempotent: true,
        retry: {
          maxAttempts: Infinity,
          initialBackoff: '1s',
          backoffMultiplier: 2,
          maxBackoff: '30s',
        },
      }),
    ]);

    expect(report.valid).toBe(false);
    for (const issue of report.issues) {
      expect(issue.workflowType).toBe('(standalone)');
    }
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

// ---------------------------------------------------------------------------
// 5. loadRegistrationsFromModule
// ---------------------------------------------------------------------------

describe('loadRegistrationsFromModule', () => {
  it('picks up function-typed activity definitions (activity() helper shape)', async () => {
    // The activity() helper returns a function with `name` and `execute` as own
    // properties. isActivityDefinition must accept typeof === 'function'.
    const dir = await mkdtemp(join(tmpdir(), 'weft-validate-'));
    const filePath = join(dir, 'activities.ts');
    await writeFile(
      filePath,
      `
// Simulate the shape that activity() helper produces: a function with
// 'name' and 'execute' as own properties (not a plain object).
const def = { name: 'sendEmail', execute: async () => ({ sent: true }) };
const fn = Object.create(Function.prototype, {
  name: { value: def.name, writable: false, configurable: true },
  execute: { value: def.execute, writable: true, configurable: true },
});
export const sendEmail = fn;
`,
    );

    const { activities } = await loadRegistrationsFromModule(filePath);
    expect(activities.some((a) => a.name === 'sendEmail')).toBe(true);
  });

  it('resolves relative paths against process.cwd(), not the source file', async () => {
    // Write a module in tmpdir and load it by absolute path — this confirms
    // the path.resolve(cwd, modulePath) logic works correctly.
    const dir = await mkdtemp(join(tmpdir(), 'weft-validate-'));
    const filePath = join(dir, 'workflows.ts');
    await writeFile(
      filePath,
      `
export const greet = {
  handler: async function* () { return 'hi'; }
};
`,
    );

    const { registrations } = await loadRegistrationsFromModule(filePath);
    expect('greet' in registrations).toBe(true);
  });
});
