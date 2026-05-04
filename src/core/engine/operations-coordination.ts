import type { ContextOperationRequest } from '../context.ts';
import { executeRunAllBranches } from '../engine-helpers.ts';
import type { EngineInternals } from './internals.ts';
import {
  executeActivityOperationResult as executeActivityOperationResultFromInternals,
  type ActivityFunctionWithMetadata,
  type ActivityOperationCallbacks,
} from './operations-activity.ts';
import type { OperationWithCallerStack } from './operations-router.ts';
import { consumeSignal, trackWaiterKey, untrackWaiterKey } from './signals.ts';
import type { SpeculativeExecutionState } from './speculative-execution-state.ts';
import { callActivityFunction } from './state-utilities.ts';

type WaitSignalOperation = Extract<ContextOperationRequest, { type: 'wait-signal' }>;
type ParallelOperation = Extract<ContextOperationRequest, { type: 'parallel' }>;
type RaceOperation = Extract<ContextOperationRequest, { type: 'race' }>;
type RunAllOperation = Extract<ContextOperationRequest, { type: 'run-all' }>;

export type CoordinationOperationCallbacks = {
  completeOperation: (workflowId: string, value: unknown) => void;
  runOperationWithResult: (
    workflowId: string,
    operation: OperationWithCallerStack,
    execute: () => Promise<unknown>,
  ) => Promise<void>;
  executeSubOperation: (
    workflowId: string,
    operation: ContextOperationRequest,
    signal?: AbortSignal,
    speculativeState?: SpeculativeExecutionState,
  ) => Promise<unknown>;
  getActivityOperationCallbacks: () => ActivityOperationCallbacks;
};

export async function processWaitSignalOperation(
  internals: EngineInternals,
  workflowId: string,
  operation: WaitSignalOperation,
  callbacks: Pick<CoordinationOperationCallbacks, 'completeOperation'>,
): Promise<void> {
  const abortSignal = internals.abortController.signal;
  const waiterKey = `${workflowId}:${operation.signalName}`;

  while (true) {
    if (abortSignal.aborted) {
      return;
    }

    const existingPayload = await consumeSignal(internals, workflowId, operation.signalName);
    if (existingPayload.found) {
      callbacks.completeOperation(workflowId, existingPayload.payload);
      return;
    }

    const { promise, resolve } = Promise.withResolvers<void>();
    internals.signalWaiters.set(waiterKey, resolve);
    trackWaiterKey(internals.signalWaitersByWorkflow, workflowId, waiterKey);

    if (abortSignal.aborted) {
      internals.signalWaiters.delete(waiterKey);
      untrackWaiterKey(internals.signalWaitersByWorkflow, workflowId, waiterKey);
      return;
    }

    const bufferedPayload = await consumeSignal(internals, workflowId, operation.signalName);
    if (bufferedPayload.found) {
      if (internals.signalWaiters.get(waiterKey) === resolve) {
        internals.signalWaiters.delete(waiterKey);
        untrackWaiterKey(internals.signalWaitersByWorkflow, workflowId, waiterKey);
      }
      callbacks.completeOperation(workflowId, bufferedPayload.payload);
      return;
    }

    await promise;

    if (abortSignal.aborted) {
      return;
    }
  }
}

export async function processParallelOperation(
  _internals: EngineInternals,
  workflowId: string,
  operation: ParallelOperation,
  callbacks: Pick<CoordinationOperationCallbacks, 'executeSubOperation' | 'runOperationWithResult'>,
): Promise<void> {
  // `ctx.all()` awaits every branch, so there's no "loser" to abort like
  // there is for `ctx.race()`. Each sub-operation runs to completion or
  // throws; `Promise.all` short-circuits on the first rejection, but the
  // surviving branches' budgets are intentionally preserved — callers that
  // want cancellation on failure should use `ctx.race()` with a guard.
  return callbacks.runOperationWithResult(workflowId, operation, async () =>
    Promise.all(
      operation.operations.map((subOperation) =>
        callbacks.executeSubOperation(workflowId, subOperation),
      ),
    ),
  );
}

export async function processRaceOperation(
  _internals: EngineInternals,
  workflowId: string,
  operation: RaceOperation,
  callbacks: Pick<CoordinationOperationCallbacks, 'executeSubOperation' | 'runOperationWithResult'>,
): Promise<void> {
  return callbacks.runOperationWithResult(workflowId, operation, async () => {
    // Abort losing sub-operations once the race settles. Without this,
    // a losing agent sub-op would continue running its full LLM loop in
    // the background, consuming budget and emitting events with no
    // observer.
    const controller = new AbortController();
    const subOperations = operation.operations.map((subOperation) =>
      callbacks.executeSubOperation(workflowId, subOperation, controller.signal),
    );
    // Swallow rejections from losing branches — only the race winner's
    // result (or error) is surfaced. Losers typically reject with
    // AbortError after the controller fires in the finally block, and
    // without a handler those would surface as unhandled promise
    // rejections.
    void Promise.allSettled(subOperations);
    try {
      return await Promise.race(subOperations);
    } finally {
      controller.abort();
    }
  });
}

export async function processRunAllOperation(
  internals: EngineInternals,
  workflowId: string,
  operation: RunAllOperation,
  callbacks: Pick<
    CoordinationOperationCallbacks,
    'getActivityOperationCallbacks' | 'runOperationWithResult'
  >,
): Promise<void> {
  return callbacks.runOperationWithResult(workflowId, operation, () =>
    executeRunAllOperationResult(internals, workflowId, operation, callbacks),
  );
}

export function isConfiguredInlineActivity(
  fn: Function,
): fn is RunAllOperation['branches'][string][0] & ActivityFunctionWithMetadata {
  return typeof (fn as { execute?: unknown }).execute === 'function';
}

export async function executeRunAllOperationResult(
  internals: EngineInternals,
  workflowId: string,
  operation: RunAllOperation,
  callbacks: Pick<CoordinationOperationCallbacks, 'getActivityOperationCallbacks'>,
  speculativeState?: SpeculativeExecutionState,
): Promise<Record<string, unknown>> {
  return executeRunAllBranches(
    operation.branches as Parameters<typeof executeRunAllBranches>[0],
    (fn, args) => {
      // Only speculative runAll activity branches need the full execution
      // pipeline so verification and compensation tracking are preserved.
      if (!speculativeState || !isConfiguredInlineActivity(fn)) {
        return callActivityFunction(fn, args);
      }

      return executeActivityOperationResultFromInternals(
        internals,
        workflowId,
        {
          type: 'activity',
          operationId: crypto.randomUUID(),
          activityName: fn.name,
          fn,
          args,
        },
        callbacks.getActivityOperationCallbacks(),
        speculativeState,
      );
    },
  );
}
