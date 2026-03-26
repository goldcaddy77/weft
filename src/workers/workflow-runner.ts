import type { OperationOutcome, OperationRequest, WorkerOutboundMessage } from '../core/types.ts';

// ---------------------------------------------------------------------------
// Workflow runner context: holds live generator state for in-flight workflows
// ---------------------------------------------------------------------------

export interface WorkflowRunnerContext {
  generators: Map<string, AsyncGenerator>;
  abortControllers: Map<string, AbortController>;
}

export function createWorkflowRunnerContext(): WorkflowRunnerContext {
  return {
    generators: new Map(),
    abortControllers: new Map(),
  };
}

// ---------------------------------------------------------------------------
// Handle "run" – instantiate a generator and advance to the first yield/return
// ---------------------------------------------------------------------------

export async function handleRunMessage(
  context: WorkflowRunnerContext,
  message: { workflowId: string; workflowType: string; input: unknown },
  getWorkflowHandler: (type: string) => ((...arguments_: unknown[]) => AsyncGenerator) | undefined,
): Promise<WorkerOutboundMessage> {
  const handler = getWorkflowHandler(message.workflowType);

  if (!handler) {
    return {
      type: 'failed',
      workflowId: message.workflowId,
      error: `Unknown workflow type: ${message.workflowType}`,
    };
  }

  const controller = new AbortController();
  context.abortControllers.set(message.workflowId, controller);

  const generator = handler(message.input);

  try {
    const step = await generator.next();
    return processGeneratorStep(context, message.workflowId, generator, step);
  } catch (error) {
    cleanup(context, message.workflowId);
    return {
      type: 'failed',
      workflowId: message.workflowId,
      error: formatError(error),
    };
  }
}

// ---------------------------------------------------------------------------
// Handle "resume" – feed an operation result back into a suspended generator
// ---------------------------------------------------------------------------

export async function handleResumeMessage(
  context: WorkflowRunnerContext,
  message: { workflowId: string; result: unknown; operationResult?: OperationOutcome },
): Promise<WorkerOutboundMessage> {
  const generator = context.generators.get(message.workflowId);

  if (!generator) {
    return {
      type: 'failed',
      workflowId: message.workflowId,
      error: `No active generator for workflow: ${message.workflowId}`,
    };
  }

  try {
    // If the operation failed, throw the error into the generator so the
    // workflow can handle it via try/catch rather than silently continuing.
    const outcome = message.operationResult;
    const step =
      outcome?.status === 'failed'
        ? await generator.throw(new Error(outcome.error))
        : await generator.next(message.result);
    return processGeneratorStep(context, message.workflowId, generator, step);
  } catch (error) {
    cleanup(context, message.workflowId);
    return {
      type: 'failed',
      workflowId: message.workflowId,
      error: formatError(error),
    };
  }
}

// ---------------------------------------------------------------------------
// Handle "cancel" – abort the controller and tear down state
// ---------------------------------------------------------------------------

export function handleCancelMessage(
  context: WorkflowRunnerContext,
  message: { workflowId: string },
): void {
  const controller = context.abortControllers.get(message.workflowId);
  if (controller) {
    controller.abort();
  }
  cleanup(context, message.workflowId);
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function processGeneratorStep(
  context: WorkflowRunnerContext,
  workflowId: string,
  generator: AsyncGenerator,
  step: IteratorResult<unknown>,
): WorkerOutboundMessage {
  if (step.done) {
    cleanup(context, workflowId);
    return {
      type: 'completed',
      workflowId,
      result: step.value,
    };
  }

  // The yielded value is an OperationRequest describing the next operation
  context.generators.set(workflowId, generator);
  return {
    type: 'checkpoint',
    workflowId,
    checkpoint: new ArrayBuffer(0),
    operationRequest: step.value as OperationRequest,
  };
}

function cleanup(context: WorkflowRunnerContext, workflowId: string): void {
  context.generators.delete(workflowId);
  context.abortControllers.delete(workflowId);
}

function formatError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}
