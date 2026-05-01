import { decode, encode } from '../codec.ts';
import type { ContextOperationRequest } from '../context.ts';
import { isRecord, safeDebugStringify, sanitizeDebugValueForDisplay } from '../debug-output.ts';
import type {
  ListFilter,
  PaginatedResult,
  ScheduleAccessOptions,
  ScheduleFilter,
  ScheduleState,
  ScheduleSummary,
  WorkflowState,
  WorkflowSummary,
} from '../types.ts';
import { matchesWorkflowTagFilter } from '../workflow-tags.ts';
import { isPlainObjectRecord, isSanitizedSearchAttributeValue } from './validation.ts';

const PERSISTED_WORKFLOW_START_HEADER_NAMES = new Set(['traceparent', 'tracestate']);

const PRESERVE_OUTPUT_TERMINAL_CLEANUP_TIMER_PREFIX = 'terminal-cleanup:preserve-output:';

const FULL_TERMINAL_CLEANUP_TIMER_PREFIX = 'terminal-cleanup:full:';

type PaginationFilter = {
  limit?: number;
  offset?: number;
};

/**
 * Build the unified `#workflowFeedListeners` map key. Uses `\0` as
 * the separator: workflow ID validation (`assertValidWorkflowId`)
 * rejects control characters, so no legal workflow ID can contain
 * NUL, and the selector is a fixed two-member union, so no legal
 * input can collide.
 */
export function workflowFeedListenerKey(workflowId: string, selector: 'events' | 'tokens'): string {
  return `${workflowId}\0${selector}`;
}

/**
 * Safely cast a `Function` stored on a ContextOperationRequest
 * to a callable signature.  We trust the Context layer to populate
 * `fn` with the correct reference—the Engine merely invokes it.
 */
export function callActivityFunction(fn: Function, args: unknown[]): unknown {
  return (fn as (...a: unknown[]) => unknown)(...args);
}

export function callMemoFunction(fn: Function): unknown {
  return (fn as () => unknown)();
}

export function summarizeTimelineValue(value: unknown): string {
  return safeDebugStringify(value);
}

// oxlint-disable-next-line complexity -- ID:core-engine-get-timeline-operation-label-complexity
export function getTimelineOperationLabel(operation: ContextOperationRequest): string {
  switch (operation.type) {
    case 'activity':
      return operation.activityName;
    case 'wait-signal':
      return operation.signalName;
    case 'wait-update':
      return operation.updateName;
    case 'child-workflow':
      return operation.workflowType;
    case 'memo':
    case 'offload':
    case 'archive':
    case 'stream':
      return operation.key;
    case 'load':
      return operation.reference.key;
    case 'agent':
      return operation.options.model;
    default:
      return operation.type;
  }
}

export function getTimelineReviewArtifactType(artifact: unknown): unknown {
  if (typeof artifact !== 'object' || artifact === null || !('type' in artifact)) {
    return undefined;
  }

  return (artifact as Record<string, unknown>)['type'];
}

// oxlint-disable-next-line complexity -- ID:core-engine-get-timeline-basic-input-summary-complexity
export function getTimelineBasicInputSummary(operation: ContextOperationRequest): string {
  switch (operation.type) {
    case 'sleep':
      return summarizeTimelineValue({ duration: operation.duration });
    case 'wait-signal':
      return summarizeTimelineValue({ signalName: operation.signalName });
    case 'wait-update':
      return summarizeTimelineValue({ updateName: operation.updateName });
    case 'parallel':
    case 'race':
      return summarizeTimelineValue({ operationCount: operation.operations.length });
    case 'memo':
      return summarizeTimelineValue({ key: operation.key });
    case 'offload':
      return summarizeTimelineValue({ key: operation.key });
    case 'load':
      return summarizeTimelineValue({ key: operation.reference.key });
    case 'archive':
      return summarizeTimelineValue({ key: operation.key, data: operation.data });
    case 'speculate':
      return summarizeTimelineValue({ branch: 'speculative' });
    case 'stream':
      return summarizeTimelineValue({ key: operation.key });
    default:
      return summarizeTimelineValue(undefined);
  }
}

export function getTimelineInputSummary(operation: ContextOperationRequest): string {
  switch (operation.type) {
    case 'activity':
      return summarizeTimelineValue(
        operation.args.length <= 1 ? operation.args[0] : operation.args,
      );
    case 'child-workflow':
      return summarizeTimelineValue({
        workflowType: operation.workflowType,
        input: operation.input,
      });
    case 'run-all':
      return summarizeTimelineValue({ branches: Object.keys(operation.branches) });
    case 'agent':
      return summarizeTimelineValue({
        model: operation.options.model,
        promptLength: operation.options.prompt.length,
      });
    case 'wait-review':
      return summarizeTimelineValue({
        reviewers: operation.reviewOptions.reviewers,
        artifactType: getTimelineReviewArtifactType(operation.reviewOptions.artifact),
      });
    case 'handoff':
    case 'debate':
    case 'supervise':
      return summarizeTimelineValue(operation.options);
    default:
      return getTimelineBasicInputSummary(operation);
  }
}

export function sanitizeCheckpointLocals(locals: unknown): Record<string, unknown> {
  const sanitized = sanitizeDebugValueForDisplay(locals);
  return isRecord(sanitized) ? sanitized : {};
}

export function sanitizeCheckpointSearchAttributes(
  searchAttributes: unknown,
): Record<string, import('../types.ts').SearchAttributeValue> {
  const sanitized = sanitizeDebugValueForDisplay(searchAttributes);
  if (!isRecord(sanitized)) {
    return {};
  }

  const result: Record<string, import('../types.ts').SearchAttributeValue> = {};
  for (const [key, value] of Object.entries(sanitized)) {
    if (isSanitizedSearchAttributeValue(value)) {
      result[key] = value;
    }
  }

  return result;
}

export function sanitizeCheckpointState(
  checkpoint: import('../types.ts').CheckpointState,
): import('../types.ts').CheckpointState {
  return {
    step: checkpoint.step,
    locals: sanitizeCheckpointLocals(checkpoint.locals),
    searchAttributes: sanitizeCheckpointSearchAttributes(checkpoint.searchAttributes),
    version: checkpoint.version,
    createdAt: checkpoint.createdAt,
  };
}

export function sanitizeWorkflowEventPayload(payload: unknown): Record<string, unknown> {
  const sanitized = sanitizeDebugValueForDisplay(payload);
  return isRecord(sanitized) ? sanitized : { value: sanitized };
}

export function sanitizeTimelineSummary(summary: string | undefined): string | undefined {
  if (summary === undefined) {
    return undefined;
  }

  try {
    return summarizeTimelineValue(JSON.parse(summary) as unknown);
  } catch {
    return summary;
  }
}

export function normalizeForkStep(fromStep: number): number {
  if (!Number.isSafeInteger(fromStep) || fromStep < 0) {
    throw new Error('options.fromStep must be a non-negative safe integer');
  }

  return fromStep;
}

export function encodeWorkflowStartHeaders(headers: Map<string, string>): Uint8Array {
  return encode([...headers.entries()]);
}

export function decodeWorkflowStartHeaders(bytes: Uint8Array): Map<string, string> {
  const entries = decode(bytes) as Array<[string, string]>;
  return new Map(entries);
}

export function selectPersistedWorkflowStartHeaders(
  headers: Map<string, string> | undefined,
): Map<string, string> | undefined {
  if (!headers || headers.size === 0) {
    return undefined;
  }

  const persistedHeaders = new Map<string, string>();

  for (const [name, value] of headers) {
    const normalizedName = name.toLowerCase();
    if (!PERSISTED_WORKFLOW_START_HEADER_NAMES.has(normalizedName)) {
      continue;
    }
    persistedHeaders.set(normalizedName, value);
  }

  return persistedHeaders.size > 0 ? persistedHeaders : undefined;
}

export function intersectIdentifierSets(idSets: Set<string>[]): Set<string> | null {
  const [firstSet, ...remainingSets] = idSets;
  if (!firstSet) {
    return null;
  }

  const intersected = new Set(firstSet);
  for (const nextSet of remainingSets) {
    for (const id of intersected) {
      if (!nextSet.has(id)) {
        intersected.delete(id);
      }
    }
  }

  return intersected;
}

export function matchesListFilter(
  state: WorkflowState,
  filter: ListFilter | undefined,
  constrainedIds: Set<string> | null,
  normalizedTagFilters: readonly string[] | undefined,
): boolean {
  if (constrainedIds !== null && !constrainedIds.has(state.id)) {
    return false;
  }

  if (filter?.status !== undefined) {
    const statuses = Array.isArray(filter.status) ? filter.status : [filter.status];
    if (!statuses.includes(state.status)) {
      return false;
    }
  }

  if (!matchesWorkflowTagFilter(state.tags, normalizedTagFilters)) {
    return false;
  }

  return filter?.type === undefined || state.type === filter.type;
}

/**
 * Slice an in-memory list of {@link WorkflowSummary} into a {@link PaginatedResult}.
 *
 * Important note on `total` semantics: the returned `total` reflects the number
 * of workflows that matched the supplied {@link ListFilter} (status, type, and
 * search attribute filters). It is **not** the absolute count of workflows in
 * storage. A UI computing "page 1 of N" from `total` will see the page count
 * for the active filter; the unfiltered population is intentionally not
 * surfaced through this response, since recovering it would require a separate
 * full scan that defeats the purpose of the filter fast path.
 */
export function paginateWorkflowSummaries(
  items: WorkflowSummary[],
  filter?: ListFilter,
): PaginatedResult<WorkflowSummary> {
  return paginateItems(items, filter);
}

export function paginateItems<T>(
  items: T[],
  filter: PaginationFilter | undefined,
): PaginatedResult<T> {
  const offset = filter?.offset ?? 0;
  const limit = filter?.limit ?? items.length;
  return {
    items: items.slice(offset, offset + limit),
    total: items.length,
    offset,
    limit,
  };
}

export function normalizeValueForEncodedComparison(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((entry) => normalizeValueForEncodedComparison(entry));
  }

  if (!isPlainObjectRecord(value)) {
    return value;
  }

  const normalizedRecord: Record<string, unknown> = {};
  for (const key of Object.keys(value).toSorted()) {
    normalizedRecord[key] = normalizeValueForEncodedComparison(value[key]);
  }

  return normalizedRecord;
}

export function encodedValuesEqual(left: unknown, right: unknown): boolean {
  const leftEncoded = encode(normalizeValueForEncodedComparison(left));
  const rightEncoded = encode(normalizeValueForEncodedComparison(right));

  if (leftEncoded.byteLength !== rightEncoded.byteLength) {
    return false;
  }

  for (let index = 0; index < leftEncoded.byteLength; index++) {
    if (leftEncoded[index] !== rightEncoded[index]) {
      return false;
    }
  }

  return true;
}

// oxlint-disable-next-line complexity -- ID:core-engine-matches-schedule-filter-complexity
export function matchesScheduleFilter(
  state: ScheduleState,
  filter: ScheduleFilter | undefined,
): boolean {
  if (state.tenant?.id !== undefined) {
    if (filter?.tenantId === undefined) {
      return false;
    }
    if (state.tenant.id !== filter.tenantId) {
      return false;
    }
  } else if (filter?.tenantId !== undefined) {
    return false;
  }

  if (filter?.status !== undefined) {
    const statuses = Array.isArray(filter.status) ? filter.status : [filter.status];
    if (!statuses.includes(state.status)) {
      return false;
    }
  }

  return filter?.workflowType === undefined || state.workflowType === filter.workflowType;
}

export function paginateScheduleSummaries(
  items: ScheduleSummary[],
  filter?: ScheduleFilter,
): PaginatedResult<ScheduleSummary> {
  const sortedItems = items.toSorted((left, right) => {
    if (left.createdAt !== right.createdAt) {
      return left.createdAt - right.createdAt;
    }

    return left.id.localeCompare(right.id);
  });

  return paginateItems(sortedItems, filter);
}

export function createScheduleTimerId(scheduleId: string): string {
  return `schedule:${scheduleId}`;
}

export function createTerminalCleanupTimerId(
  includeOutputArtifacts: boolean,
  terminalCleanupToken: string,
): string {
  return includeOutputArtifacts
    ? `${FULL_TERMINAL_CLEANUP_TIMER_PREFIX}${terminalCleanupToken}`
    : `${PRESERVE_OUTPUT_TERMINAL_CLEANUP_TIMER_PREFIX}${terminalCleanupToken}`;
}

export function parseTerminalCleanupTimerId(
  timerId: string,
): { includeOutputArtifacts: boolean; terminalCleanupToken: string } | null {
  const parseTerminalCleanupToken = (prefix: string): string | null => {
    const token = timerId.slice(prefix.length);
    return token.length === 0 ? null : token;
  };

  if (timerId.startsWith(FULL_TERMINAL_CLEANUP_TIMER_PREFIX)) {
    const terminalCleanupToken = parseTerminalCleanupToken(FULL_TERMINAL_CLEANUP_TIMER_PREFIX);
    return terminalCleanupToken === null
      ? null
      : { includeOutputArtifacts: true, terminalCleanupToken };
  }

  if (timerId.startsWith(PRESERVE_OUTPUT_TERMINAL_CLEANUP_TIMER_PREFIX)) {
    const terminalCleanupToken = parseTerminalCleanupToken(
      PRESERVE_OUTPUT_TERMINAL_CLEANUP_TIMER_PREFIX,
    );
    return terminalCleanupToken === null
      ? null
      : { includeOutputArtifacts: false, terminalCleanupToken };
  }

  return null;
}

export function canAccessSchedule(
  state: ScheduleState,
  accessOptions: ScheduleAccessOptions | undefined,
): boolean {
  if (state.tenant?.id === undefined) {
    return accessOptions?.tenantId === undefined;
  }

  return accessOptions?.tenantId === state.tenant.id;
}

export function clearScheduleCurrentWorkflow(state: ScheduleState): ScheduleState {
  const { currentWorkflowId: _currentWorkflowId, ...rest } = state;
  return rest;
}
