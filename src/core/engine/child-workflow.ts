import type { ContextOperationRequest } from '../context.ts';
import type { ComposedWorkflowInterceptor } from '../interceptor.ts';
import type { StartOptions, WorkflowState } from '../types.ts';
import { WorkflowAlreadyExistsError } from './errors.ts';
import type { WorkflowHandle } from './handles.ts';
import type { EngineInternals } from './internals.ts';
import { encodedValuesEqual } from './state-utilities.ts';

type ChildWorkflowOperation = Extract<ContextOperationRequest, { type: 'child-workflow' }>;
type HandoffOperation = Extract<ContextOperationRequest, { type: 'handoff' }>;
type DebateOperation = Extract<ContextOperationRequest, { type: 'debate' }>;
type SuperviseOperation = Extract<ContextOperationRequest, { type: 'supervise' }>;
type ChildWorkflowResultOperation =
  | ChildWorkflowOperation
  | HandoffOperation
  | DebateOperation
  | SuperviseOperation;

export type ChildWorkflowOperationCallbacks = {
  runOperationWithResult: (
    workflowId: string,
    operation: ChildWorkflowResultOperation,
    execute: () => Promise<unknown>,
  ) => Promise<void>;
  start: (type: string, input: unknown, options?: StartOptions) => Promise<WorkflowHandle>;
  loadWorkflowState: (workflowId: string) => Promise<WorkflowState | null>;
  getHandle: (workflowId: string) => WorkflowHandle;
  getComposedWorkflowInterceptor: () => ComposedWorkflowInterceptor | null;
};

export async function processChildWorkflowOperation(
  internals: EngineInternals,
  workflowId: string,
  operation: ChildWorkflowOperation,
  callbacks: ChildWorkflowOperationCallbacks,
): Promise<void> {
  return callbacks.runOperationWithResult(workflowId, operation, () =>
    executeChildWorkflow(
      internals,
      workflowId,
      operation,
      assertChildWorkflowNestingDepth(internals, workflowId),
      callbacks,
    ),
  );
}

export function assertChildWorkflowNestingDepth(
  internals: EngineInternals,
  workflowId: string,
): number {
  const currentDepth = getWorkflowNestingDepth(internals, workflowId);
  if (currentDepth + 1 > internals.options.maxNestingDepth) {
    throw new Error(
      `Child workflow nesting depth exceeded: ${currentDepth + 1} exceeds maximum of ${internals.options.maxNestingDepth}. ` +
        'Configure maxNestingDepth in engine options to increase the limit.',
    );
  }

  return currentDepth;
}

export function getWorkflowNestingDepth(internals: EngineInternals, workflowId: string): number {
  const currentContext = internals.inlineStrategy?.getContext(workflowId);
  return currentContext?.nestingDepth ?? internals.workflowNestingDepths.get(workflowId) ?? 0;
}

export async function executeChildWorkflow(
  internals: EngineInternals,
  workflowId: string,
  operation: ChildWorkflowOperation,
  currentDepth: number,
  callbacks: Pick<
    ChildWorkflowOperationCallbacks,
    'getComposedWorkflowInterceptor' | 'getHandle' | 'loadWorkflowState' | 'start'
  >,
): Promise<unknown> {
  const rawId = operation.options?.['id'];
  const childWorkflowId = typeof rawId === 'string' ? rawId : crypto.randomUUID();
  const parentHeaders = internals.workflowHeaders.get(workflowId) ?? new Map<string, string>();
  // oxlint-disable-next-line complexity -- ID:core-engine-execute-child-complexity
  const executeChild = async () => {
    internals.pendingNestingDepth = currentDepth + 1;
    internals.pendingParentHeaders = internals.workflowHeaders.get(workflowId);
    let childHandle: WorkflowHandle;

    try {
      childHandle = await callbacks.start(operation.workflowType, operation.input, {
        id: childWorkflowId,
      });
    } catch (error) {
      if (error instanceof WorkflowAlreadyExistsError) {
        const [existingState, parentState] = await Promise.all([
          callbacks.loadWorkflowState(childWorkflowId),
          callbacks.loadWorkflowState(workflowId),
        ]);

        if (!existingState) {
          throw error;
        }

        const existingTenantId = existingState.tenant?.id;
        const parentTenantId = parentState?.tenant?.id;
        const tenantMatches =
          (existingTenantId === undefined && parentTenantId === undefined) ||
          (existingTenantId !== undefined &&
            parentTenantId !== undefined &&
            existingTenantId === parentTenantId);

        if (
          existingState.type !== operation.workflowType ||
          !encodedValuesEqual(existingState.input, operation.input) ||
          !tenantMatches
        ) {
          throw new Error(
            `Child workflow id collision for "${childWorkflowId}" does not match the requested child workflow`,
            { cause: error },
          );
        }

        childHandle = callbacks.getHandle(childWorkflowId);
      } else {
        throw error;
      }
    }

    return childHandle.result();
  };

  const composedInterceptor = callbacks.getComposedWorkflowInterceptor();
  if (!composedInterceptor) {
    return executeChild();
  }

  return composedInterceptor.childWorkflow(
    {
      workflowId,
      childWorkflowId,
      workflowType: operation.workflowType,
      input: operation.input,
      headers: new Map<string, string>(),
      parentHeaders,
    },
    executeChild,
  );
}

export async function processHandoffOperation(
  internals: EngineInternals,
  workflowId: string,
  operation: HandoffOperation,
  callbacks: Pick<ChildWorkflowOperationCallbacks, 'runOperationWithResult'>,
): Promise<void> {
  return callbacks.runOperationWithResult(workflowId, operation, async () => {
    const { handoff: executeHandoff, createChildHeaders } =
      await import('../../ai/coordination/index.ts');
    return executeHandoff({
      ...operation.options,
      headers: createChildHeaders(internals.workflowHeaders.get(workflowId)),
    });
  });
}

export async function processDebateOperation(
  _internals: EngineInternals,
  workflowId: string,
  operation: DebateOperation,
  callbacks: Pick<ChildWorkflowOperationCallbacks, 'runOperationWithResult'>,
): Promise<void> {
  return callbacks.runOperationWithResult(workflowId, operation, async () => {
    const { debate: executeDebate } = await import('../../ai/coordination/index.ts');
    return executeDebate(operation.options);
  });
}

export async function processSuperviseOperation(
  _internals: EngineInternals,
  workflowId: string,
  operation: SuperviseOperation,
  callbacks: Pick<ChildWorkflowOperationCallbacks, 'runOperationWithResult'>,
): Promise<void> {
  return callbacks.runOperationWithResult(workflowId, operation, async () => {
    const { supervise: executeSupervise } = await import('../../ai/coordination/index.ts');
    return executeSupervise(operation.options);
  });
}
