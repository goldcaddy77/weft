/* oxlint-disable max-lines -- ID:core-engine-callback-creators-file-length */
import { isAgentDefinition } from '../../ai/declaration.ts';
import type { HumanReviewOptions } from '../../ai/human-review.ts';
import { KEYS } from '../../storage/interface.ts';
import type { ContextOperationRequest } from '../context.ts';
import { UpdateCompletedEvent } from '../events.ts';
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
  processDebateOperation,
  processHandoffOperation,
  processSuperviseOperation,
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
  parkInlineWorkflowForAgentSuspension,
  waitForSignalPayload as waitForSignalPayloadFromAgentOperations,
} from './operations-agent-suspension.ts';
import {
  processAgentContextOperation,
  processSpeculateOperation,
  type AgentOperationCallbacks,
} from './operations-agent.ts';
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
  failOperation,
  processOperation,
  runOperationWithResult,
  runOperationWithoutResult,
  translateOperationRequest,
  type OperationRouterCallbacks,
  type OperationWithCallerStack,
} from './operations-router.ts';
import { processStreamOperation, type StreamOperationCallbacks } from './operations-stream.ts';
import { processSleepOperation, type TimeOperationCallbacks } from './operations-time.ts';
import { processPendingUpdatesForHandlers } from './pending-updates.ts';
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
import { consumeSignal, hasBufferedSignal } from './signals.ts';
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

export function createLifecycleCallbacks(engine: Engine): LifecycleCallbacks {
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
          processPendingUpdatesForHandlers(getInternals(engine), id, {
            dispatchEvent: (event) => engine.dispatchEvent(event),
            broadcast: (message) =>
              broadcastFromInternals(
                getInternals(engine),
                message,
                createBroadcastCallbacks(engine),
              ),
          }),
        handleCleanupError: (source, error, id) =>
          createTerminationCallbacks(engine).handleCleanupError(source, error, id),
      });
    },
    processPendingUpdatesForHandlers: (workflowId) =>
      processPendingUpdatesForHandlers(getInternals(engine), workflowId, {
        dispatchEvent: (event) => engine.dispatchEvent(event),
        broadcast: (message) =>
          broadcastFromInternals(getInternals(engine), message, createBroadcastCallbacks(engine)),
      }),
    handleCleanupError: (source, error, workflowId) =>
      createTerminationCallbacks(engine).handleCleanupError(source, error, workflowId),
    swallowPromiseRejection: (promise) => swallowPromiseRejection(promise),
  };
}

export function createTerminationCallbacks(engine: Engine): TerminationCallbacks {
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

export function createRegistrationCallbacks(engine: Engine): RegistrationCallbacks {
  return {
    ensureRetentionSweepInterval: () => ensureRetentionSweepIntervalForEngine(engine),
    isAgentDefinition,
  };
}
export function createBroadcastCallbacks(engine: Engine): BroadcastCallbacks {
  return { dispatchEvent: (event) => engine.dispatchEvent(event) };
}
export function createGuardCallbacks(engine: Engine): GuardCallbacks {
  return {
    deleteRequestIfUnconsumed: (workflowId, updateId) =>
      getInternals(engine).updateCoordinator.deleteRequestIfUnconsumed(workflowId, updateId),
    getUpdateResponse: (updateId) => getInternals(engine).updateCoordinator.getResponse(updateId),
  };
}
export function createConstraintCallbacks(engine: Engine): ConstraintCallbacks {
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

export function createInlineParkingCallbacks(engine: Engine): InlineParkingCallbacks {
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

export function createUpdateCallbacks(engine: Engine): UpdateCallbacks {
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
  };
}

export function createSubmitReviewCallbacks(engine: Engine): SubmitReviewCallbacks {
  return { dispatchEvent: engine.dispatchEvent.bind(engine) };
}

export function createScheduleCallbacks(engine: Engine): ScheduleCallbacks {
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
  };
}

export function createReviewOperationCallbacks(engine: Engine): ReviewOperationCallbacks {
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

export function createOperationRouterCallbacks(engine: Engine): OperationRouterCallbacks {
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
    processRunAllOperation: (workflowId, operation) =>
      processRunAllOperation(
        getInternals(engine),
        workflowId,
        operation,
        createCoordinationOperationCallbacks(engine),
      ),
    processAgentContextOperation: (workflowId, operation) =>
      processAgentContextOperation(
        getInternals(engine),
        workflowId,
        operation,
        createAgentOperationCallbacks(engine),
      ),
    processSpeculateOperation: (workflowId, operation) =>
      processSpeculateOperation(
        getInternals(engine),
        workflowId,
        operation,
        createAgentOperationCallbacks(engine),
      ),
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
    processHandoffOperation: (workflowId, operation) =>
      processHandoffOperation(
        getInternals(engine),
        workflowId,
        operation,
        createChildWorkflowOperationCallbacks(engine),
      ),
    processDebateOperation: (workflowId, operation) =>
      processDebateOperation(
        getInternals(engine),
        workflowId,
        operation,
        createChildWorkflowOperationCallbacks(engine),
      ),
    processSuperviseOperation: (workflowId, operation) =>
      processSuperviseOperation(
        getInternals(engine),
        workflowId,
        operation,
        createChildWorkflowOperationCallbacks(engine),
      ),
    finalizePendingTimelineEntry: (workflowId, status, value) =>
      finalizePendingTimelineEntry(getInternals(engine), workflowId, status, value),
    feedOperationResult: (workflowId, result, error) =>
      feedOperationResult(getInternals(engine), workflowId, result, error),
  };
}

export function createChildWorkflowOperationCallbacks(
  engine: Engine,
): ChildWorkflowOperationCallbacks {
  return {
    runOperationWithResult: (workflowId, operation, execute) =>
      runOperationWithResultForEngine(engine, workflowId, operation, execute),
    start: (type, input, options) => engine.start(type, input, options),
    loadWorkflowState: (workflowId) => loadWorkflowState(getInternals(engine), workflowId),
    getHandle: (workflowId) => engine.getHandle(workflowId),
    getComposedWorkflowInterceptor: () => getComposedWorkflowInterceptor(getInternals(engine)),
  };
}

export function createAgentOperationCallbacks(engine: Engine): AgentOperationCallbacks {
  return {
    runOperationWithResult: (workflowId, operation, execute) =>
      runOperationWithResultForEngine(engine, workflowId, operation, execute),
    completeOperation: (workflowId, value) => completeOperationForEngine(engine, workflowId, value),
    failOperation: (workflowId, operation, error) =>
      failOperation(
        getInternals(engine),
        workflowId,
        operation,
        error,
        createOperationRouterCallbacks(engine),
      ),
    executeSubOperation: (workflowId, operation, signal, speculativeState) =>
      executeSubOperationForEngine(engine, workflowId, operation, signal, speculativeState),
    ensureTerminalCleanupTracked: (workflowId) =>
      ensureTerminalCleanupTracked(getInternals(engine), workflowId),
    hasBufferedSignal: (workflowId, signalName) =>
      hasBufferedSignal(getInternals(engine), workflowId, signalName),
    consumeSignal: (workflowId, signalName) =>
      consumeSignal(getInternals(engine), workflowId, signalName),
    waitForSignalPayload: (workflowId, signalName) =>
      waitForSignalPayloadFromAgentOperations(getInternals(engine), workflowId, signalName, {
        consumeSignal: (id, name) => consumeSignal(getInternals(engine), id, name),
      }),
    parkInlineWorkflowForAgentSuspension: (workflowId, stepIndex, resumeToken) =>
      parkInlineWorkflowForAgentSuspension(
        getInternals(engine),
        workflowId,
        stepIndex,
        resumeToken,
        {
          hasBufferedSignal: (id, signalName) =>
            hasBufferedSignal(getInternals(engine), id, signalName),
          loadWorkflowState: (id) => loadWorkflowState(getInternals(engine), id),
          resumeParkedInlineWorkflow: (id) =>
            resumeParkedInlineWorkflow(
              getInternals(engine),
              id,
              createInlineParkingCallbacks(engine),
            ),
          runSerializedWorkflowStateWrite: (id, writeOperation) =>
            runSerializedWorkflowStateWrite(getInternals(engine), id, writeOperation),
        },
      ),
    runSerializedWorkflowStateWrite: (workflowId, writeOperation) =>
      runSerializedWorkflowStateWrite(getInternals(engine), workflowId, writeOperation),
    loadWorkflowState: (workflowId) => loadWorkflowState(getInternals(engine), workflowId),
    resumeParkedInlineWorkflow: (workflowId) =>
      resumeParkedInlineWorkflow(
        getInternals(engine),
        workflowId,
        createInlineParkingCallbacks(engine),
      ),
    dispatchEvent: (event) => engine.dispatchEvent(event),
    broadcastSignalReceived: (message) =>
      broadcastFromInternals(getInternals(engine), message, createBroadcastCallbacks(engine)),
    forwardEventToHandle: (workflowId, event) =>
      forwardEventToHandleFromBroadcast(
        getInternals(engine),
        workflowId,
        event,
        createBroadcastCallbacks(engine),
      ),
    getComposedWorkflowInterceptor: () => getComposedWorkflowInterceptor(getInternals(engine)),
    getEventTarget: () => engine,
  };
}

export function createActivityOperationCallbacks(engine: Engine): ActivityOperationCallbacks {
  return {
    runOperationWithResult: (workflowId, operation, execute) =>
      runOperationWithResultForEngine(engine, workflowId, operation, execute),
    getComposedActivityInterceptor: () => getComposedActivityInterceptor(getInternals(engine)),
    getComposedWorkflowInterceptor: () => getComposedWorkflowInterceptor(getInternals(engine)),
  };
}
export function createCoordinationOperationCallbacks(
  engine: Engine,
): CoordinationOperationCallbacks {
  return {
    completeOperation: (workflowId, value) => completeOperationForEngine(engine, workflowId, value),
    runOperationWithResult: (workflowId, operation, execute) =>
      runOperationWithResultForEngine(engine, workflowId, operation, execute),
    executeSubOperation: (workflowId, operation, signal, speculativeState) =>
      executeSubOperationForEngine(engine, workflowId, operation, signal, speculativeState),
    getActivityOperationCallbacks: () => createActivityOperationCallbacks(engine),
  };
}
export function createDataOperationCallbacks(engine: Engine): DataOperationCallbacks {
  return {
    runOperationWithResult: (workflowId, operation, execute) =>
      runOperationWithResultForEngine(engine, workflowId, operation, execute),
  };
}
export function createStreamOperationCallbacks(engine: Engine): StreamOperationCallbacks {
  return {
    runOperationWithResult: (workflowId, operation, execute) =>
      runOperationWithResultForEngine(engine, workflowId, operation, execute),
    handleCleanupError: (source, error, workflowId) =>
      createTerminationCallbacks(engine).handleCleanupError(source, error, workflowId),
  };
}

export function createTimeOperationCallbacks(engine: Engine): TimeOperationCallbacks {
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

export function completeOperationForEngine(
  engine: Engine,
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
export async function runOperationWithResultForEngine(
  engine: Engine,
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
export async function runOperationWithoutResultForEngine(
  engine: Engine,
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
export async function executeSubOperationForEngine(
  engine: Engine,
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
      createAgentOperationCallbacks: () => createAgentOperationCallbacks(engine),
    },
    signal,
    speculativeState,
  );
}
export async function processReviewOperationForEngine(
  engine: Engine,
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
export async function refreshScheduledWorkflowStateForEngine(
  engine: Engine,
  state: ScheduleState,
): Promise<RefreshedScheduleState> {
  return refreshScheduledWorkflowState(
    getInternals(engine),
    state,
    createScheduleCallbacks(engine),
  );
}
export async function startScheduledRunForEngine(
  engine: Engine,
  state: ScheduleState,
): Promise<string> {
  return startScheduledRun(getInternals(engine), state, createScheduleCallbacks(engine));
}
export async function applyScheduleOccurrenceForEngine(
  engine: Engine,
  state: ScheduleState,
): Promise<ScheduleState> {
  return applyScheduleOccurrence(getInternals(engine), state, createScheduleCallbacks(engine));
}
export async function settleBackfillScheduleStateForEngine(
  engine: Engine,
  state: ScheduleState,
): Promise<ScheduleState> {
  return settleBackfillScheduleState(getInternals(engine), state, createScheduleCallbacks(engine));
}
export async function handleScheduleTimerForEngine(
  engine: Engine,
  entry: TimerEntry,
): Promise<void> {
  return handleScheduleTimer(getInternals(engine), entry, createScheduleCallbacks(engine));
}
export async function handleScheduledWorkflowTerminalForEngine(
  engine: Engine,
  workflowId: string,
): Promise<void> {
  return handleScheduledWorkflowTerminal(
    getInternals(engine),
    workflowId,
    createScheduleCallbacks(engine),
  );
}

export function persistCheckpointForEngine(
  engine: Engine,
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

async function persistCoordinatedUpdateResponse(
  engine: Engine,
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

function ensureRetentionSweepIntervalForEngine(engine: Engine): void {
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
