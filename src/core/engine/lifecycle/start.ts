import type { BatchOperation } from '../../../storage/interface.ts';
import { KEYS } from '../../../storage/interface.ts';
import { createCheckpoint } from '../../checkpoint.ts';
import { WorkflowStartedEvent } from '../../events.ts';
import { normalizeStorageTimestamp } from '../../scheduler.ts';
import {
  StartWorkflowValidationError,
  assertExclusiveStartWorkflowOptions,
  coerceStartWorkflowId,
  coerceStartWorkflowTimestamp,
  parseStartWorkflowDuration,
} from '../../start-workflow-validation.ts';
import type { TenantContext } from '../../tenant.ts';
import type { Checkpoint, Duration, StartOptions, TimerEntry, WorkflowState } from '../../types.ts';
import { type WorkflowVersionTuple } from '../../workflow-version-tuple.ts';
import { WorkflowAlreadyExistsError, WorkflowNotRegisteredError } from '../errors.ts';
import { type WorkflowHandle } from '../handles.ts';
import type { EngineInternals } from '../internals.ts';
import { createDelayedStartTimerEntry } from '../operations-time.ts';
import { selectPersistedWorkflowStartHeaders } from '../state-utilities.ts';
import { createWorkflowVersionTuple } from './persist.ts';
import {
  createWorkflowHandle,
  normalizeStartWorkflowTags,
  setWorkflowStartHeaders,
  type LifecycleCallbacks,
  type RegistrationEntry,
} from './shared.ts';
import { buildStartBatchOperations } from './start-batch.ts';
import { runWorkflowStartInterceptor, startWorkflowExecution } from './start-exec.ts';

export async function start(
  internals: EngineInternals,
  type: string,
  input: unknown,
  options: StartOptions | undefined,
  callbacks: LifecycleCallbacks,
): Promise<WorkflowHandle> {
  return startWorkflow(internals, type, input, options, undefined, undefined, callbacks);
}

type StartWorkflowPreparation = {
  workflowId: string;
  callerProvidedId: boolean;
  parentHeaders: Map<string, string> | undefined;
  executionStateOwnerId: string;
  submissionTime: number;
  delayedStartTimer: TimerEntry | undefined;
  normalizedTags: string[] | undefined;
};

function prepareStartWorkflow(
  internals: EngineInternals,
  options: StartOptions | undefined,
  callbacks: LifecycleCallbacks,
): StartWorkflowPreparation {
  const callerProvidedId = options?.id !== undefined;
  const workflowId =
    options?.id !== undefined
      ? coerceStartWorkflowId(options.id, 'options.id')
      : crypto.randomUUID();

  // Capture and clear pending parent headers immediately, before any async
  // work, to prevent a concurrent child-workflow start from overwriting them.
  const parentHeaders = internals.pendingParentHeaders;
  internals.pendingParentHeaders = undefined;
  const executionStateOwnerId = internals.pendingExecutionStateOwnerId ?? workflowId;
  internals.pendingExecutionStateOwnerId = undefined;
  const submissionTime = internals.options.getNow();
  const scheduledStartAt = resolveScheduledStartAt(internals, options, submissionTime, callbacks);
  const normalizedTags = normalizeStartWorkflowTags(internals, options?.tags, undefined, callbacks);
  const delayedStartTimer =
    scheduledStartAt !== undefined && scheduledStartAt > submissionTime
      ? createDelayedStartTimerEntry(internals, workflowId, scheduledStartAt, options, {
          parseStartOptionDuration: (value, fieldName) =>
            parseStartOptionDuration(internals, value, fieldName, callbacks),
        })
      : undefined;

  return {
    workflowId,
    callerProvidedId,
    parentHeaders,
    executionStateOwnerId,
    submissionTime,
    delayedStartTimer,
    normalizedTags,
  };
}

async function persistStartBatch(
  internals: EngineInternals,
  workflowId: string,
  tenant: TenantContext | undefined,
  startOperations: BatchOperation[],
): Promise<void> {
  if (tenant !== undefined) {
    const tenantQuotaManager = internals.tenantQuotaManager;
    await tenantQuotaManager.commitStartAdmission({
      tenantId: tenant.id,
      workflowId,
      startOperations,
      get estimatedStorageBytes() {
        return tenantQuotaManager.estimateStartStorageBytes(workflowId, startOperations);
      },
    });
    return;
  }
  await internals.storage.batch(startOperations);
}

function rollbackTransientStartState(internals: EngineInternals, workflowId: string): void {
  internals.checkpoints.delete(workflowId);
  internals.workflowHeaders.delete(workflowId);
  internals.workflowVersionTuples.delete(workflowId);
}

export async function startWorkflow(
  internals: EngineInternals,
  type: string,
  input: unknown,
  options: StartOptions | undefined,
  tenantOverride: { resolved: TenantContext | undefined } | undefined,
  additionalStartOperations: BatchOperation[] | undefined,
  callbacks: LifecycleCallbacks,
): Promise<WorkflowHandle> {
  const registration = internals.registrations.get(type);
  if (!registration) {
    throw new WorkflowNotRegisteredError(type);
  }

  const preparation = prepareStartWorkflow(internals, options, callbacks);
  const { workflowId, callerProvidedId, parentHeaders, executionStateOwnerId, delayedStartTimer } =
    preparation;

  // Atomic check-and-reserve: prevent two concurrent start() calls with the
  // same ID from both passing the storage check before either writes state.
  if (internals.pendingStarts.has(workflowId)) {
    throw new WorkflowAlreadyExistsError(workflowId);
  }
  internals.pendingStarts.add(workflowId);
  let startSucceeded = false;

  try {
    // Only hit storage to dedup when the caller supplied the id. A
    // freshly-generated v4 UUID is (for all practical purposes) unique, so
    // the extra round trip is wasted work on the hot start path. This is
    // the dominant optimization behind the workflow-start benchmark — the
    // get → batch sequence was two storage calls per start, now one.
    if (callerProvidedId) {
      const existingBytes = await internals.storage.get(KEYS.workflow(workflowId));
      if (existingBytes !== null) {
        throw new WorkflowAlreadyExistsError(workflowId);
      }
    }

    // Resolve the tenant context before the first checkpoint is written so
    // it gets persisted as part of the initial state blob.
    const tenant = tenantOverride
      ? tenantOverride.resolved
      : await resolveTenantForStart(internals, workflowId, type, input, callbacks);
    const versionTuple = createWorkflowVersionTuple(internals, registration, tenant, callbacks);

    const state = createInitialWorkflowState(
      internals,
      workflowId,
      type,
      input,
      versionTuple,
      options,
      preparation.normalizedTags,
      tenant,
      executionStateOwnerId,
      delayedStartTimer,
      callbacks,
    );
    const checkpoint = createInitialCheckpoint(
      internals,
      workflowId,
      versionTuple.workflowVersion,
      options,
      callbacks,
    );
    const workflowStartHeaders = runWorkflowStartInterceptor(
      internals,
      workflowId,
      type,
      input,
      parentHeaders,
      callbacks,
    );
    const persistedWorkflowStartHeaders = selectPersistedWorkflowStartHeaders(workflowStartHeaders);
    internals.checkpoints.set(workflowId, checkpoint);
    setWorkflowStartHeaders(internals, workflowId, workflowStartHeaders, callbacks);

    // Cache the workflow version tuple for forwarding to event-log entries.
    internals.workflowVersionTuples.set(workflowId, versionTuple);

    const startOperations = buildStartBatchOperations(
      internals,
      workflowId,
      state,
      checkpoint,
      registration,
      options,
      state.executionDeadline,
      delayedStartTimer,
      persistedWorkflowStartHeaders,
      additionalStartOperations,
      callbacks,
    );

    await persistStartBatch(internals, workflowId, tenant, startOperations);

    const handle = createWorkflowHandle(internals, workflowId, callbacks);
    if (!delayedStartTimer) {
      beginWorkflowExecution(
        internals,
        workflowId,
        type,
        input,
        checkpoint,
        state.executionDeadline,
        tenant,
        state.executionStateOwnerId ?? workflowId,
        registration,
        callbacks,
      );
    }
    startSucceeded = true;
    return handle;
  } finally {
    internals.pendingStarts.delete(workflowId);
    if (!startSucceeded) {
      rollbackTransientStartState(internals, workflowId);
    }
  }
}

export function resolveScheduledStartAt(
  internals: EngineInternals,
  options: StartOptions | undefined,
  submissionTime: number,
  callbacks: LifecycleCallbacks,
): number | undefined {
  assertExclusiveStartWorkflowOptions(options?.startAt, options?.startAfter);

  if (options?.startAt !== undefined) {
    return coerceStartWorkflowTimestamp(options.startAt, 'options.startAt');
  }

  if (options?.startAfter !== undefined) {
    const startAfterMilliseconds = parseStartOptionDuration(
      internals,
      options.startAfter,
      'options.startAfter',
      callbacks,
    );
    try {
      return normalizeStorageTimestamp(
        submissionTime + startAfterMilliseconds,
        'options.startAfter',
      );
    } catch {
      throw new StartWorkflowValidationError(
        'options.startAfter must resolve to a finite, non-negative start time',
      );
    }
  }

  return undefined;
}

export function parseStartOptionDuration(
  _internals: EngineInternals,
  duration: Duration,
  fieldName: 'options.executionTimeout' | 'options.startAfter',
  _callbacks: LifecycleCallbacks,
): number {
  return parseStartWorkflowDuration(duration, fieldName);
}

export function beginWorkflowExecution(
  internals: EngineInternals,
  workflowId: string,
  workflowType: string,
  input: unknown,
  checkpoint: Checkpoint,
  executionDeadline: number | undefined,
  tenant: TenantContext | undefined,
  executionStateOwnerId: string,
  _registration: RegistrationEntry,
  callbacks: LifecycleCallbacks,
): void {
  const nestingDepth = internals.pendingNestingDepth ?? 0;
  internals.pendingNestingDepth = undefined;

  if (internals.inlineStrategy !== null) {
    callbacks.queueInlineWorkflowExecutionStart({
      workflowId,
      workflowType,
      input,
      checkpoint,
      nestingDepth,
      executionDeadline,
      executionStateOwnerId,
      tenant,
    });
    return;
  }

  callbacks.dispatchEvent(new WorkflowStartedEvent(workflowId, workflowType, input));
  startWorkflowExecution(
    internals,
    workflowId,
    workflowType,
    input,
    checkpoint,
    nestingDepth,
    executionDeadline,
    executionStateOwnerId,
    tenant,
    callbacks,
  );
}

function buildInitialIdentitySlice(
  workflowId: string,
  type: string,
  input: unknown,
  versionTuple: WorkflowVersionTuple,
  executionStateOwnerId: string,
  delayedStartTimer: TimerEntry | undefined,
  now: number,
  tags: string[] | undefined,
): WorkflowState {
  return {
    id: workflowId,
    type,
    status: delayedStartTimer ? 'pending' : 'running',
    input,
    version: versionTuple.workflowVersion,
    executionStateOwnerId,
    createdAt: now,
    ...(!delayedStartTimer && { startedAt: now }),
    updatedAt: now,
    ...(tags !== undefined && { tags }),
    ...(versionTuple.agentVersion !== undefined && {
      agentVersion: versionTuple.agentVersion,
    }),
    ...(versionTuple.toolVersions !== undefined && {
      toolVersions: versionTuple.toolVersions,
    }),
  };
}

function resolveInitialExecutionDeadline(
  internals: EngineInternals,
  options: StartOptions | undefined,
  delayedStartTimer: TimerEntry | undefined,
  now: number,
  callbacks: LifecycleCallbacks,
): number | undefined {
  if (options?.executionTimeout === undefined || delayedStartTimer) {
    return undefined;
  }
  const executionTimeoutMilliseconds = parseStartOptionDuration(
    internals,
    options.executionTimeout,
    'options.executionTimeout',
    callbacks,
  );
  try {
    return normalizeStorageTimestamp(
      now + executionTimeoutMilliseconds,
      'options.executionTimeout',
    );
  } catch {
    throw new StartWorkflowValidationError(
      'options.executionTimeout must resolve to a finite, non-negative deadline',
    );
  }
}

export function createInitialWorkflowState(
  internals: EngineInternals,
  workflowId: string,
  type: string,
  input: unknown,
  versionTuple: WorkflowVersionTuple,
  options: StartOptions | undefined,
  tags: string[] | undefined,
  tenant: TenantContext | undefined,
  executionStateOwnerId: string,
  delayedStartTimer: TimerEntry | undefined,
  callbacks: LifecycleCallbacks,
): WorkflowState {
  const now = internals.options.getNow();
  const state = buildInitialIdentitySlice(
    workflowId,
    type,
    input,
    versionTuple,
    executionStateOwnerId,
    delayedStartTimer,
    now,
    tags,
  );

  const executionDeadline = resolveInitialExecutionDeadline(
    internals,
    options,
    delayedStartTimer,
    now,
    callbacks,
  );
  if (executionDeadline !== undefined) {
    state.executionDeadline = executionDeadline;
  }

  if (tenant !== undefined) {
    state.tenant = tenant;
  }

  return state;
}

/**
 * Resolve the tenant for a new workflow via the configured resolver. Returns
 * `undefined` when no resolver is set or the resolver itself returned
 * `undefined`. Thrown errors are surfaced to the caller of `start()` so
 * misconfigured resolvers fail loudly instead of silently bypassing tenancy.
 */
export async function resolveTenantForStart(
  internals: EngineInternals,
  workflowId: string,
  workflowType: string,
  input: unknown,
  _callbacks: LifecycleCallbacks,
): Promise<TenantContext | undefined> {
  const resolver = internals.options.tenantResolver;
  if (!resolver) return undefined;
  const resolved = await resolver.resolve(workflowId, input, workflowType);
  return resolved;
}

export function createInitialCheckpoint(
  internals: EngineInternals,
  workflowId: string,
  workflowVersion: string,
  options: StartOptions | undefined,
  _callbacks: LifecycleCallbacks,
): Checkpoint {
  const checkpoint = createCheckpoint(workflowId, workflowVersion, internals.options.getNow());
  if (options?.searchAttributes) {
    checkpoint.searchAttributes = { ...options.searchAttributes };
  }
  return checkpoint;
}
