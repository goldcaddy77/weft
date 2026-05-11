import {
  atomicStateDataKey,
  commitAtomicStateDelete,
  commitAtomicStateValue,
  readAtomicStateSnapshot,
} from '../atomic-state.ts';
import type { ContextOperationRequest } from '../context.ts';
import type { HumanReviewOptions } from '../review/index.ts';
import {
  assertChildWorkflowNestingDepth,
  executeChildWorkflow,
  type ChildWorkflowOperationCallbacks,
} from './child-workflow.ts';
import type { EngineInternals } from './internals.ts';
import {
  executeActivityOperationResult,
  type ActivityOperationCallbacks,
} from './operations-activity.ts';
import {
  executeRunAllOperationResult,
  type CoordinationOperationCallbacks,
} from './operations-coordination.ts';
import type { OperationWithCallerStack } from './operations-router.ts';
import type { StateOperationCallbacks } from './operations-state.ts';
import type { SpeculativeExecutionState } from './speculative-execution-state.ts';
import { callMemoFunction } from './state-utilities.ts';

type SubOperationCallbacks = {
  createActivityOperationCallbacks: () => ActivityOperationCallbacks;
  createChildWorkflowOperationCallbacks: () => ChildWorkflowOperationCallbacks;
  createCoordinationOperationCallbacks: () => CoordinationOperationCallbacks;
  createStateOperationCallbacks: () => StateOperationCallbacks;
};

type WaitReviewOperationCallbacks = {
  runOperationWithoutResult: (
    workflowId: string,
    operation: OperationWithCallerStack,
    execute: () => Promise<void>,
  ) => Promise<void>;
  processReviewOperation: (workflowId: string, options: HumanReviewOptions) => Promise<void>;
};

export async function processWaitReviewOperation(
  _internals: EngineInternals,
  workflowId: string,
  operation: Extract<ContextOperationRequest, { type: 'wait-review' }>,
  callbacks: WaitReviewOperationCallbacks,
): Promise<void> {
  return callbacks.runOperationWithoutResult(workflowId, operation, () =>
    callbacks.processReviewOperation(workflowId, operation.reviewOptions),
  );
}

// oxlint-disable-next-line complexity -- ID:core-engine-execute-sub-operation-complexity
export async function executeSubOperation(
  internals: EngineInternals,
  workflowId: string,
  operation: ContextOperationRequest,
  callbacks: SubOperationCallbacks,
  signal?: AbortSignal,
  speculativeState?: SpeculativeExecutionState,
): Promise<unknown> {
  signal?.throwIfAborted();

  switch (operation.type) {
    case 'activity':
      signal?.throwIfAborted();
      return executeActivityOperationResult(
        internals,
        workflowId,
        operation,
        callbacks.createActivityOperationCallbacks(),
        speculativeState,
      );
    case 'child-workflow': {
      signal?.throwIfAborted();
      return executeChildWorkflow(
        internals,
        workflowId,
        operation,
        assertChildWorkflowNestingDepth(internals, workflowId),
        callbacks.createChildWorkflowOperationCallbacks(),
      );
    }
    case 'memo':
      signal?.throwIfAborted();
      return callMemoFunction(operation.fn);
    case 'state-read': {
      signal?.throwIfAborted();
      return readAtomicStateSnapshot(
        internals.storage,
        atomicStateDataKey(operation.scope, operation.key),
        operation,
      );
    }
    case 'state-commit': {
      signal?.throwIfAborted();
      const dataKey = atomicStateDataKey(operation.scope, operation.key);
      const result =
        operation.mode === 'delete'
          ? await commitAtomicStateDelete(internals.storage, dataKey, operation.expectedVersion)
          : await commitAtomicStateValue(
              internals.storage,
              dataKey,
              operation.expectedVersion,
              operation.value,
            );
      if (result.applied && operation.scope.type === 'execution') {
        await callbacks
          .createStateOperationCallbacks()
          .ensureTerminalCleanupTracked(operation.scope.ownerWorkflowId);
      }
      return result;
    }
    case 'parallel': {
      signal?.throwIfAborted();
      // Nested ctx.all (inside ctx.race or another sub-op): partial
      // persistence does NOT apply here. Top-level ctx.all writes its
      // partial entry to the workflow's accumulatedResults at its own
      // step; nested parallel operations are dispatched through this
      // path, not through processParallelOperation, so they have no
      // step of their own and no way to write a slot table back to
      // workflow state.
      //
      // Public contract: partial-failure preservation is a top-level
      // ctx.all / ctx.runAll feature only. Document this in the
      // parallel-execution guide. Users with side-effecting nested
      // branches must use idempotency keys.
      //
      // We still use Promise.all here so the outer parent receives the
      // first rejection in its original shape (string, undefined,
      // Error — whatever the branch threw).
      const subOperationPromises: Array<Promise<unknown>> = [];
      for (const subOperation of operation.operations) {
        subOperationPromises.push(
          executeSubOperation(
            internals,
            workflowId,
            subOperation,
            callbacks,
            signal,
            speculativeState,
          ),
        );
      }
      return Promise.all(subOperationPromises);
    }
    case 'race': {
      signal?.throwIfAborted();
      const controller = new AbortController();
      const abortNestedRace = () => {
        controller.abort(signal?.reason);
      };
      signal?.addEventListener('abort', abortNestedRace, { once: true });
      const subOperations: Array<Promise<unknown>> = [];
      for (const subOperation of operation.operations) {
        subOperations.push(
          executeSubOperation(
            internals,
            workflowId,
            subOperation,
            callbacks,
            controller.signal,
            speculativeState,
          ),
        );
      }
      void Promise.allSettled(subOperations);
      try {
        return await Promise.race(subOperations);
      } finally {
        signal?.removeEventListener('abort', abortNestedRace);
        controller.abort();
      }
    }
    case 'run-all':
      signal?.throwIfAborted();
      return executeRunAllOperationResult(
        internals,
        workflowId,
        operation,
        callbacks.createCoordinationOperationCallbacks(),
        speculativeState,
      );
    default:
      throw new Error(`Unsupported sub-operation type: ${operation.type}`);
  }
}
