/* oxlint-disable max-lines -- ID:core-engine-callback-creators-file-length */
import { KEYS } from '../../storage/interface.ts';
import type { ContextOperationRequest } from '../context.ts';
import { UpdateCompletedEvent } from '../events.ts';
import type { HumanReviewOptions } from '../review/index.ts';
import type { ScheduleState, TimerEntry } from '../types.ts';
import { validateAttributeValueSizes } from './attributes-tags.ts';
import {
  broadcast as broadcastFromInternals,
  dispatchPendingUpdateReceived as dispatchPendingUpdateReceivedFromBroadcast,
  forwardEventToHandle as forwardEventToHandleFromBroadcast,
  type BroadcastCallbacks,
} from './broadcast.ts';
import {
  appendTimelineBatchOperations,
  persistCheckpoint,
  pruneCheckpointHistory,
  validateDevelopmentCheckpoint,
} from './checkpoint-io.ts';
import {
  processChildWorkflowOperation,
  type ChildWorkflowOperationCallbacks,
} from './child-workflow.ts';
import { evaluateConstraints, type ConstraintCallbacks } from './constraints.ts';
import {
  guardTerminalWorkflow,
  guardTerminalWorkflowAfterCoordinatedRequest,
  type GuardCallbacks,
} from './guards.ts';
import { createWorkflowHandleWithResultPromise } from './handle-result.ts';
import type { Engine } from './index.ts';
import {
  flushQueuedInlineWorkflowStartsDirectly,
  hasLocalCheckpointOwnership,
  isInlineWorkflowLocallyOwned,
  queueInlineWorkflowExecutionStart,
  type InlineLaunchQueueCallbacks,
} from './inline-launch-queue.ts';
import {
  getParkedWorkflowResumeDisposition,
  parkInlineWorkflowAfterCheckpoint,
  resumeParkedInlineWorkflow,
  type InlineParkingCallbacks,
} from './inline-parking.ts';
import { getInternals } from './internals.ts';
import {
  beginWorkflowExecution,
  loadWorkflowStartHeaders,
  parseStartOptionDuration,
  processPendingUpdatesAfterReplay,
  setWorkflowStartHeaders,
  startWorkflow,
  workflowVersionTupleFromState,
  type LifecycleCallbacks,
} from './lifecycle.ts';
import {
  processActivityOperation,
  type ActivityOperationCallbacks,
} from './operations-activity.ts';
import {
  processParallelOperation,
  processRaceOperation,
  processRunAllOperation,
  processWaitSignalOperation,
  type CoordinationOperationCallbacks,
} from './operations-coordination.ts';
import {
  processArchiveOperation,
  processLoadOperation,
  processMemoOperation,
  processOffloadOperation,
  type DataOperationCallbacks,
} from './operations-data.ts';
import {
  completeOperation,
  processOperation,
  runOperationWithResult,
  runOperationWithoutResult,
  translateOperationRequest,
  type OperationRouterCallbacks,
  type OperationWithCallerStack,
} from './operations-router.ts';
import { processSpeculateOperation } from './operations-speculate.ts';
import {
  processStateCommitOperation,
  processStateReadOperation,
  type StateOperationCallbacks,
} from './operations-state.ts';
import { processStreamOperation, type StreamOperationCallbacks } from './operations-stream.ts';
import { processSleepOperation, type TimeOperationCallbacks } from './operations-time.ts';
import {
  processPendingUpdatesAfterInlineAdvance,
  processPendingUpdatesForHandlers,
  schedulePendingInlineUpdateDrain,
} from './pending-updates.ts';
import { resolveWorkflowTypeTarget, type RegistrationCallbacks } from './registration.ts';
import {
  ensureRetentionSweepInterval,
  hasConfiguredRetention,
  runRetentionSweep,
  setNextRetentionSweepAt,
} from './retention.ts';
import {
  cleanupReviews,
  processReviewOperation,
  type ReviewOperationCallbacks,
  type SubmitReviewCallbacks,
} from './reviews.ts';
import {
  applyScheduleOccurrence,
  handleScheduleTimer,
  handleScheduledWorkflowTerminal,
  refreshScheduledWorkflowState,
  settleBackfillScheduleState,
  startScheduledRun,
  type RefreshedScheduleState,
  type ScheduleCallbacks,
} from './schedules.ts';
import { hasBufferedSignal } from './signals.ts';
import type { SpeculativeExecutionState } from './speculative-execution-state.ts';
import {
  commitWorkflowStateOperations,
  loadWorkflowState,
  runSerializedWorkflowStateWrite,
} from './storage-io.ts';
import {
  feedOperationResult,
  getComposedActivityInterceptor,
  getComposedWorkflowInterceptor,
  swallowPromiseRejection,
} from './strategy-helpers.ts';
import { executeSubOperation, processWaitReviewOperation } from './sub-operation.ts';
import {
  cleanupWaiters,
  ensureTerminalCleanupTracked,
  failWorkflow,
  finalizePendingTimelineEntry,
  handleCleanupError,
  runDeferredTerminalCleanup,
  type TerminationCallbacks,
} from './termination.ts';
import {
  createCoordinatedUpdateResponder,
  deliverCoordinatedUpdateToWaiterIfAvailable,
  findPendingUpdateByName,
  processWaitUpdateOperation,
  type UpdateCallbacks,
} from './updates.ts';

function createPendingUpdateCallbacks<TWorkflows extends object, TActivities extends object>(
  engine: Engine<TWorkflows, TActivities>,
): {
  dispatchEvent: (event: Event) => boolean;
  broadcast: (message: { type: 'update:completed'; workflowId: string; updateId: string }) => void;
} {
  return {
    dispatchEvent: (event) => engine.dispatchEvent(event),
    broadcast: (message) =>
      broadcastFromInternals(getInternals(engine), message, createBroadcastCallbacks(engine)),
  };
}

function createInlineLaunchQueueCallbacks<TWorkflows extends object, TActivities extends object>(
  engine: Engine<TWorkflows, TActivities>,
): InlineLaunchQueueCallbacks {
  return {
    processPendingUpdatesAfterInlineAdvance: (workflowId) =>
      processPendingUpdatesAfterInlineAdvanceForEngine(engine, workflowId),
    swallowPromiseRejection: (promise) => swallowPromiseRejection(promise),
  };
}

async function processPendingUpdatesAfterInlineAdvanceForEngine<
  TWorkflows extends object,
  TActivities extends object,
>(engine: Engine<TWorkflows, TActivities>, workflowId: string): Promise<void> {
  try {
    await processPendingUpdatesAfterInlineAdvance(
      getInternals(engine),
      workflowId,
      createPendingUpdateCallbacks(engine),
    );
  } catch (error: unknown) {
    createTerminationCallbacks(engine).handleCleanupError(
      'processPendingUpdates',
      error,
      workflowId,
    );
  }
}

export function createLifecycleCallbacks<TWorkflows extends object, TActivities extends object>(
  engine: Engine<TWorkflows, TActivities>,
): LifecycleCallbacks {
  return {
    dispatchEvent: (event) => {
      engine.dispatchEvent(event);
    },
    getHandle: (workflowId) => engine.getHandle(workflowId),
    createWorkflowHandleWithResultPromise: (workflowId) =>
      createWorkflowHandleWithResultPromise(getInternals(engine), workflowId),
    runSerializedWorkflowStateWrite: (workflowId, writeOperation) =>
      runSerializedWorkflowStateWrite(getInternals(engine), workflowId, writeOperation),
    getComposedWorkflowInterceptor: () => getComposedWorkflowInterceptor(getInternals(engine)),
    resolveWorkflowTypeTarget: (target) =>
      resolveWorkflowTypeTarget(getInternals(engine), target, createRegistrationCallbacks(engine)),
    processPendingUpdatesAfterReplay: (workflowId) => {
      void processPendingUpdatesAfterReplay(getInternals(engine), workflowId, {
        processPendingUpdatesForHandlers: (id) =>
          processPendingUpdatesForHandlers(
            getInternals(engine),
            id,
            createPendingUpdateCallbacks(engine),
          ),
        handleCleanupError: (source, error, id) =>
          createTerminationCallbacks(engine).handleCleanupError(source, error, id),
      });
    },
    processPendingUpdatesAfterInlineAdvance: (workflowId) =>
      processPendingUpdatesAfterInlineAdvanceForEngine(engine, workflowId),
    processPendingUpdatesForHandlers: (workflowId) =>
      processPendingUpdatesForHandlers(
        getInternals(engine),
        workflowId,
        createPendingUpdateCallbacks(engine),
      ),
    queueInlineWorkflowExecutionStart: (start) =>
      queueInlineWorkflowExecutionStart(
        getInternals(engine),
        start,
        createInlineLaunchQueueCallbacks(engine),
      ),
    isInlineWorkflowLocallyOwned: (workflowId, workflowStatus) =>
      isInlineWorkflowLocallyOwned(getInternals(engine), workflowId, workflowStatus),
    hasLocalCheckpointOwnership: (workflowId, workflowStatus) =>
      hasLocalCheckpointOwnership(getInternals(engine), workflowId, workflowStatus),
    handleCleanupError: (source, error, workflowId) =>
      createTerminationCallbacks(engine).handleCleanupError(source, error, workflowId),
    swallowPromiseRejection: (promise) => swallowPromiseRejection(promise),
  };
}

export function createTerminationCallbacks<TWorkflows extends object, TActivities extends object>(
  engine: Engine<TWorkflows, TActivities>,
): TerminationCallbacks {
  const dispatchEvent = (event: Event): void => {
    engine.dispatchEvent(event);
  };
  return {
    dispatchEvent,
    forwardEventToHandle: (workflowId, event) =>
      forwardEventToHandleFromBroadcast(
        getInternals(engine),
        workflowId,
        event,
        createBroadcastCallbacks(engine),
      ),
    broadcast: (message) =>
      broadcastFromInternals(getInternals(engine), message, createBroadcastCallbacks(engine)),
    swallowPromiseRejection: (promise) => swallowPromiseRejection(promise),
    handleCleanupError: (source, error, workflowId) =>
      handleCleanupError(getInternals(engine), source, error, workflowId, { dispatchEvent }),
    handleScheduledWorkflowTerminal: (workflowId) =>
      handleScheduledWorkflowTerminalForEngine(engine, workflowId),
    loadWorkflowState: (workflowId) => loadWorkflowState(getInternals(engine), workflowId),
    runSerializedWorkflowStateWrite: (workflowId, writeOperation) =>
      runSerializedWorkflowStateWrite(getInternals(engine), workflowId, writeOperation),
    commitWorkflowStateOperations: (state, operations, options) =>
      commitWorkflowStateOperations(getInternals(engine), state, operations, options),
    cleanupReviews: (workflowId) => cleanupReviews(getInternals(engine), workflowId),
  };
}

export function createRegistrationCallbacks<TWorkflows extends object, TActivities extends object>(
  engine: Engine<TWorkflows, TActivities>,
): RegistrationCallbacks {
  return {
    ensureRetentionSweepInterval: () => ensureRetentionSweepIntervalForEngine(engine),
  };
}
export function createBroadcastCallbacks<TWorkflows extends object, TActivities extends object>(
  engine: Engine<TWorkflows, TActivities>,
): BroadcastCallbacks {
  return { dispatchEvent: (event) => engine.dispatchEvent(event) };
}
export function createGuardCallbacks<TWorkflows extends object, TActivities extends object>(
  engine: Engine<TWorkflows, TActivities>,
): GuardCallbacks {
  return {
    deleteRequestIfUnconsumed: (workflowId, updateId) =>
      getInternals(engine).updateCoordinator.deleteRequestIfUnconsumed(workflowId, updateId),
    getUpdateResponse: (updateId) => getInternals(engine).updateCoordinator.getResponse(updateId),
  };
}
export function createConstraintCallbacks<TWorkflows extends object, TActivities extends object>(
  engine: Engine<TWorkflows, TActivities>,
): ConstraintCallbacks {
  return {
    cancelWorkflowInStrategy: (workflowId) =>
      getInternals(engine).strategy.cancelWorkflow(workflowId),
    dispatchEvent: (event) => engine.dispatchEvent(event),
    failWorkflow: (workflowId, error) =>
      failWorkflow(getInternals(engine), workflowId, error, createTerminationCallbacks(engine)),
    feedOperationResult: (workflowId, outcome, originalError) =>
      feedOperationResult(getInternals(engine), workflowId, outcome, originalError),
  };
}

export function createInlineParkingCallbacks<TWorkflows extends object, TActivities extends object>(
  engine: Engine<TWorkflows, TActivities>,
): InlineParkingCallbacks {
  return {
    createLifecycleCallbacks: () => createLifecycleCallbacks(engine),
    createTerminationCallbacks: () => createTerminationCallbacks(engine),
    evaluateConstraints: (workflowId) =>
      evaluateConstraints(getInternals(engine), workflowId, createConstraintCallbacks(engine)),
    getParkedWorkflowResumeDisposition: (workflowId) =>
      getParkedWorkflowResumeDisposition(
        getInternals(engine),
        workflowId,
        createInlineParkingCallbacks(engine),
      ),
    hasBufferedSignal: (workflowId, signalName) =>
      hasBufferedSignal(getInternals(engine), workflowId, signalName),
    loadWorkflowState: (workflowId) => loadWorkflowState(getInternals(engine), workflowId),
    parkInlineWorkflowAfterCheckpoint: (workflowId, operation) =>
      parkInlineWorkflowAfterCheckpoint(
        getInternals(engine),
        workflowId,
        operation,
        createInlineParkingCallbacks(engine),
      ),
    persistCheckpoint: (workflowId, operation, workerCheckpointBytes) =>
      persistCheckpointForEngine(engine, workflowId, operation, workerCheckpointBytes),
    processOperation: (workflowId, operation) =>
      processOperation(
        getInternals(engine),
        workflowId,
        operation,
        createOperationRouterCallbacks(engine),
      ),
    readCheckpointBytes: (workflowId) =>
      getInternals(engine).storage.get(KEYS.checkpoint(workflowId)),
    resumeParkedInlineWorkflow: (workflowId) =>
      resumeParkedInlineWorkflow(
        getInternals(engine),
        workflowId,
        createInlineParkingCallbacks(engine),
      ),
    runSerializedWorkflowStateWrite: (workflowId, writeOperation) =>
      runSerializedWorkflowStateWrite(getInternals(engine), workflowId, writeOperation),
    translateOperationRequest: (operationRequest) =>
      translateOperationRequest(getInternals(engine), operationRequest),
    validateDevelopmentCheckpoint: (workflowId) =>
      validateDevelopmentCheckpoint(getInternals(engine), workflowId, {
        dispatchEvent: (event) => {
          engine.dispatchEvent(event);
        },
      }),
  };
}

export function createUpdateCallbacks<TWorkflows extends object, TActivities extends object>(
  engine: Engine<TWorkflows, TActivities>,
): UpdateCallbacks {
  return {
    dispatchEvent: (event) => engine.dispatchEvent(event),
    broadcast: (message) =>
      broadcastFromInternals(getInternals(engine), message, createBroadcastCallbacks(engine)),
    completeOperation: (id, value) => completeOperationForEngine(engine, id, value),
    guardTerminalWorkflow: (id) =>
      guardTerminalWorkflow(getInternals(engine), id, createGuardCallbacks(engine)),
    guardTerminalWorkflowAfterCoordinatedRequest: (id, updateId) =>
      guardTerminalWorkflowAfterCoordinatedRequest(
        getInternals(engine),
        id,
        updateId,
        createGuardCallbacks(engine),
      ),
    persistCoordinatedUpdateResponse: (id, updateName, updateId, idempotencyKey, value) =>
      persistCoordinatedUpdateResponse(engine, id, updateName, updateId, idempotencyKey, value),
    deliverCoordinatedUpdateToWaiterIfAvailable: (id, updateRequest, dispatchReceivedEvent) =>
      deliverCoordinatedUpdateToWaiterIfAvailable(
        getInternals(engine),
        id,
        updateRequest,
        dispatchReceivedEvent,
        createUpdateCallbacks(engine),
      ),
    dispatchPendingUpdateReceived: (id, updateName, updateRequest) =>
      dispatchPendingUpdateReceivedFromBroadcast(
        getInternals(engine),
        id,
        updateName,
        updateRequest,
        createBroadcastCallbacks(engine),
      ),
    createCoordinatedUpdateResponder: (id, updateName, updateRequest) =>
      createCoordinatedUpdateResponder(getInternals(engine), id, updateName, updateRequest, {
        persistCoordinatedUpdateResponse: (workflowId, name, updateId, idempotencyKey, value) =>
          persistCoordinatedUpdateResponse(
            engine,
            workflowId,
            name,
            updateId,
            idempotencyKey,
            value,
          ),
      }),
    findPendingUpdateByName: (id, name) => findPendingUpdateByName(getInternals(engine), id, name),
    schedulePendingInlineUpdateDrain: (workflowId) =>
      schedulePendingInlineUpdateDrain(
        getInternals(engine),
        workflowId,
        createPendingUpdateCallbacks(engine),
      ),
  };
}

export function createSubmitReviewCallbacks<TWorkflows extends object, TActivities extends object>(
  engine: Engine<TWorkflows, TActivities>,
): SubmitReviewCallbacks {
  return { dispatchEvent: engine.dispatchEvent.bind(engine) };
}

export function createScheduleCallbacks<TWorkflows extends object, TActivities extends object>(
  engine: Engine<TWorkflows, TActivities>,
): ScheduleCallbacks {
  return {
    startWorkflow: async (type, input, options, tenantResolution, additionalStartOperations) => {
      await startWorkflow(
        getInternals(engine),
        type,
        input,
        options,
        tenantResolution,
        additionalStartOperations,
        createLifecycleCallbacks(engine),
      );
    },
    loadWorkflowState: (workflowId) => loadWorkflowState(getInternals(engine), workflowId),
    cancelWorkflow: (workflowId) => engine.cancel(workflowId),
    getWorkflowResult: (workflowId) => engine.getHandle(workflowId).result(),
    refreshScheduledWorkflowState: (state) => refreshScheduledWorkflowStateForEngine(engine, state),
    startScheduledRun: (state) => startScheduledRunForEngine(engine, state),
    applyScheduleOccurrence: (state) => applyScheduleOccurrenceForEngine(engine, state),
    settleBackfillScheduleState: (state) => settleBackfillScheduleStateForEngine(engine, state),
    flushQueuedInlineWorkflowStartsDirectly: () =>
      flushQueuedInlineWorkflowStartsDirectly(
        getInternals(engine),
        createInlineLaunchQueueCallbacks(engine),
      ),
  };
}

export function createReviewOperationCallbacks<
  TWorkflows extends object,
  TActivities extends object,
>(engine: Engine<TWorkflows, TActivities>): ReviewOperationCallbacks {
  return {
    dispatchEvent: engine.dispatchEvent.bind(engine),
    failWorkflow: (workflowId, error) =>
      failWorkflow(getInternals(engine), workflowId, error, createTerminationCallbacks(engine)),
    feedOperationResult: (workflowId, result) =>
      feedOperationResult(getInternals(engine), workflowId, result),
    ensureTerminalCleanupTracked: (workflowId) =>
      ensureTerminalCleanupTracked(getInternals(engine), workflowId),
  };
}

export function createOperationRouterCallbacks<
  TWorkflows extends object,
  TActivities extends object,
>(engine: Engine<TWorkflows, TActivities>): OperationRouterCallbacks {
  return {
    processActivityOperation: (workflowId, operation) =>
      processActivityOperation(
        getInternals(engine),
        workflowId,
        operation,
        createActivityOperationCallbacks(engine),
      ),
    processSleepOperation: (workflowId, operation) =>
      processSleepOperation(
        getInternals(engine),
        workflowId,
        operation,
        createTimeOperationCallbacks(engine),
      ),
    processWaitSignalOperation: (workflowId, operation) =>
      processWaitSignalOperation(
        getInternals(engine),
        workflowId,
        operation,
        createCoordinationOperationCallbacks(engine),
      ),
    processWaitUpdateOperation: (workflowId, operation) =>
      processWaitUpdateOperation(
        getInternals(engine),
        workflowId,
        operation,
        createUpdateCallbacks(engine),
      ),
    processParallelOperation: (workflowId, operation) =>
      processParallelOperation(
        getInternals(engine),
        workflowId,
        operation,
        createCoordinationOperationCallbacks(engine),
      ),
    processRaceOperation: (workflowId, operation) =>
      processRaceOperation(
        getInternals(engine),
        workflowId,
        operation,
        createCoordinationOperationCallbacks(engine),
      ),
    processMemoOperation: (workflowId, operation) =>
      processMemoOperation(
        getInternals(engine),
        workflowId,
        operation,
        createDataOperationCallbacks(engine),
      ),
    processChildWorkflowOperation: (workflowId, operation) =>
      processChildWorkflowOperation(
        getInternals(engine),
        workflowId,
        operation,
        createChildWorkflowOperationCallbacks(engine),
      ),
    processOffloadOperation: (workflowId, operation) =>
      processOffloadOperation(
        getInternals(engine),
        workflowId,
        operation,
        createDataOperationCallbacks(engine),
      ),
    processLoadOperation: (workflowId, operation) =>
      processLoadOperation(
        getInternals(engine),
        workflowId,
        operation,
        createDataOperationCallbacks(engine),
      ),
    processArchiveOperation: (workflowId, operation) =>
      processArchiveOperation(
        getInternals(engine),
        workflowId,
        operation,
        createDataOperationCallbacks(engine),
      ),
    processStateReadOperation: (workflowId, operation) =>
      processStateReadOperation(
        getInternals(engine),
        workflowId,
        operation,
        createStateOperationCallbacks(engine),
      ),
    processStateCommitOperation: (workflowId, operation) =>
      processStateCommitOperation(
        getInternals(engine),
        workflowId,
        operation,
        createStateOperationCallbacks(engine),
      ),
    processRunAllOperation: (workflowId, operation) =>
      processRunAllOperation(
        getInternals(engine),
        workflowId,
        operation,
        createCoordinationOperationCallbacks(engine),
      ),
    processSpeculateOperation: (workflowId, operation) =>
      processSpeculateOperation(getInternals(engine), workflowId, operation, {
        runOperationWithResult: (id, subOperation, execute) =>
          runOperationWithResultForEngine(engine, id, subOperation, execute),
        executeSubOperation: (id, subOperation, signal, speculativeState) =>
          executeSubOperationForEngine(engine, id, subOperation, signal, speculativeState),
      }),
    processStreamOperation: (workflowId, operation) =>
      processStreamOperation(
        getInternals(engine),
        workflowId,
        operation,
        createStreamOperationCallbacks(engine),
      ),
    processWaitReviewOperation: (workflowId, operation) =>
      processWaitReviewOperation(getInternals(engine), workflowId, operation, {
        runOperationWithoutResult: (id, subOperation, execute) =>
          runOperationWithoutResultForEngine(engine, id, subOperation, execute),
        processReviewOperation: (id, options) =>
          processReviewOperationForEngine(engine, id, options),
      }),
    finalizePendingTimelineEntry: (workflowId, status, value) =>
      finalizePendingTimelineEntry(getInternals(engine), workflowId, status, value),
    feedOperationResult: (workflowId, result, error) =>
      feedOperationResult(getInternals(engine), workflowId, result, error),
  };
}

export function createChildWorkflowOperationCallbacks<
  TWorkflows extends object,
  TActivities extends object,
>(engine: Engine<TWorkflows, TActivities>): ChildWorkflowOperationCallbacks {
  return {
    runOperationWithResult: (workflowId, operation, execute) =>
      runOperationWithResultForEngine(engine, workflowId, operation, execute),
    start: (type, input, options) =>
      startWorkflow(
        getInternals(engine),
        type,
        input,
        options,
        undefined,
        undefined,
        createLifecycleCallbacks(engine),
      ),
    loadWorkflowState: (workflowId) => loadWorkflowState(getInternals(engine), workflowId),
    getHandle: (workflowId) => engine.getHandle(workflowId),
    getComposedWorkflowInterceptor: () => getComposedWorkflowInterceptor(getInternals(engine)),
  };
}

export function createActivityOperationCallbacks<
  TWorkflows extends object,
  TActivities extends object,
>(engine: Engine<TWorkflows, TActivities>): ActivityOperationCallbacks {
  return {
    runOperationWithResult: (workflowId, operation, execute) =>
      runOperationWithResultForEngine(engine, workflowId, operation, execute),
    getComposedActivityInterceptor: () => getComposedActivityInterceptor(getInternals(engine)),
    getComposedWorkflowInterceptor: () => getComposedWorkflowInterceptor(getInternals(engine)),
  };
}
export function createCoordinationOperationCallbacks<
  TWorkflows extends object,
  TActivities extends object,
>(engine: Engine<TWorkflows, TActivities>): CoordinationOperationCallbacks {
  return {
    completeOperation: (workflowId, value) => completeOperationForEngine(engine, workflowId, value),
    runOperationWithResult: (workflowId, operation, execute) =>
      runOperationWithResultForEngine(engine, workflowId, operation, execute),
    executeSubOperation: (workflowId, operation, signal, speculativeState) =>
      executeSubOperationForEngine(engine, workflowId, operation, signal, speculativeState),
    getActivityOperationCallbacks: () => createActivityOperationCallbacks(engine),
  };
}
export function createDataOperationCallbacks<TWorkflows extends object, TActivities extends object>(
  engine: Engine<TWorkflows, TActivities>,
): DataOperationCallbacks {
  return {
    runOperationWithResult: (workflowId, operation, execute) =>
      runOperationWithResultForEngine(engine, workflowId, operation, execute),
  };
}
export function createStateOperationCallbacks<
  TWorkflows extends object,
  TActivities extends object,
>(engine: Engine<TWorkflows, TActivities>): StateOperationCallbacks {
  return {
    runOperationWithResult: (workflowId, operation, execute) =>
      runOperationWithResultForEngine(engine, workflowId, operation, execute),
    ensureTerminalCleanupTracked: (workflowId) =>
      ensureTerminalCleanupTracked(getInternals(engine), workflowId),
  };
}
export function createStreamOperationCallbacks<
  TWorkflows extends object,
  TActivities extends object,
>(engine: Engine<TWorkflows, TActivities>): StreamOperationCallbacks {
  return {
    runOperationWithResult: (workflowId, operation, execute) =>
      runOperationWithResultForEngine(engine, workflowId, operation, execute),
    handleCleanupError: (source, error, workflowId) =>
      createTerminationCallbacks(engine).handleCleanupError(source, error, workflowId),
  };
}

export function createTimeOperationCallbacks<TWorkflows extends object, TActivities extends object>(
  engine: Engine<TWorkflows, TActivities>,
): TimeOperationCallbacks {
  return {
    completeOperation: (workflowId, value) => completeOperationForEngine(engine, workflowId, value),
    loadWorkflowState: (workflowId) => loadWorkflowState(getInternals(engine), workflowId),
    failWorkflow: (workflowId, error) =>
      failWorkflow(getInternals(engine), workflowId, error, createTerminationCallbacks(engine)),
    runSerializedWorkflowStateWrite: (workflowId, writeOperation) =>
      runSerializedWorkflowStateWrite(getInternals(engine), workflowId, writeOperation),
    beginWorkflowExecution: (
      workflowId,
      workflowType,
      input,
      checkpoint,
      executionDeadline,
      tenant,
      executionStateOwnerId,
      registration,
    ) =>
      beginWorkflowExecution(
        getInternals(engine),
        workflowId,
        workflowType,
        input,
        checkpoint,
        executionDeadline,
        tenant,
        executionStateOwnerId,
        registration,
        createLifecycleCallbacks(engine),
      ),
    workflowVersionTupleFromState: (state) =>
      workflowVersionTupleFromState(getInternals(engine), state, createLifecycleCallbacks(engine)),
    setWorkflowStartHeaders: (workflowId, headers) =>
      setWorkflowStartHeaders(
        getInternals(engine),
        workflowId,
        headers,
        createLifecycleCallbacks(engine),
      ),
    loadWorkflowStartHeaders: (workflowId) =>
      loadWorkflowStartHeaders(getInternals(engine), workflowId, createLifecycleCallbacks(engine)),
    parseStartOptionDuration: (value, fieldName) =>
      parseStartOptionDuration(
        getInternals(engine),
        value,
        fieldName,
        createLifecycleCallbacks(engine),
      ),
    runDeferredTerminalCleanup: (workflowId, timerId) =>
      runDeferredTerminalCleanup(
        getInternals(engine),
        workflowId,
        timerId,
        createTerminationCallbacks(engine),
      ),
    handleScheduleTimer: (entry) => handleScheduleTimerForEngine(engine, entry),
    timeout: (workflowId) => engine.timeout(workflowId),
  };
}

export function completeOperationForEngine<TWorkflows extends object, TActivities extends object>(
  engine: Engine<TWorkflows, TActivities>,
  workflowId: string,
  value: unknown,
): void {
  return completeOperation(
    getInternals(engine),
    workflowId,
    value,
    createOperationRouterCallbacks(engine),
  );
}
export async function runOperationWithResultForEngine<
  TWorkflows extends object,
  TActivities extends object,
>(
  engine: Engine<TWorkflows, TActivities>,
  workflowId: string,
  operation: OperationWithCallerStack,
  execute: () => Promise<unknown>,
): Promise<void> {
  return runOperationWithResult(
    getInternals(engine),
    workflowId,
    operation,
    execute,
    createOperationRouterCallbacks(engine),
  );
}
export async function runOperationWithoutResultForEngine<
  TWorkflows extends object,
  TActivities extends object,
>(
  engine: Engine<TWorkflows, TActivities>,
  workflowId: string,
  operation: OperationWithCallerStack,
  execute: () => Promise<void>,
): Promise<void> {
  return runOperationWithoutResult(
    getInternals(engine),
    workflowId,
    operation,
    execute,
    createOperationRouterCallbacks(engine),
  );
}
export async function executeSubOperationForEngine<
  TWorkflows extends object,
  TActivities extends object,
>(
  engine: Engine<TWorkflows, TActivities>,
  workflowId: string,
  operation: ContextOperationRequest,
  signal?: AbortSignal,
  speculativeState?: SpeculativeExecutionState,
): Promise<unknown> {
  return executeSubOperation(
    getInternals(engine),
    workflowId,
    operation,
    {
      createActivityOperationCallbacks: () => createActivityOperationCallbacks(engine),
      createChildWorkflowOperationCallbacks: () => createChildWorkflowOperationCallbacks(engine),
      createCoordinationOperationCallbacks: () => createCoordinationOperationCallbacks(engine),
      createStateOperationCallbacks: () => createStateOperationCallbacks(engine),
    },
    signal,
    speculativeState,
  );
}
export async function processReviewOperationForEngine<
  TWorkflows extends object,
  TActivities extends object,
>(
  engine: Engine<TWorkflows, TActivities>,
  workflowId: string,
  options: HumanReviewOptions,
): Promise<void> {
  return processReviewOperation(
    getInternals(engine),
    workflowId,
    options,
    createReviewOperationCallbacks(engine),
  );
}
export async function refreshScheduledWorkflowStateForEngine<
  TWorkflows extends object,
  TActivities extends object,
>(engine: Engine<TWorkflows, TActivities>, state: ScheduleState): Promise<RefreshedScheduleState> {
  return refreshScheduledWorkflowState(
    getInternals(engine),
    state,
    createScheduleCallbacks(engine),
  );
}
export async function startScheduledRunForEngine<
  TWorkflows extends object,
  TActivities extends object,
>(engine: Engine<TWorkflows, TActivities>, state: ScheduleState): Promise<string> {
  return startScheduledRun(getInternals(engine), state, createScheduleCallbacks(engine));
}
export async function applyScheduleOccurrenceForEngine<
  TWorkflows extends object,
  TActivities extends object,
>(engine: Engine<TWorkflows, TActivities>, state: ScheduleState): Promise<ScheduleState> {
  return applyScheduleOccurrence(getInternals(engine), state, createScheduleCallbacks(engine));
}
export async function settleBackfillScheduleStateForEngine<
  TWorkflows extends object,
  TActivities extends object,
>(engine: Engine<TWorkflows, TActivities>, state: ScheduleState): Promise<ScheduleState> {
  return settleBackfillScheduleState(getInternals(engine), state, createScheduleCallbacks(engine));
}
export async function handleScheduleTimerForEngine<
  TWorkflows extends object,
  TActivities extends object,
>(engine: Engine<TWorkflows, TActivities>, entry: TimerEntry): Promise<void> {
  return handleScheduleTimer(getInternals(engine), entry, createScheduleCallbacks(engine));
}
export async function handleScheduledWorkflowTerminalForEngine<
  TWorkflows extends object,
  TActivities extends object,
>(engine: Engine<TWorkflows, TActivities>, workflowId: string): Promise<void> {
  return handleScheduledWorkflowTerminal(
    getInternals(engine),
    workflowId,
    createScheduleCallbacks(engine),
  );
}

export function persistCheckpointForEngine<TWorkflows extends object, TActivities extends object>(
  engine: Engine<TWorkflows, TActivities>,
  workflowId: string,
  operation: ContextOperationRequest,
  workerCheckpointBytes?: ArrayBuffer,
): Promise<void> {
  return persistCheckpoint(getInternals(engine), workflowId, operation, workerCheckpointBytes, {
    appendTimelineBatchOperations: (id, checkpointOperation, step, timestamp, operations) =>
      appendTimelineBatchOperations(
        getInternals(engine),
        id,
        checkpointOperation,
        step,
        timestamp,
        operations,
      ),
    swallowPromiseRejection: (promise) => {
      void swallowPromiseRejection(promise);
    },
    validateAttributeValueSizes,
    pruneCheckpointHistory: (id, step) => pruneCheckpointHistory(getInternals(engine), id, step),
    dispatchEvent: (event) => {
      engine.dispatchEvent(event);
    },
  });
}

async function persistCoordinatedUpdateResponse<
  TWorkflows extends object,
  TActivities extends object,
>(
  engine: Engine<TWorkflows, TActivities>,
  workflowId: string,
  updateName: string,
  updateId: string,
  idempotencyKey: string | undefined,
  value: unknown,
): Promise<void> {
  const internals = getInternals(engine);
  const responseOperations = internals.updateCoordinator.buildResponseOperations(
    updateId,
    workflowId,
    value,
    undefined,
    idempotencyKey,
  );
  try {
    await internals.storage.batch(responseOperations);
    engine.dispatchEvent(new UpdateCompletedEvent(updateId, workflowId, updateName, value));
    broadcastFromInternals(
      internals,
      { type: 'update:completed', workflowId, updateId },
      createBroadcastCallbacks(engine),
    );
  } catch (error: unknown) {
    createTerminationCallbacks(engine).handleCleanupError(
      'writeCoordinatedUpdateResponse',
      error,
      workflowId,
    );
  }
}

function ensureRetentionSweepIntervalForEngine<
  TWorkflows extends object,
  TActivities extends object,
>(engine: Engine<TWorkflows, TActivities>): void {
  ensureRetentionSweepInterval(getInternals(engine), {
    hasConfiguredRetention: () => hasConfiguredRetention(getInternals(engine)),
    runRetentionSweep: () =>
      runRetentionSweep(
        getInternals(engine),
        (source, error) => createTerminationCallbacks(engine).handleCleanupError(source, error),
        (workflowId) =>
          cleanupWaiters(getInternals(engine), workflowId, createTerminationCallbacks(engine)),
      ),
    setNextRetentionSweepAt: () => setNextRetentionSweepAt(getInternals(engine)),
  });
}
