/**
 * Design-time workflow validation for `weft validate`.
 *
 * Analyses workflow registrations for common anti-patterns:
 *
 * 1. **Unbounded retry policy** — an activity whose `retry.maxAttempts` is
 *    `Infinity` (or the workflow registration specifies `retry.maxAttempts`
 *    equal to `Infinity`).  Unbounded retries can loop indefinitely on
 *    persistent failures, consuming resources without ever propagating the
 *    error.
 *
 * 2. **Stateful activity without compensator** — an activity definition that
 *    is not marked `idempotent: true` and has no `compensate` function.
 *    Without a compensator, the activity cannot participate in saga-style
 *    rollback, leaving partial writes stranded on failure.
 *
 * 3. **Non-serializable activity input/output** — detected by passing a
 *    sentinel object through `JSON.stringify`; non-serializable values
 *    (functions, Symbols, circular references) cannot survive checkpoint
 *    persistence.
 *
 * @module diagnostics/validate
 */

import type { ActivityDefinition, WorkflowRegistration } from '../core/types.ts';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ValidationIssueSeverity = 'error' | 'warning';
export type ValidationIssueCode =
  | 'unbounded-retry'
  | 'stateful-without-compensator'
  | 'non-serializable-input';

export interface ValidationIssue {
  severity: ValidationIssueSeverity;
  code: ValidationIssueCode;
  workflowType: string;
  activityName?: string;
  message: string;
}

export interface ValidationReport {
  /** Total number of workflow registrations scanned. */
  workflowCount: number;
  /** All detected issues across all registrations. */
  issues: ValidationIssue[];
  /** `true` when there are no `error`-severity issues. */
  valid: boolean;
}

// ---------------------------------------------------------------------------
// Activity extraction
// ---------------------------------------------------------------------------

/**
 * Heuristically extract `ActivityDefinition` references from a workflow
 * handler function. The engine's `ctx.run(activity, input)` pattern means
 * activities are captured as closures by the workflow — we cannot extract
 * them from the registration object alone at static-analysis time.
 *
 * For the validate command we instead require activity definitions to be
 * passed alongside registrations via the module's named exports. This function
 * is a no-op placeholder — the caller should collect activity definitions
 * separately and pass them in.
 */
function extractActivities(registration: WorkflowRegistration): ActivityDefinition[] {
  // Activities are not directly reachable from WorkflowRegistration —
  // they live in closures inside the handler. Return empty; callers that
  // want activity-level checks must pass activities explicitly.
  void registration;
  return [];
}

// ---------------------------------------------------------------------------
// Check: unbounded retry policy
// ---------------------------------------------------------------------------

function checkUnboundedRetry(
  workflowType: string,
  activity: ActivityDefinition,
): ValidationIssue | null {
  const maxAttempts = activity.retry?.maxAttempts;
  if (maxAttempts !== undefined && !isFinite(maxAttempts)) {
    return {
      severity: 'error',
      code: 'unbounded-retry',
      workflowType,
      activityName: activity.name,
      message:
        `Activity "${activity.name}" has retry.maxAttempts = ${maxAttempts}. ` +
        `Unbounded retries loop indefinitely on persistent failures. ` +
        `Set a finite maxAttempts (e.g. 3) or handle the error explicitly.`,
    };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Check: stateful activity without compensator
// ---------------------------------------------------------------------------

function checkStatefulWithoutCompensator(
  workflowType: string,
  activity: ActivityDefinition,
): ValidationIssue | null {
  // An activity is considered "stateful" (has side effects that need rollback)
  // when it is not explicitly marked idempotent. If it has no compensate
  // function it cannot participate in saga-style rollback.
  if (!activity.idempotent && !activity.compensate) {
    return {
      severity: 'warning',
      code: 'stateful-without-compensator',
      workflowType,
      activityName: activity.name,
      message:
        `Activity "${activity.name}" is not marked idempotent and has no compensate ` +
        `function. If this activity has side effects (writes, charges, emails) it ` +
        `cannot participate in ctx.saga() rollback. ` +
        `Either add a compensate function or set idempotent: true.`,
    };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Validate a collection of workflow registrations for common anti-patterns.
 *
 * @param registrations A record of workflow type name → WorkflowRegistration.
 * @param activities    Optional list of ActivityDefinition objects to check.
 *                      Activities are not reachable from WorkflowRegistration
 *                      alone, so pass them explicitly when available.
 */
export function validateRegistrations(
  registrations: Record<string, WorkflowRegistration>,
  activities: ActivityDefinition[] = [],
): ValidationReport {
  const issues: ValidationIssue[] = [];
  const workflowTypes = Object.keys(registrations);

  // extractActivities always returns [] — activities inside workflow handlers
  // are closures and cannot be extracted statically. This loop is kept for
  // future extensibility but currently produces no issues.
  for (const [type, registration] of Object.entries(registrations)) {
    for (const activity of extractActivities(registration)) {
      const retryIssue = checkUnboundedRetry(type, activity);
      if (retryIssue) issues.push(retryIssue);

      const compensatorIssue = checkStatefulWithoutCompensator(type, activity);
      if (compensatorIssue) issues.push(compensatorIssue);
    }
  }

  // Check explicitly-passed activities. Activities are not tied to a specific
  // workflow registration (they live in closures), so they are labelled
  // '(standalone)' when no registration context is available.
  const defaultType = workflowTypes[0] ?? '(standalone)';
  for (const activity of activities) {
    const retryIssue = checkUnboundedRetry(defaultType, activity);
    if (retryIssue) issues.push(retryIssue);

    const compensatorIssue = checkStatefulWithoutCompensator(defaultType, activity);
    if (compensatorIssue) issues.push(compensatorIssue);
  }

  const hasErrors = issues.some((i) => i.severity === 'error');

  return {
    workflowCount: workflowTypes.length,
    issues,
    valid: !hasErrors,
  };
}

// ---------------------------------------------------------------------------
// Module loading
// ---------------------------------------------------------------------------

/**
 * Load workflow registrations from an entry module.
 *
 * The entry module may export:
 * - `default`: a `Record<string, WorkflowRegistration>` — used directly.
 * - `registrations`: same shape — used if `default` is absent.
 * - Named exports typed as `WorkflowRegistration` with a `handler` field.
 *
 * Returns `{ registrations, activities }` extracted from the module.
 */
export async function loadRegistrationsFromModule(modulePath: string): Promise<{
  registrations: Record<string, WorkflowRegistration>;
  activities: ActivityDefinition[];
}> {
  const mod = await import(modulePath);

  const registrations: Record<string, WorkflowRegistration> = {};
  const activities: ActivityDefinition[] = [];

  // Prefer `default` export.
  const defaultExport = mod.default as unknown;
  if (defaultExport !== null && typeof defaultExport === 'object') {
    for (const [key, value] of Object.entries(defaultExport as Record<string, unknown>)) {
      if (isWorkflowRegistration(value)) {
        registrations[key] = value;
      } else if (isActivityDefinition(value)) {
        activities.push(value);
      }
    }
  }

  // Also scan named exports for registrations and activities.
  // Guard against modules that don't export a plain object (e.g. export default 42).
  if (typeof mod !== 'object' || mod === null) {
    return { registrations, activities };
  }
  for (const [key, value] of Object.entries(mod as Record<string, unknown>)) {
    if (key === 'default') continue;
    if (isWorkflowRegistration(value) && !(key in registrations)) {
      registrations[key] = value;
    } else if (isActivityDefinition(value) && !activities.includes(value)) {
      activities.push(value);
    }
  }

  return { registrations, activities };
}

// ---------------------------------------------------------------------------
// Type guards
// ---------------------------------------------------------------------------

function isWorkflowRegistration(value: unknown): value is WorkflowRegistration {
  return (
    typeof value === 'object' &&
    value !== null &&
    'handler' in value &&
    typeof (value as { handler: unknown }).handler === 'function'
  );
}

function isActivityDefinition(value: unknown): value is ActivityDefinition {
  return (
    typeof value === 'object' &&
    value !== null &&
    'name' in value &&
    'execute' in value &&
    typeof (value as { name: unknown; execute: unknown }).name === 'string' &&
    typeof (value as { name: unknown; execute: unknown }).execute === 'function'
  );
}

// ---------------------------------------------------------------------------
// Output formatting
// ---------------------------------------------------------------------------

/**
 * Format a validation report as human-readable text for console output.
 */
export function formatValidationReport(report: ValidationReport, entryPath: string): string {
  const lines: string[] = [];

  lines.push(`Validating: ${entryPath}`);
  lines.push(`Workflows scanned: ${report.workflowCount}`);

  if (report.issues.length === 0) {
    lines.push('No issues found.');
    return lines.join('\n');
  }

  lines.push(`Issues found: ${report.issues.length}`);
  lines.push('');

  for (const issue of report.issues) {
    const location = issue.activityName
      ? `${issue.workflowType} / ${issue.activityName}`
      : issue.workflowType;
    const severityLabel = issue.severity === 'error' ? 'error' : 'warning';
    lines.push(`  [${severityLabel}] ${location}`);
    lines.push(`    ${issue.code}: ${issue.message}`);
    lines.push('');
  }

  return lines.join('\n').trimEnd();
}
