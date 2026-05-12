/* oxlint-disable max-lines -- ID:core-engine-lifecycle-file-length */

import type { BatchOperation } from '../../storage/interface.ts';
import { KEYS, storageHas } from '../../storage/interface.ts';
import { createCheckpoint, deserializeCheckpoint, serializeCheckpoint } from '../checkpoint.ts';
import { encode } from '../codec.ts';
import { Context } from '../context.ts';
import { EMPTY_EVENT_HEAD, EventLog } from '../event-log.ts';
import {
  WorkflowRecoverySkippedEvent,
  WorkflowResumedEvent,
  WorkflowStartedEvent,
} from '../events.ts';
import type { ComposedWorkflowInterceptor } from '../interceptor.ts';
import { buildTimerBatchOperations, normalizeStorageTimestamp } from '../scheduler.ts';
import { buildIndexOperations, validateAttributeType } from '../search-attributes.ts';
import {
  StartWorkflowValidationError,
  assertExclusiveStartWorkflowOptions,
  coerceStartWorkflowId,
  coerceStartWorkflowTags,
  coerceStartWorkflowTimestamp,
  parseStartWorkflowDuration,
} from '../start-workflow-validation.ts';
import type { TenantContext } from '../tenant.ts';
import type {
  Checkpoint,
  Duration,
  ForkLineage,
  ForkOptions,
  SearchAttributeValue,
  StartOptions,
  TimerEntry,
  WorkflowState,
} from '../types.ts';
import {
  VersionMismatchError,
  buildVersionUpdateOperations,
  checkVersionCompatibility,
  migrateCheckpoint,
} from '../versioning.ts';
import { buildWorkflowTagIndexOperations, normalizeWorkflowTags } from '../workflow-tags.ts';
import {
  diffWorkflowVersionTuples,
  type WorkflowVersionDiff,
  type WorkflowVersionTuple,
} from '../workflow-version-tuple.ts';
import { validateAttributeValueSizes } from './attributes-tags.ts';
import type { QueuedInlineWorkflowExecutionStart } from './engine-internal-types.ts';
import {
  WorkflowAlreadyExistsError,
  WorkflowNotRegisteredError,
  WorkflowTypeNotRegisteredForRecoveryError,
} from './errors.ts';
import { getWorkflowExecutionStartedAt, type WorkflowHandle } from './handles.ts';
import type { EngineInternals } from './internals.ts';
import { createDelayedStartTimerEntry } from './operations-time.ts';
import {
  encodeWorkflowStartHeaders,
  normalizeForkStep,
  selectPersistedWorkflowStartHeaders,
} from './state-utilities.ts';
import {
  loadWorkflowStartHeaders as loadWorkflowStartHeadersFromStorage,
  loadWorkflowState,
} from './storage-io.ts';
import { decodeWorkflowState } from './validation.ts';
import {
  buildWorkflowVisibilityIndexOperations,
  buildWorkflowVisibilityIndexTransition,
} from './workflow-indexes.ts';

type RegistrationEntry =
  EngineInternals['registrations'] extends Map<string, infer Entry> ? Entry : never;

const FORK_LINEAGE_ATTRIBUTE = 'weft:forkedFrom';

export const EMPTY_STORAGE_VALUE = new Uint8Array(0);

/**
 * Options for {@link Engine.recoverAll}. The acknowledgement flag is an
 * explicit escape hatch for deployments that intentionally skip stored
 * workflows whose type is not registered on this engine.
 *
 * @example
 * ```ts
 * import { Engine, type RecoverAllOptions } from 'weft';
 *
 * const engine = new Engine();
 * const options: RecoverAllOptions = { acknowledgeUnknownWorkflowTypes: true };
 * await engine.recoverAll(options);
 * ```
 */
export type RecoverAllOptions = {
  /**
   * Skip stored running workflows whose type is not registered. Use only for
   * rolling deploys, explicit storage migrations, or intentional tenant
   * partitioning.
   */
  acknowledgeUnknownWorkflowTypes?: boolean;
};

export type LifecycleCallbacks = {
  dispatchEvent: (event: Event) => void;
  getHandle: (workflowId: string) => WorkflowHandle;
  createWorkflowHandleWithResultPromise: (workflowId: string) => WorkflowHandle;
  runSerializedWorkflowStateWrite: (workflowId: string, fn: () => Promise<void>) => Promise<void>;
  getComposedWorkflowInterceptor: () => ComposedWorkflowInterceptor | null;
  resolveWorkflowTypeTarget: (target: string | Function) => string;
  processPendingUpdatesAfterReplay: (workflowId: string) => void;
  processPendingUpdatesAfterInlineAdvance: (workflowId: string) => Promise<void>;
  processPendingUpdatesForHandlers: (workflowId: string) => Promise<void>;
  queueInlineWorkflowExecutionStart: (start: QueuedInlineWorkflowExecutionStart) => void;
  isInlineWorkflowLocallyOwned: (workflowId: string, workflowStatus: string) => boolean;
  hasLocalCheckpointOwnership: (workflowId: string, workflowStatus: string) => boolean;
  handleCleanupError: (source: string, error: unknown, workflowId?: string) => void;
  swallowPromiseRejection: (promise: Promise<unknown> | undefined) => Promise<void>;
};

type MissingRecoveryWorkflow = { type: string; workflowId: string };

type RecoveryPreflightEntry =
  | { kind: 'local'; workflowId: string }
  | { kind: 'missing'; workflow: MissingRecoveryWorkflow }
  | { kind: 'recoverable'; workflowId: string };

type RecoveryPreflightResult = {
  // Storage-scan order, preserving the interleaving callers observed before
  // the preflight refactor. Recovery iterates this list once, so the
  // returned WorkflowHandle[] is in the same order the original
  // single-pass `recoverAll` produced.
  entries: RecoveryPreflightEntry[];
  missingWorkflows: MissingRecoveryWorkflow[];
};

type RecoveryPreflightClassification = { kind: 'ignored' } | RecoveryPreflightEntry;

function isWorkflowSideRecordKey(key: string): boolean {
  return (
    key.includes(':ckpt') ||
    key.includes(':offload') ||
    key.includes(':archive') ||
    key.includes(':timeline:')
  );
}

function classifyRecoveryState(
  internals: EngineInternals,
  callbacks: LifecycleCallbacks,
  state: WorkflowState,
): RecoveryPreflightClassification {
  const hasLocalCheckpointOwnershipResult = callbacks.hasLocalCheckpointOwnership(
    state.id,
    state.status,
  );
  if (
    state.status === 'pending' ||
    callbacks.isInlineWorkflowLocallyOwned(state.id, state.status) ||
    hasLocalCheckpointOwnershipResult
  ) {
    return { kind: 'local', workflowId: state.id };
  }

  if (state.status !== 'running') return { kind: 'ignored' };

  if (!internals.registrations.has(state.type)) {
    return { kind: 'missing', workflow: { type: state.type, workflowId: state.id } };
  }

  return { kind: 'recoverable', workflowId: state.id };
}

function appendRecoveryClassification(
  result: RecoveryPreflightResult,
  classification: RecoveryPreflightClassification,
): void {
  if (classification.kind === 'ignored') return;
  result.entries.push(classification);
  if (classification.kind === 'missing') {
    result.missingWorkflows.push(classification.workflow);
  }
}

async function preflightRecoverAll(
  internals: EngineInternals,
  callbacks: LifecycleCallbacks,
): Promise<RecoveryPreflightResult> {
  const result: RecoveryPreflightResult = {
    entries: [],
    missingWorkflows: [],
  };

  for await (const [key, value] of internals.storage.scan('wf:')) {
    if (isWorkflowSideRecordKey(key)) continue;

    appendRecoveryClassification(
      result,
      classifyRecoveryState(internals, callbacks, decodeWorkflowState(value)),
    );
  }

  return result;
}

export async function start(
  internals: EngineInternals,
  type: string,
  input: unknown,
  options: StartOptions | undefined,
  callbacks: LifecycleCallbacks,
): Promise<WorkflowHandle> {
  return startWorkflow(internals, type, input, options, undefined, undefined, callbacks);
}

export async function recoverAll(
  internals: EngineInternals,
  callbacks: LifecycleCallbacks,
  options?: RecoverAllOptions,
): Promise<WorkflowHandle[]> {
  const preflight = await preflightRecoverAll(internals, callbacks);
  const handles: WorkflowHandle[] = [];

  if (preflight.missingWorkflows.length > 0 && options?.acknowledgeUnknownWorkflowTypes !== true) {
    throw new WorkflowTypeNotRegisteredForRecoveryError({
      registeredTypes: internals.registrations.keys(),
      missingWorkflows: preflight.missingWorkflows,
    });
  }

  // Walk preflight entries in storage-scan order so the returned handle
  // list matches the interleaving callers observed before the preflight
  // refactor (locals, missing, and recoverables stay in scan order).
  for (const entry of preflight.entries) {
    if (entry.kind === 'local') {
      handles.push(callbacks.getHandle(entry.workflowId));
      continue;
    }
    if (entry.kind === 'missing') {
      callbacks.dispatchEvent(
        new WorkflowRecoverySkippedEvent(
          entry.workflow.workflowId,
          entry.workflow.type,
          'type-not-registered',
        ),
      );
      continue;
    }
    handles.push(await resume(internals, entry.workflowId, callbacks));
  }

  return handles;
}

export async function resume(
  internals: EngineInternals,
  workflowId: string,
  callbacks: LifecycleCallbacks,
): Promise<WorkflowHandle> {
  const workflowState = await loadWorkflowState(internals, workflowId);
  if (workflowState !== null) {
    if (callbacks.isInlineWorkflowLocallyOwned(workflowId, workflowState.status)) {
      return callbacks.getHandle(workflowId);
    }

    if (callbacks.hasLocalCheckpointOwnership(workflowId, workflowState.status)) {
      return callbacks.getHandle(workflowId);
    }
  }

  return resumeWorkflowFromStorage(internals, workflowId, true, callbacks);
}

export async function fork(
  internals: EngineInternals,
  sourceWorkflowId: string,
  options: ForkOptions | undefined,
  callbacks: LifecycleCallbacks,
): Promise<WorkflowHandle> {
  const sourceState = await loadWorkflowState(internals, sourceWorkflowId);
  if (!sourceState) {
    throw new Error(`Workflow "${sourceWorkflowId}" not found`);
  }

  const registration = internals.registrations.get(sourceState.type);
  if (!registration) {
    throw new Error(
      `No workflow registered with name "${sourceState.type}" (needed to fork "${sourceWorkflowId}")`,
    );
  }

  const fromStep =
    options?.fromStep !== undefined ? normalizeForkStep(options.fromStep) : undefined;
  const checkpointKey =
    fromStep !== undefined
      ? KEYS.checkpointHistory(sourceWorkflowId, fromStep)
      : KEYS.checkpoint(sourceWorkflowId);
  const checkpointBytes = await internals.storage.get(checkpointKey);
  if (!checkpointBytes) {
    if (fromStep !== undefined) {
      throw new Error(
        `Checkpoint not found at step ${String(fromStep)} for workflow "${sourceWorkflowId}"`,
      );
    }
    throw new Error(`Checkpoint not found for workflow "${sourceWorkflowId}"`);
  }

  const sourceCheckpoint = deserializeCheckpoint(checkpointBytes);
  const preparedExecutionState = derivePreparedExecutionState(
    internals,
    sourceWorkflowId,
    sourceState,
    sourceCheckpoint,
    registration,
    callbacks,
  );
  const sourceWorkflowHeaders =
    internals.workflowHeaders.get(sourceWorkflowId) ??
    (await loadWorkflowStartHeaders(internals, sourceWorkflowId, callbacks));
  const persistedWorkflowStartHeaders = selectPersistedWorkflowStartHeaders(sourceWorkflowHeaders);

  const workflowId = crypto.randomUUID();
  const forkedAt = internals.options.getNow();
  const lineage = createForkLineage(internals, sourceWorkflowId, sourceCheckpoint, callbacks);
  const forkCheckpoint: Checkpoint = {
    ...preparedExecutionState.checkpoint,
    createdAt: forkedAt,
    workflowId,
    searchAttributes: buildForkSearchAttributes(
      internals,
      preparedExecutionState.checkpoint,
      lineage,
      callbacks,
    ),
  };
  const forkState = createForkedWorkflowState(
    internals,
    workflowId,
    preparedExecutionState.state,
    preparedExecutionState.versionTuple,
    lineage,
    forkedAt,
    callbacks,
  );

  let forkStarted = false;
  try {
    await internals.storage.batch(
      buildForkBatchOperations(
        internals,
        workflowId,
        forkState,
        forkCheckpoint,
        persistedWorkflowStartHeaders,
        callbacks,
      ),
    );
    internals.eventLogHeads.set(workflowId, EMPTY_EVENT_HEAD);
    setWorkflowStartHeaders(internals, workflowId, persistedWorkflowStartHeaders, callbacks);
    const handle = launchWorkflowFromCheckpoint(
      internals,
      workflowId,
      forkState,
      forkCheckpoint,
      registration,
      callbacks,
    );
    forkStarted = true;
    return handle;
  } finally {
    if (!forkStarted) {
      internals.checkpoints.delete(workflowId);
      internals.workflowVersionTuples.delete(workflowId);
      internals.eventLogHeads.delete(workflowId);
      internals.workflowHeaders.delete(workflowId);
    }
  }
}

// oxlint-disable-next-line complexity -- ID:core-engine-start-workflow-complexity
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
      normalizedTags,
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
    } else {
      await internals.storage.batch(startOperations);
    }
    // Deadline timer operations are now folded into the start batch above,
    // eliminating a separate storage transaction on the hot start path.

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
      internals.checkpoints.delete(workflowId);
      internals.workflowHeaders.delete(workflowId);
      internals.workflowVersionTuples.delete(workflowId);
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

/** Build a {@link WorkflowVersionTuple} from a {@link RegistrationEntry}. */
export function createWorkflowVersionTuple(
  _internals: EngineInternals,
  registration: RegistrationEntry,
  tenant: TenantContext | undefined,
  _callbacks: LifecycleCallbacks,
): WorkflowVersionTuple {
  if (registration.versionTupleForTenant) {
    return registration.versionTupleForTenant(tenant);
  }

  return {
    workflowVersion: registration.version,
  };
}

export function workflowVersionTupleFromState(
  _internals: EngineInternals,
  state: WorkflowState,
  _callbacks: LifecycleCallbacks,
): WorkflowVersionTuple {
  return {
    workflowVersion: state.version,
    ...(state.agentVersion !== undefined && { agentVersion: state.agentVersion }),
    ...(state.toolVersions !== undefined && { toolVersions: state.toolVersions }),
  };
}

export function workflowStateWithVersionTuple(
  internals: EngineInternals,
  state: WorkflowState,
  versionTuple: WorkflowVersionTuple,
  _callbacks: LifecycleCallbacks,
): WorkflowState {
  const {
    agentVersion: _existingAgentVersion,
    toolVersions: _existingToolVersions,
    ...rest
  } = state;

  return {
    ...rest,
    version: versionTuple.workflowVersion,
    updatedAt: internals.options.getNow(),
    ...(versionTuple.agentVersion !== undefined && {
      agentVersion: versionTuple.agentVersion,
    }),
    ...(versionTuple.toolVersions !== undefined && {
      toolVersions: versionTuple.toolVersions,
    }),
  };
}

export function derivePreparedExecutionState(
  internals: EngineInternals,
  workflowId: string,
  state: WorkflowState,
  checkpoint: Checkpoint,
  registration: RegistrationEntry,
  callbacks: LifecycleCallbacks,
): {
  state: WorkflowState;
  checkpoint: Checkpoint;
  versionTuple: WorkflowVersionTuple;
  shouldPersistPreparedState: boolean;
} {
  const compatibility = checkVersionCompatibility(
    checkpoint.version,
    registration.version,
    !!registration.migrate,
  );
  const registeredVersionTuple = createWorkflowVersionTuple(
    internals,
    registration,
    state.tenant,
    callbacks,
  );
  const versionDiff = diffWorkflowVersionTuples(
    workflowVersionTupleFromState(internals, state, callbacks),
    registeredVersionTuple,
  );
  const hasVersionTupleDrift =
    versionDiff.workflowVersion !== undefined ||
    versionDiff.agentVersion !== undefined ||
    versionDiff.toolVersions !== undefined;

  if (compatibility === 'incompatible' || (hasVersionTupleDrift && !registration.migrate)) {
    throwVersionMismatch(internals, workflowId, state, registration, versionDiff, callbacks);
  }

  let preparedState = state;
  let preparedCheckpoint = checkpoint;
  let shouldPersistPreparedState = false;

  if ((compatibility === 'needs-migration' || hasVersionTupleDrift) && registration.migrate) {
    const migrated = migrateCheckpoint(
      checkpoint,
      checkpoint.version,
      registration.version,
      registration.migrate,
    ) as Checkpoint;
    migrated.version = registeredVersionTuple.workflowVersion;
    preparedCheckpoint = migrated;
    preparedState = workflowStateWithVersionTuple(
      internals,
      state,
      registeredVersionTuple,
      callbacks,
    );
    shouldPersistPreparedState = true;
  }

  return {
    state: preparedState,
    checkpoint: preparedCheckpoint,
    versionTuple: registeredVersionTuple,
    shouldPersistPreparedState,
  };
}

export async function prepareResumeState(
  internals: EngineInternals,
  workflowId: string,
  state: WorkflowState,
  checkpoint: Checkpoint,
  registration: RegistrationEntry,
  callbacks: LifecycleCallbacks,
): Promise<{
  state: WorkflowState;
  checkpoint: Checkpoint;
  versionTuple: WorkflowVersionTuple;
}> {
  const preparedExecutionState = derivePreparedExecutionState(
    internals,
    workflowId,
    state,
    checkpoint,
    registration,
    callbacks,
  );

  if (preparedExecutionState.shouldPersistPreparedState) {
    const versionVisibilityOperations = buildWorkflowVisibilityIndexTransition(
      workflowId,
      state,
      preparedExecutionState.state,
    ).batchOps;
    await internals.storage.batch([
      ...buildVersionUpdateOperations(
        workflowId,
        serializeCheckpoint(preparedExecutionState.checkpoint),
        preparedExecutionState.versionTuple.workflowVersion,
        encode(preparedExecutionState.state),
      ),
      ...versionVisibilityOperations,
    ]);
  }

  return {
    state: preparedExecutionState.state,
    checkpoint: preparedExecutionState.checkpoint,
    versionTuple: preparedExecutionState.versionTuple,
  };
}

/** Throws a {@link VersionMismatchError} with a full version diff. Never returns. */
export function throwVersionMismatch(
  _internals: EngineInternals,
  workflowId: string,
  state: WorkflowState,
  registration: RegistrationEntry,
  versionDiff: WorkflowVersionDiff,
  _callbacks: LifecycleCallbacks,
): never {
  throw new VersionMismatchError(
    workflowId,
    state.type,
    state.version,
    registration.version,
    undefined,
    versionDiff,
  );
}

// oxlint-disable-next-line complexity -- ID:core-engine-create-initial-workflow-state-complexity
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
  const state: WorkflowState = {
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

  if (options?.executionTimeout !== undefined && !delayedStartTimer) {
    const executionTimeoutMilliseconds = parseStartOptionDuration(
      internals,
      options.executionTimeout,
      'options.executionTimeout',
      callbacks,
    );
    let executionDeadline: number;
    try {
      executionDeadline = normalizeStorageTimestamp(
        now + executionTimeoutMilliseconds,
        'options.executionTimeout',
      );
    } catch {
      throw new StartWorkflowValidationError(
        'options.executionTimeout must resolve to a finite, non-negative deadline',
      );
    }
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

export function buildStartBatchOperations(
  _internals: EngineInternals,
  workflowId: string,
  state: WorkflowState,
  checkpoint: Checkpoint,
  registration: RegistrationEntry,
  options: StartOptions | undefined,
  executionDeadline: number | undefined,
  delayedStartTimer: TimerEntry | undefined,
  workflowStartHeaders: Map<string, string> | undefined,
  additionalOperations: BatchOperation[] | undefined,
  callbacks: LifecycleCallbacks,
): BatchOperation[] {
  const visibilityIndexOperations = buildWorkflowVisibilityIndexOperations(
    workflowId,
    null,
    state,
  ).batchOps;
  const operations: BatchOperation[] = [
    { type: 'put', key: KEYS.workflow(workflowId), value: encode(state) },
    {
      type: 'put',
      key: KEYS.checkpoint(workflowId),
      value: serializeCheckpoint(checkpoint),
    },
    ...visibilityIndexOperations,
    ...buildWorkflowTagIndexOperations(workflowId, undefined, state.tags),
    ...buildInitialSearchAttributeOperations(
      _internals,
      workflowId,
      registration,
      options?.searchAttributes,
      callbacks,
    ),
    ...(workflowStartHeaders && workflowStartHeaders.size > 0
      ? [
          {
            type: 'put' as const,
            key: KEYS.workflowHeaders(workflowId),
            value: encodeWorkflowStartHeaders(workflowStartHeaders),
          },
          {
            type: 'put' as const,
            key: KEYS.terminalCleanupNeeded(workflowId),
            value: EMPTY_STORAGE_VALUE,
          },
        ]
      : []),
    ...(additionalOperations ?? []),
  ];

  // Fold deadline timer operations into the same batch so workflows with
  // an execution timeout don't pay for a second storage transaction.
  // Uses the shared helper so key format stays in sync with Scheduler.
  if (executionDeadline !== undefined) {
    operations.push(
      ...buildTimerBatchOperations({
        id: `deadline:${workflowId}`,
        workflowId,
        fireAt: executionDeadline,
        kind: 'execution-deadline',
      }),
    );
  }

  if (delayedStartTimer) {
    operations.push(...buildTimerBatchOperations(delayedStartTimer));
  }

  return operations;
}

export function buildInitialSearchAttributeOperations(
  _internals: EngineInternals,
  workflowId: string,
  registration: RegistrationEntry,
  searchAttributes: StartOptions['searchAttributes'],
  callbacks: LifecycleCallbacks,
): BatchOperation[] {
  if (!searchAttributes || Object.keys(searchAttributes).length === 0) {
    return [];
  }

  validateSearchAttributes(_internals, registration, searchAttributes, callbacks);
  validateAttributeValueSizes(searchAttributes);

  return [
    {
      type: 'put',
      key: KEYS.attribute(workflowId),
      value: encode(searchAttributes),
    },
    ...buildIndexOperations(workflowId, {}, searchAttributes),
  ];
}

export function validateSearchAttributes(
  _internals: EngineInternals,
  registration: RegistrationEntry,
  searchAttributes: Record<string, SearchAttributeValue>,
  _callbacks: LifecycleCallbacks,
): void {
  if (!registration.searchAttributes) {
    return;
  }

  const schema = registration.searchAttributes;
  for (const [key, value] of Object.entries(searchAttributes)) {
    if (!(key in schema)) {
      throw new Error(
        `Unknown search attribute "${key}". Registered attributes: ${Object.keys(schema).join(', ')}`,
      );
    }
    validateAttributeType(key, value, schema[key]!);
  }
}

export function runWorkflowStartInterceptor(
  _internals: EngineInternals,
  workflowId: string,
  workflowType: string,
  input: unknown,
  parentHeaders: Map<string, string> | undefined,
  callbacks: LifecycleCallbacks,
): Map<string, string> | undefined {
  const composedInterceptor = callbacks.getComposedWorkflowInterceptor();
  if (!composedInterceptor) {
    return undefined;
  }

  const headers = new Map<string, string>();
  if (parentHeaders) {
    for (const [key, value] of parentHeaders) {
      headers.set(key, value);
    }
  }

  let capturedHeaders: Map<string, string> | undefined;
  composedInterceptor.workflowStart(
    {
      workflowId,
      workflowType,
      input,
      headers,
    },
    (interception) => {
      capturedHeaders = new Map(interception.headers);
    },
  );

  return capturedHeaders;
}

export function createWorkflowHandle(
  _internals: EngineInternals,
  workflowId: string,
  callbacks: Pick<LifecycleCallbacks, 'createWorkflowHandleWithResultPromise'>,
): WorkflowHandle {
  return callbacks.createWorkflowHandleWithResultPromise(workflowId);
}

export function setWorkflowStartHeaders(
  internals: EngineInternals,
  workflowId: string,
  headers: Map<string, string> | undefined,
  _callbacks: LifecycleCallbacks,
): void {
  if (!headers || headers.size === 0) {
    internals.workflowHeaders.delete(workflowId);
    return;
  }

  internals.workflowHeaders.set(workflowId, new Map(headers));
  internals.workflowsNeedingTerminalCleanup.add(workflowId);
}

export async function loadWorkflowStartHeaders(
  internals: EngineInternals,
  workflowId: string,
  _callbacks: LifecycleCallbacks,
): Promise<Map<string, string> | undefined> {
  return loadWorkflowStartHeadersFromStorage(internals, workflowId);
}

export async function loadTerminalCleanupTrackedState(
  internals: EngineInternals,
  workflowId: string,
  _callbacks: LifecycleCallbacks,
): Promise<void> {
  if (await storageHas(internals.storage, KEYS.terminalCleanupNeeded(workflowId))) {
    internals.workflowsNeedingTerminalCleanup.add(workflowId);
  }
}

export function startWorkflowExecution(
  internals: EngineInternals,
  workflowId: string,
  workflowType: string,
  input: unknown,
  checkpoint: Checkpoint,
  nestingDepth: number,
  executionDeadline: number | undefined,
  executionStateOwnerId: string,
  tenant: TenantContext | undefined,
  _callbacks?: LifecycleCallbacks,
): void {
  // Skip the map entry for the common non-nested case — readers fall back
  // to 0. Saves per-workflow V8 Map overhead (~80 bytes) on the hot path.
  if (nestingDepth !== 0) {
    internals.workflowNestingDepths.set(workflowId, nestingDepth);
  }
  internals.strategy.startWorkflow({
    workflowId,
    workflowType,
    input,
    checkpoint: serializeCheckpoint(checkpoint),
    nestingDepth,
    executionStateOwnerId,
    startedAt: checkpoint.createdAt,
    sleepReferenceTime: checkpoint.createdAt,
    ...(executionDeadline !== undefined && { deadline: executionDeadline }),
    ...(internals.workflowHeaders.has(workflowId) && {
      headers: [...internals.workflowHeaders.get(workflowId)!],
    }),
    ...(tenant !== undefined && { tenant }),
  });
}

export function createForkLineage(
  _internals: EngineInternals,
  sourceWorkflowId: string,
  checkpoint: Checkpoint,
  _callbacks: LifecycleCallbacks,
): ForkLineage {
  return {
    workflowId: sourceWorkflowId,
    step: checkpoint.step,
  };
}

export function buildForkSearchAttributes(
  _internals: EngineInternals,
  checkpoint: Checkpoint,
  lineage: ForkLineage,
  _callbacks: LifecycleCallbacks,
): Record<string, SearchAttributeValue> {
  return {
    ...checkpoint.searchAttributes,
    [FORK_LINEAGE_ATTRIBUTE]: lineage.workflowId,
  };
}

export function createForkedWorkflowState(
  _internals: EngineInternals,
  workflowId: string,
  sourceState: WorkflowState,
  versionTuple: WorkflowVersionTuple,
  lineage: ForkLineage,
  forkedAt: number,
  _callbacks: LifecycleCallbacks,
): WorkflowState {
  return {
    id: workflowId,
    type: sourceState.type,
    status: 'running',
    input: sourceState.input,
    version: versionTuple.workflowVersion,
    executionStateOwnerId: workflowId,
    createdAt: forkedAt,
    startedAt: forkedAt,
    updatedAt: forkedAt,
    ...(versionTuple.agentVersion !== undefined && {
      agentVersion: versionTuple.agentVersion,
    }),
    ...(versionTuple.toolVersions !== undefined && {
      toolVersions: versionTuple.toolVersions,
    }),
    ...(sourceState.tenant !== undefined && { tenant: sourceState.tenant }),
    forkedFrom: lineage,
  };
}

export function buildForkBatchOperations(
  _internals: EngineInternals,
  workflowId: string,
  state: WorkflowState,
  checkpoint: Checkpoint,
  workflowStartHeaders: Map<string, string> | undefined,
  _callbacks: LifecycleCallbacks,
): BatchOperation[] {
  const operations: BatchOperation[] = [
    { type: 'put', key: KEYS.workflow(workflowId), value: encode(state) },
    {
      type: 'put',
      key: KEYS.checkpoint(workflowId),
      value: serializeCheckpoint(checkpoint),
    },
    ...buildWorkflowVisibilityIndexOperations(workflowId, null, state).batchOps,
  ];

  if (Object.keys(checkpoint.searchAttributes).length > 0) {
    operations.push(
      {
        type: 'put',
        key: KEYS.attribute(workflowId),
        value: encode(checkpoint.searchAttributes),
      },
      ...buildIndexOperations(workflowId, {}, checkpoint.searchAttributes),
    );
  }

  if (workflowStartHeaders && workflowStartHeaders.size > 0) {
    operations.push(
      {
        type: 'put',
        key: KEYS.workflowHeaders(workflowId),
        value: encodeWorkflowStartHeaders(workflowStartHeaders),
      },
      {
        type: 'put',
        key: KEYS.terminalCleanupNeeded(workflowId),
        value: EMPTY_STORAGE_VALUE,
      },
    );
  }

  return operations;
}

function launchInlineWorkflowFromCheckpoint(
  internals: EngineInternals,
  workflowId: string,
  state: WorkflowState,
  checkpoint: Checkpoint,
  registration: RegistrationEntry,
  callbacks: LifecycleCallbacks,
): void {
  const inlineStrategy = internals.inlineStrategy;
  if (!inlineStrategy) {
    throw new Error('Inline workflow launch requested without an inline strategy.');
  }

  const accumulatedResults = new Map<number, unknown>(checkpoint.accumulatedResults);
  const workflowAbort = new AbortController();

  const context = new Context({
    workflowId,
    workflowType: state.type,
    startedAt: getWorkflowExecutionStartedAt(state),
    abortController: workflowAbort,
    getNow: internals.options.getNow,
    resolveWorkflowType: callbacks.resolveWorkflowTypeTarget,
    executionStateOwnerId: state.executionStateOwnerId ?? workflowId,
    accumulatedResults,
    searchAttributes: checkpoint.searchAttributes,
    ...(registration.searchAttributes && {
      searchAttributeSchema: registration.searchAttributes,
    }),
    sleepReferenceTime: checkpoint.createdAt,
    ...(state.executionDeadline !== undefined && { deadline: state.executionDeadline }),
    ...(state.tenant !== undefined && { tenant: state.tenant }),
  });

  if (internals.options.development) {
    context.explain(true);
  }

  const generator = registration.handler(context, state.input);
  inlineStrategy.adoptWorkflow(workflowId, generator, context, workflowAbort);
  inlineStrategy.continueWorkflow(workflowId, undefined);
  void callbacks.swallowPromiseRejection(
    callbacks.processPendingUpdatesAfterInlineAdvance(workflowId),
  );
}

function launchWorkerWorkflowFromCheckpoint(
  internals: EngineInternals,
  workflowId: string,
  state: WorkflowState,
  checkpoint: Checkpoint,
): void {
  const serialized = serializeCheckpoint(checkpoint);
  internals.strategy.startWorkflow({
    workflowId,
    workflowType: state.type,
    input: state.input,
    checkpoint: serialized,
    executionStateOwnerId: state.executionStateOwnerId ?? workflowId,
    ...(state.executionDeadline !== undefined && { deadline: state.executionDeadline }),
    ...(internals.workflowHeaders.has(workflowId) && {
      headers: [...internals.workflowHeaders.get(workflowId)!],
    }),
    ...(state.tenant !== undefined && { tenant: state.tenant }),
  });
}

export function launchWorkflowFromCheckpoint(
  internals: EngineInternals,
  workflowId: string,
  state: WorkflowState,
  checkpoint: Checkpoint,
  registration: RegistrationEntry,
  callbacks: LifecycleCallbacks,
): WorkflowHandle {
  // Store checkpoint for future persistence
  internals.checkpoints.set(workflowId, checkpoint);
  internals.workflowVersionTuples.set(
    workflowId,
    createWorkflowVersionTuple(internals, registration, state.tenant, callbacks),
  );

  const handle = createWorkflowHandle(internals, workflowId, callbacks);
  callbacks.dispatchEvent(new WorkflowStartedEvent(workflowId, state.type, state.input));

  if (internals.inlineStrategy) {
    launchInlineWorkflowFromCheckpoint(
      internals,
      workflowId,
      state,
      checkpoint,
      registration,
      callbacks,
    );
  } else {
    launchWorkerWorkflowFromCheckpoint(internals, workflowId, state, checkpoint);
  }

  return handle;
}

export async function resumeWorkflowFromStorage(
  internals: EngineInternals,
  workflowId: string,
  dispatchResumedEvent: boolean,
  callbacks: LifecycleCallbacks,
): Promise<WorkflowHandle> {
  // Load workflow state
  const stateBytes = await internals.storage.get(KEYS.workflow(workflowId));
  if (!stateBytes) {
    throw new Error(`Workflow "${workflowId}" not found in storage`);
  }

  const state = decodeWorkflowState(stateBytes);
  if (state.status !== 'running') {
    throw new Error(
      `Cannot resume workflow "${workflowId}": status is "${state.status}", expected "running"`,
    );
  }

  // Load checkpoint
  const checkpointBytes = await internals.storage.get(KEYS.checkpoint(workflowId));
  if (!checkpointBytes) {
    throw new Error(`Checkpoint not found for workflow "${workflowId}"`);
  }

  const checkpoint = deserializeCheckpoint(checkpointBytes);

  // Look up registration
  const registration = internals.registrations.get(state.type);
  if (!registration) {
    throw new Error(
      `No workflow registered with name "${state.type}" (needed to resume "${workflowId}")`,
    );
  }

  const preparedResumeState = await prepareResumeState(
    internals,
    workflowId,
    state,
    checkpoint,
    registration,
    callbacks,
  );
  const resumeCheckpoint = preparedResumeState.checkpoint;
  const registeredVersionTuple = preparedResumeState.versionTuple;

  // Restore the event log head from storage so that the next appendToBatch()
  // call uses the correct sequence number and prevHash rather than falling
  // back to EMPTY_EVENT_HEAD (sequence -1) and overwriting existing entries.
  const eventLog = new EventLog(internals.storage, workflowId);
  const restoredHead = await eventLog.loadHead();
  const workflowStartHeaders = await loadWorkflowStartHeaders(internals, workflowId, callbacks);
  await loadTerminalCleanupTrackedState(internals, workflowId, callbacks);

  const handle = callbacks.getHandle(workflowId);
  // oxlint-disable-next-line complexity -- ID:core-engine-line-5082-complexity
  await callbacks.runSerializedWorkflowStateWrite(workflowId, async () => {
    if (internals.terminalizingWorkflows.has(workflowId)) {
      throw new Error(`Cannot resume workflow "${workflowId}": termination is in progress`);
    }

    const latestState = await loadWorkflowState(internals, workflowId);
    if (internals.terminalizingWorkflows.has(workflowId)) {
      throw new Error(`Cannot resume workflow "${workflowId}": termination is in progress`);
    }

    if (!latestState) {
      throw new Error(`Workflow "${workflowId}" not found in storage`);
    }

    if (latestState.status !== 'running') {
      throw new Error(
        `Cannot resume workflow "${workflowId}": status is "${latestState.status}", expected "running"`,
      );
    }

    internals.checkpoints.set(workflowId, resumeCheckpoint);
    internals.workflowVersionTuples.set(workflowId, registeredVersionTuple);
    internals.eventLogHeads.set(workflowId, restoredHead);
    setWorkflowStartHeaders(internals, workflowId, workflowStartHeaders, callbacks);
    internals.parkedInlineWorkflows.delete(workflowId);

    if (internals.inlineStrategy) {
      // Keep the final running-state check and the re-entry into user code
      // in the same serialized section so cancel/timeout cannot commit a
      // terminal state and still let a parked workflow continue.
      const accumulatedResults = new Map<number, unknown>(resumeCheckpoint.accumulatedResults);
      const workflowAbort = new AbortController();

      const context = new Context({
        workflowId,
        workflowType: latestState.type,
        startedAt: getWorkflowExecutionStartedAt(latestState),
        abortController: workflowAbort,
        getNow: internals.options.getNow,
        resolveWorkflowType: callbacks.resolveWorkflowTypeTarget,
        executionStateOwnerId: latestState.executionStateOwnerId ?? workflowId,
        accumulatedResults,
        locals: resumeCheckpoint.locals,
        searchAttributes: resumeCheckpoint.searchAttributes,
        ...(registration.searchAttributes && {
          searchAttributeSchema: registration.searchAttributes,
        }),
        sleepReferenceTime: resumeCheckpoint.createdAt,
        ...(latestState.executionDeadline !== undefined && {
          deadline: latestState.executionDeadline,
        }),
        ...(latestState.tenant !== undefined && { tenant: latestState.tenant }),
      });

      if (internals.options.development) {
        context.explain(true);
      }

      const generator = registration.handler(context, latestState.input);
      internals.inlineStrategy.adoptWorkflow(workflowId, generator, context, workflowAbort);
      internals.inlineStrategy.continueWorkflow(workflowId, undefined);
    } else {
      const serialized = serializeCheckpoint(resumeCheckpoint);
      internals.strategy.startWorkflow({
        workflowId,
        workflowType: latestState.type,
        input: latestState.input,
        checkpoint: serialized,
        nestingDepth: internals.workflowNestingDepths.get(workflowId) ?? 0,
        executionStateOwnerId: latestState.executionStateOwnerId ?? workflowId,
        ...(latestState.executionDeadline !== undefined && {
          deadline: latestState.executionDeadline,
        }),
        ...(workflowStartHeaders !== undefined &&
          workflowStartHeaders.size > 0 && {
            headers: [...workflowStartHeaders],
          }),
        ...(latestState.tenant !== undefined && { tenant: latestState.tenant }),
      });
    }
  });

  if (dispatchResumedEvent) {
    callbacks.dispatchEvent(new WorkflowResumedEvent(workflowId, resumeCheckpoint.step));
  }
  if (internals.inlineStrategy) {
    void callbacks.swallowPromiseRejection(
      callbacks.processPendingUpdatesAfterInlineAdvance(workflowId),
    );
  }

  return handle;
}

export function normalizeStartWorkflowTags(
  _internals: EngineInternals,
  tags: unknown,
  fieldName: string | undefined,
  _callbacks: LifecycleCallbacks,
): string[] | undefined {
  if (tags === undefined) {
    return undefined;
  }

  return normalizeWorkflowTags(coerceStartWorkflowTags(tags, fieldName ?? 'options.tags'));
}

export async function processPendingUpdatesAfterReplay(
  _internals: EngineInternals,
  workflowId: string,
  callbacks: Pick<LifecycleCallbacks, 'handleCleanupError' | 'processPendingUpdatesForHandlers'>,
): Promise<void> {
  try {
    await callbacks.processPendingUpdatesForHandlers(workflowId);
  } catch (error: unknown) {
    callbacks.handleCleanupError('processPendingUpdates', error, workflowId);
  }
}
