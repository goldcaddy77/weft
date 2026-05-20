import { decode } from '../codec.ts';
import { isRecord } from '../debug-output.ts';
import { normalizeFailureCategory } from '../failure-categories.ts';
import { coerceStartWorkflowId, parseStartWorkflowDuration } from '../start-workflow-validation.ts';
import type {
  NormalizedRetentionPolicy,
  RetentionPolicy,
  WorkflowState,
  WorkflowStatus,
  WorkflowTimelineEntry,
  WorkflowTimelineStatus,
} from '../types.ts';
import { isWorkflowTagArray } from '../workflow-tags.ts';
import type { WorkflowVersionTuple } from '../workflow-version-tuple.ts';

const WORKFLOW_TIMELINE_STATUSES = new Set<WorkflowTimelineStatus>([
  'running',
  'completed',
  'failed',
  'cancelled',
  'timed-out',
]);

export function isSanitizedSearchAttributeValue(
  value: unknown,
): value is import('../types.ts').SearchAttributeValue {
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return true;
  }

  return Array.isArray(value) && value.every((entry) => typeof entry === 'string');
}

export function isWorkflowVersionTuple(value: unknown): value is WorkflowVersionTuple {
  if (!isRecord(value) || typeof value['workflowVersion'] !== 'string') {
    return false;
  }

  if (value['agentVersion'] !== undefined && typeof value['agentVersion'] !== 'string') {
    return false;
  }

  return (
    value['toolVersions'] === undefined ||
    (Array.isArray(value['toolVersions']) &&
      value['toolVersions'].every((entry) => typeof entry === 'string'))
  );
}

export function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

export function isTimelineStep(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 1;
}

type TimelineEntryFieldCheck = (entry: Record<string, unknown>) => boolean;

const TIMELINE_ENTRY_FIELD_CHECKS: readonly TimelineEntryFieldCheck[] = [
  (entry) => isTimelineStep(entry['step']),
  (entry) => typeof entry['operationType'] === 'string',
  (entry) => typeof entry['operationLabel'] === 'string',
  (entry) => typeof entry['inputSummary'] === 'string',
  (entry) => isFiniteNumber(entry['timestamp']),
  (entry) => WORKFLOW_TIMELINE_STATUSES.has(entry['status'] as WorkflowTimelineStatus),
  (entry) => entry['outputSummary'] === undefined || typeof entry['outputSummary'] === 'string',
  (entry) => entry['duration'] === undefined || isFiniteNumber(entry['duration']),
  (entry) => entry['versionTuple'] === undefined || isWorkflowVersionTuple(entry['versionTuple']),
];

export function isWorkflowTimelineEntry(value: unknown): value is WorkflowTimelineEntry {
  if (!isRecord(value)) {
    return false;
  }
  return TIMELINE_ENTRY_FIELD_CHECKS.every((check) => check(value));
}

export function normalizeBulkFilterNumber(
  value: unknown,
  fieldName: 'limit' | 'offset',
): number | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new Error(`filter.${fieldName} must be a non-negative number when provided`);
  }

  return Math.floor(value);
}

/**
 * Type predicate that validates a decoded `tenant` field is shaped like a
 * {@link import('../tenant.ts').TenantContext}. Returns true only when `tenant`
 * is `undefined`, or an object with a non-empty string `id` and (when present)
 * an `attributes` object. Defensive because `state.tenant` is fed directly
 * surfaced to workflow code as `ctx.tenant`; a corrupt or tampered storage
 * record could otherwise inject a forged tenant identity into security
 * decisions.
 *
 * `null` is rejected intentionally — the canonical "no tenant" value is
 * `undefined`. A stored `null` indicates corruption.
 */
export function isValidDecodedTenant(
  value: unknown,
): value is import('../tenant.ts').TenantContext | undefined {
  if (value === undefined) return true;
  if (value === null || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  const id = record['id'];
  if (typeof id !== 'string' || id.length === 0) return false;
  const attributes = record['attributes'];
  if (attributes !== undefined && (attributes === null || typeof attributes !== 'object')) {
    return false;
  }
  return true;
}

export function isValidDecodedTags(value: unknown): value is string[] | undefined {
  return value === undefined || isWorkflowTagArray(value);
}

export function decodeWorkflowState(bytes: Uint8Array): WorkflowState {
  // bytes were written by encode(WorkflowState) — shape is guaranteed by our own storage
  const state = decode(bytes) as WorkflowState;
  // Defensive check on the security-relevant tenant field. Other fields are
  // trusted by construction, but `tenant` feeds directly into workflow decision
  // functions so we refuse to propagate a forged identity. On invalid shape we
  // log a warning and fall back to `undefined` (the safe default) rather than
  // throwing — refusing to decode would break recovery for unrelated workflows
  // sharing the same storage backend.
  if (!isValidDecodedTenant(state.tenant)) {
    console.warn(
      `[weft] Decoded workflow state for "${String(state.id)}" has an invalid tenant field; ` +
        `falling back to undefined tenant. This usually indicates corruption or tampering of ` +
        `the storage record.`,
    );
    delete state.tenant;
  }
  if (!isValidDecodedTags(state.tags)) {
    console.warn(
      `[weft] Decoded workflow state for "${String(state.id)}" has invalid tags; ` +
        'dropping the malformed tag list from the decoded state.',
    );
    delete state.tags;
  }
  if (state.failureCategory !== undefined && state.failureCategory !== null) {
    const normalizedFailureCategory = normalizeFailureCategory(state.failureCategory);
    if (normalizedFailureCategory === undefined) {
      delete state.failureCategory;
    } else {
      state.failureCategory = normalizedFailureCategory;
    }
  }
  if (state.executionStateOwnerId !== undefined) {
    try {
      coerceStartWorkflowId(state.executionStateOwnerId, 'executionStateOwnerId');
    } catch {
      console.warn(
        `[weft] Decoded workflow state for "${String(state.id)}" has an invalid ` +
          'executionStateOwnerId field; falling back to the workflow id as the execution owner. ' +
          'This usually indicates corruption or tampering of the storage record.',
      );
      delete state.executionStateOwnerId;
    }
  }
  return state;
}

export function normalizeRetentionDuration(
  value: import('../types.ts').Duration | undefined,
  fieldName: string,
): number | undefined {
  if (value === undefined) {
    return undefined;
  }

  const milliseconds = parseStartWorkflowDuration(value, fieldName);
  return Math.ceil(milliseconds);
}

export function normalizeRetentionPolicy(
  policy: RetentionPolicy | undefined,
  context: string,
): NormalizedRetentionPolicy | null {
  if (!policy) {
    return null;
  }

  const normalized: NormalizedRetentionPolicy = {};
  const completed = normalizeRetentionDuration(policy.completed, `${context}.completed`);
  const failed = normalizeRetentionDuration(policy.failed, `${context}.failed`);
  const cancelled = normalizeRetentionDuration(policy.cancelled, `${context}.cancelled`);
  const timedOut = normalizeRetentionDuration(policy.timedOut, `${context}.timedOut`);

  if (completed !== undefined) {
    normalized.completed = completed;
  }
  if (failed !== undefined) {
    normalized.failed = failed;
  }
  if (cancelled !== undefined) {
    normalized.cancelled = cancelled;
  }
  if (timedOut !== undefined) {
    normalized.timedOut = timedOut;
  }

  const isEmpty =
    normalized.completed === undefined &&
    normalized.failed === undefined &&
    normalized.cancelled === undefined &&
    normalized.timedOut === undefined;

  return isEmpty ? null : normalized;
}

export function resolveRetentionForStatus(
  policy: NormalizedRetentionPolicy | null | undefined,
  status: WorkflowStatus,
): number | undefined {
  switch (status) {
    case 'completed':
      return policy?.completed;
    case 'failed':
      return policy?.failed;
    case 'cancelled':
      return policy?.cancelled;
    case 'timed-out':
      return policy?.timedOut;
    default:
      return undefined;
  }
}

export function isTerminalWorkflowStatus(status: WorkflowStatus): boolean {
  return (
    status === 'completed' ||
    status === 'failed' ||
    status === 'cancelled' ||
    status === 'timed-out'
  );
}

export function isPlainObjectRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }

  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
