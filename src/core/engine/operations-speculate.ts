import type { ContextOperationRequest } from '../context.ts';
import type { EngineInternals } from './internals.ts';
import type { OperationWithCallerStack } from './operations-router.ts';
import { SpeculativeExecutionState } from './speculative-execution-state.ts';

type SpeculateOperation = Extract<ContextOperationRequest, { type: 'speculate' }>;
type SpeculativeOperationGenerator =
  | Generator<ContextOperationRequest, unknown, unknown>
  | AsyncGenerator<ContextOperationRequest, unknown, unknown>;

export type SpeculateOperationCallbacks = {
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
};

export async function processSpeculateOperation(
  internals: EngineInternals,
  workflowId: string,
  operation: SpeculateOperation,
  callbacks: SpeculateOperationCallbacks,
): Promise<void> {
  return callbacks.runOperationWithResult(workflowId, operation, () =>
    executeSpeculativeBranch(internals, workflowId, operation, callbacks),
  );
}

export async function executeSpeculativeBranch(
  internals: EngineInternals,
  workflowId: string,
  operation: SpeculateOperation,
  callbacks: Pick<SpeculateOperationCallbacks, 'executeSubOperation'>,
): Promise<unknown> {
  const inlineStrategy = internals.inlineStrategy;
  if (!inlineStrategy) {
    throw new Error('ctx.speculate() requires inline execution mode');
  }

  const parentContext = inlineStrategy.getContext(workflowId);
  if (!parentContext) {
    throw new Error(`No active inline context for workflow "${workflowId}"`);
  }

  const speculativeContext = parentContext.createSpeculativeChild();
  const speculativeState = new SpeculativeExecutionState();
  const generator = createSpeculativeOperationGenerator(operation, speculativeContext);

  try {
    const result = await driveSpeculativeGenerator(
      workflowId,
      generator,
      speculativeState,
      callbacks,
    );
    await speculativeState.drainVerifications();
    parentContext.commitSpeculativeChild(speculativeContext);
    return result;
  } catch (error) {
    await speculativeState.rollback();
    throw error;
  }
}

function createSpeculativeOperationGenerator(
  operation: SpeculateOperation,
  speculativeContext: Parameters<SpeculateOperation['execute']>[0],
): SpeculativeOperationGenerator {
  // Context.speculate() only accepts workflows that yield ContextOperationRequest
  // values; the stored operation type is wider for async generators.
  return operation.execute(speculativeContext) as SpeculativeOperationGenerator;
}

export async function driveSpeculativeGenerator(
  workflowId: string,
  generator: SpeculativeOperationGenerator,
  speculativeState: SpeculativeExecutionState,
  callbacks: Pick<SpeculateOperationCallbacks, 'executeSubOperation'>,
): Promise<unknown> {
  const advance = async (
    lastResult: unknown,
    errorToThrow: Error | undefined,
  ): Promise<unknown> => {
    const iterationResult =
      errorToThrow === undefined
        ? await generator.next(lastResult)
        : await generator.throw(errorToThrow);

    if (iterationResult.done) {
      return iterationResult.value;
    }

    const nextOperation = iterationResult.value;
    try {
      const nextResult = await callbacks.executeSubOperation(
        workflowId,
        nextOperation,
        undefined,
        speculativeState,
      );
      return advance(nextResult, undefined);
    } catch (error) {
      return advance(lastResult, error instanceof Error ? error : new Error(String(error)));
    }
  };

  return advance(undefined, undefined);
}
