import type { AgentLoopSuspendedError as AgentLoopSuspendedErrorValue } from '../../ai/agent/index.ts';
import type { ContextOperationRequest } from '../context.ts';
import type { ComposedWorkflowInterceptor } from '../interceptor.ts';
import type { WorkflowState } from '../types.ts';
import type { EngineInternals } from './internals.ts';
import {
  closeAgentInterceptor,
  createAgentInterception,
  exposeAgentObservability,
  openAgentInterceptor,
} from './operations-agent-support.ts';
import {
  clearPendingAgentExecutionState,
  createAgentProvider,
  createAgentResumeSignalName,
  loadPendingAgentExecutionState,
  markPendingAgentResumeStateResumed,
  repairMissingSignalMirrorIfNeeded,
  storePendingAgentExecutionState,
  type SignalPayloadWaitResult,
  type StoredPendingAgentExecutionState,
} from './operations-agent-suspension.ts';
import type { OperationWithCallerStack } from './operations-router.ts';
import type { ConsumedSignalResult } from './signals.ts';
import { SpeculativeExecutionState } from './speculative-execution-state.ts';

export { withPendingChatResumeTurnIndex } from './operations-agent-suspension.ts';

type AgentOperation = Extract<ContextOperationRequest, { type: 'agent' }>;
type SpeculateOperation = Extract<ContextOperationRequest, { type: 'speculate' }>;
type SpeculativeOperationGenerator =
  | Generator<ContextOperationRequest, unknown, unknown>
  | AsyncGenerator<ContextOperationRequest, unknown, unknown>;

type AgentOperationDisposition = { kind: 'completed'; value: unknown } | { kind: 'parked' };
type AgentLoopSuspensionResolution =
  | { kind: 'parked' }
  | { kind: 'resumed'; pendingExecutionState: StoredPendingAgentExecutionState | undefined };
type AgentLoopSuspendedErrorConstructor = Function & {
  readonly prototype: AgentLoopSuspendedErrorValue;
};

export type AgentOperationCallbacks = {
  runOperationWithResult: (
    workflowId: string,
    operation: OperationWithCallerStack,
    execute: () => Promise<unknown>,
  ) => Promise<void>;
  completeOperation: (workflowId: string, value: unknown) => void;
  failOperation: (workflowId: string, operation: AgentOperation, error: unknown) => void;
  executeSubOperation: (
    workflowId: string,
    operation: ContextOperationRequest,
    signal?: AbortSignal,
    speculativeState?: SpeculativeExecutionState,
  ) => Promise<unknown>;
  ensureTerminalCleanupTracked: (workflowId: string) => Promise<void>;
  hasBufferedSignal: (workflowId: string, signalName: string) => Promise<boolean>;
  consumeSignal: (workflowId: string, signalName: string) => Promise<ConsumedSignalResult>;
  waitForSignalPayload: (
    workflowId: string,
    signalName: string,
  ) => Promise<SignalPayloadWaitResult>;
  parkInlineWorkflowForAgentSuspension: (
    workflowId: string,
    stepIndex: number,
    resumeToken: string,
  ) => Promise<boolean>;
  runSerializedWorkflowStateWrite: <Result>(
    workflowId: string,
    writeOperation: () => Promise<Result>,
  ) => Promise<Result>;
  loadWorkflowState: (workflowId: string) => Promise<WorkflowState | null>;
  resumeParkedInlineWorkflow: (workflowId: string) => Promise<void>;
  dispatchEvent: (event: Event) => boolean;
  broadcastSignalReceived: (message: {
    type: 'signal:received';
    workflowId: string;
    signalName: string;
  }) => void;
  forwardEventToHandle: (workflowId: string, event: Event) => void;
  getComposedWorkflowInterceptor: () => ComposedWorkflowInterceptor | null;
  getEventTarget: () => EventTarget;
};

export async function processAgentContextOperation(
  internals: EngineInternals,
  workflowId: string,
  operation: AgentOperation,
  callbacks: AgentOperationCallbacks,
): Promise<void> {
  try {
    const disposition = await executeAgentContextOperationResult(
      internals,
      workflowId,
      operation,
      callbacks,
    );
    if (disposition.kind === 'parked') {
      return;
    }

    callbacks.completeOperation(workflowId, disposition.value);
  } catch (error) {
    callbacks.failOperation(workflowId, operation, error);
  }
}

export async function processSpeculateOperation(
  internals: EngineInternals,
  workflowId: string,
  operation: SpeculateOperation,
  callbacks: AgentOperationCallbacks,
): Promise<void> {
  return callbacks.runOperationWithResult(workflowId, operation, () =>
    executeSpeculativeBranch(internals, workflowId, operation, callbacks),
  );
}

export async function executeAgentContextOperationResult(
  internals: EngineInternals,
  workflowId: string,
  operation: AgentOperation,
  callbacks: AgentOperationCallbacks,
): Promise<AgentOperationDisposition> {
  const { AgentLoopSuspendedError, executeAgentLoopWithState } =
    await import('../../ai/agent/index.ts');
  const { prompt, ...rest } = operation.options;
  let pendingExecutionState = await loadPendingAgentExecutionState(
    internals,
    workflowId,
    operation.stepIndex,
  );
  await callbacks.ensureTerminalCleanupTracked(workflowId);

  const context = internals.inlineStrategy?.getContext(workflowId);

  const agentInterception = createAgentInterception(workflowId, rest.model, prompt);
  const agentInterceptorGenerator = openAgentInterceptor(agentInterception, callbacks);
  let agentInterceptorClosed = false;
  const { ToolEffectLog } = await import('../effect-log/index.ts');
  const toolEffectLog = new ToolEffectLog(internals.storage, workflowId, operation.operationId);
  const provider = createAgentProvider(
    internals,
    workflowId,
    operation.stepIndex,
    rest.provider,
    callbacks,
  );

  try {
    while (true) {
      try {
        const agentResult = await executeAgentLoopWithState(
          {
            ...rest,
            provider,
            eventTarget: callbacks.getEventTarget(),
            workflowId,
            agentId: operation.operationId,
            toolEffectLog,
          },
          prompt,
          pendingExecutionState?.loopState,
        );
        closeAgentInterceptor(agentInterceptorGenerator, agentResult.content);
        agentInterceptorClosed = true;
        exposeAgentObservability(context, agentResult, rest.maxTurns ?? 10);
        await clearPendingAgentExecutionState(internals, workflowId, operation.stepIndex);
        return { kind: 'completed', value: agentResult.content };
      } catch (error) {
        const suspension = await handleAgentLoopSuspension(
          error,
          AgentLoopSuspendedError,
          internals,
          workflowId,
          operation,
          callbacks,
        );
        if (suspension.kind === 'parked') {
          return { kind: 'parked' };
        }
        pendingExecutionState = suspension.pendingExecutionState;
      }
    }
  } finally {
    if (!agentInterceptorClosed) {
      cancelAgentInterceptor(agentInterceptorGenerator);
    }
  }
}

async function handleAgentLoopSuspension(
  error: unknown,
  suspendedError: AgentLoopSuspendedErrorConstructor,
  internals: EngineInternals,
  workflowId: string,
  operation: AgentOperation,
  callbacks: AgentOperationCallbacks,
): Promise<AgentLoopSuspensionResolution> {
  if (!isAgentLoopSuspendedError(error, suspendedError)) {
    await clearPendingAgentExecutionState(internals, workflowId, operation.stepIndex);
    throw error;
  }

  await storePendingAgentExecutionState(
    internals,
    workflowId,
    operation.stepIndex,
    {
      loopState: error.loopState,
      pendingResume: error.pendingResume,
    },
    callbacks,
  );

  if (
    await callbacks.parkInlineWorkflowForAgentSuspension(
      workflowId,
      operation.stepIndex,
      error.pendingResume.hint.resumeToken,
    )
  ) {
    return { kind: 'parked' };
  }

  const pendingExecutionState = await waitForAgentResumeSignal(
    internals,
    workflowId,
    operation.stepIndex,
    error.pendingResume.turnIndex,
    error.pendingResume.hint.resumeToken,
    callbacks,
  );
  if (internals.abortController.signal.aborted) {
    return { kind: 'parked' };
  }

  return { kind: 'resumed', pendingExecutionState };
}

function isAgentLoopSuspendedError(
  error: unknown,
  suspendedError: AgentLoopSuspendedErrorConstructor,
): error is AgentLoopSuspendedErrorValue {
  return error instanceof suspendedError;
}

async function waitForAgentResumeSignal(
  internals: EngineInternals,
  workflowId: string,
  stepIndex: number,
  turnIndex: number,
  resumeToken: string,
  callbacks: AgentOperationCallbacks,
): Promise<StoredPendingAgentExecutionState | undefined> {
  await repairMissingSignalMirrorIfNeeded(internals, workflowId, stepIndex, resumeToken);

  const payload = await callbacks.waitForSignalPayload(
    workflowId,
    createAgentResumeSignalName(stepIndex, resumeToken),
  );
  if (payload.kind === 'aborted') {
    return undefined;
  }

  await markPendingAgentResumeStateResumed(
    internals,
    workflowId,
    stepIndex,
    turnIndex,
    payload.payload,
    callbacks,
  );
  return loadPendingAgentExecutionState(internals, workflowId, stepIndex);
}

export async function executeSpeculativeBranch(
  internals: EngineInternals,
  workflowId: string,
  operation: SpeculateOperation,
  callbacks: Pick<AgentOperationCallbacks, 'executeSubOperation'>,
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
      internals,
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
  // Context.speculate() only accepts workflows that yield ContextOperationRequest values;
  // the stored operation type is wider for async generators.
  return operation.execute(speculativeContext) as SpeculativeOperationGenerator;
}

export async function driveSpeculativeGenerator(
  _internals: EngineInternals,
  workflowId: string,
  generator: SpeculativeOperationGenerator,
  speculativeState: SpeculativeExecutionState,
  callbacks: Pick<AgentOperationCallbacks, 'executeSubOperation'>,
): Promise<unknown> {
  let lastResult: unknown = undefined;
  let errorToThrow: Error | undefined;

  while (true) {
    const iterationResult =
      errorToThrow === undefined
        ? await generator.next(lastResult)
        : await generator.throw(errorToThrow);

    errorToThrow = undefined;

    if (iterationResult.done) {
      return iterationResult.value;
    }

    const nextOperation = iterationResult.value;
    try {
      lastResult = await callbacks.executeSubOperation(
        workflowId,
        nextOperation,
        undefined,
        speculativeState,
      );
    } catch (error) {
      errorToThrow = error instanceof Error ? error : new Error(String(error));
    }
  }
}

function cancelAgentInterceptor(generator: Generator<unknown, unknown, unknown> | undefined): void {
  if (generator) {
    generator.return(undefined);
  }
}
