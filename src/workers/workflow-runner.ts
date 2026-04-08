import type { TenantContext } from '../core/tenant.ts';
import type {
  OperationOutcome,
  OperationRequest,
  WorkerOutboundMessage,
  WorkflowContext,
} from '../core/types.ts';

// ---------------------------------------------------------------------------
// Worker-side workflow context
// ---------------------------------------------------------------------------

/**
 * Subset of {@link WorkflowContext} that the worker-side runner can build
 * locally from the `run` message. Engine-side fields (`executionTimeRemaining`
 * in particular) are stub values because the worker has no clock authority —
 * any user code reading them will see static numbers, not live deadlines. The
 * tenant field is the load-bearing one: it's how multi-tenant agent handlers
 * see their tenant inside worker mode.
 */
export type WorkerWorkflowContext = Pick<
  WorkflowContext,
  'workflowId' | 'tenant' | 'signal' | 'startedAt'
>;

interface RunMessageShape {
  workflowId: string;
  workflowType: string;
  input: unknown;
  tenant?: TenantContext;
  deadline?: number;
  headers?: [string, string][];
}

/**
 * Construct the worker-side `ctx` argument that gets passed as the first
 * positional parameter to a registered workflow handler. Engine-side fields
 * not represented in the `run` message are intentionally omitted — only the
 * `Pick`-ed subset above is populated.
 */
export function createWorkerWorkflowContext(
  message: RunMessageShape,
  controller: AbortController,
): WorkerWorkflowContext {
  return {
    workflowId: message.workflowId,
    tenant: message.tenant,
    signal: controller.signal,
    startedAt: Date.now(),
  };
}

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
  message: {
    workflowId: string;
    workflowType: string;
    input: unknown;
    tenant?: TenantContext;
    deadline?: number;
    headers?: [string, string][];
  },
  getWorkflowHandler: (
    type: string,
  ) => ((ctx: WorkerWorkflowContext, input: unknown) => AsyncGenerator) | undefined,
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

  const workerContext = createWorkerWorkflowContext(message, controller);
  const generator = handler(workerContext, message.input);

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

/**
 * Handle a `cancel` message: abort the workflow's {@link AbortController},
 * run the generator's `finally` blocks by calling `generator.return()`, and
 * tear down the runner's in-memory state. The `return()` call is wrapped in a
 * try/catch because a well-behaved workflow's `finally` block may still throw
 * on cancellation (e.g. a `using` disposer), and we must never let that
 * prevent the rest of cleanup from running.
 */
export async function handleCancelMessage(
  context: WorkflowRunnerContext,
  message: { workflowId: string },
): Promise<void> {
  const controller = context.abortControllers.get(message.workflowId);
  if (controller) {
    controller.abort();
  }

  const generator = context.generators.get(message.workflowId);
  if (generator) {
    try {
      await generator.return(undefined);
    } catch {
      // Swallow: a finalizer in the workflow's try/finally may throw on
      // cancel, but we still need to proceed to cleanup regardless.
    }
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
