import { describe, expect, it } from 'bun:test';
import type { OperationRequest, WorkerOutboundMessage } from '../core/types.ts';
import {
  createWorkflowRunnerContext,
  handleCancelMessage,
  handleResumeMessage,
  handleRunMessage,
} from './workflow-runner.ts';

describe('createWorkflowRunnerContext', () => {
  it('returns empty maps for generators and abort controllers', () => {
    const context = createWorkflowRunnerContext();

    expect(context.generators).toBeInstanceOf(Map);
    expect(context.abortControllers).toBeInstanceOf(Map);
    expect(context.generators.size).toBe(0);
    expect(context.abortControllers.size).toBe(0);
  });
});

describe('handleRunMessage', () => {
  it('returns completed for a simple generator that finishes immediately', async () => {
    const context = createWorkflowRunnerContext();

    async function* simpleWorkflow() {
      return 'done';
    }

    const result = await handleRunMessage(
      context,
      { workflowId: 'wf-1', workflowType: 'simple', input: null },
      () => simpleWorkflow,
    );

    expect(result).toEqual({
      type: 'completed',
      workflowId: 'wf-1',
      result: 'done',
    } satisfies WorkerOutboundMessage);
  });

  it('returns failed for an unknown workflow type', async () => {
    const context = createWorkflowRunnerContext();

    const result = await handleRunMessage(
      context,
      { workflowId: 'wf-2', workflowType: 'unknown', input: null },
      () => undefined,
    );

    expect(result.type).toBe('failed');
    expect(result.workflowId).toBe('wf-2');
    expect((result as { error: string }).error).toContain('unknown');
  });

  it('returns failed when the generator throws', async () => {
    const context = createWorkflowRunnerContext();

    async function* throwingWorkflow() {
      throw new Error('workflow exploded');
    }

    const result = await handleRunMessage(
      context,
      { workflowId: 'wf-3', workflowType: 'throwing', input: null },
      () => throwingWorkflow,
    );

    expect(result.type).toBe('failed');
    expect((result as { error: string }).error).toContain('workflow exploded');
  });

  it('returns a checkpoint when the generator yields an operation request', async () => {
    const context = createWorkflowRunnerContext();

    const operationRequest: OperationRequest = {
      id: 'op-1',
      workflowId: 'wf-4',
      kind: 'activity',
      queue: 'default',
      activityName: 'greet',
      input: 'world',
      attempt: 1,
      retryPolicy: {
        maxAttempts: 3,
        initialBackoff: 1000,
        backoffMultiplier: 2,
        maxBackoff: 30_000,
      },
      scheduledAt: Date.now(),
    };

    async function* yieldingWorkflow() {
      const result: unknown = yield operationRequest;
      return result;
    }

    const result = await handleRunMessage(
      context,
      { workflowId: 'wf-4', workflowType: 'yielding', input: null },
      () => yieldingWorkflow,
    );

    expect(result.type).toBe('checkpoint');
    expect(result.workflowId).toBe('wf-4');
    expect((result as { operationRequest: OperationRequest }).operationRequest).toEqual(
      operationRequest,
    );

    // Generator should be stored for later resumption
    expect(context.generators.has('wf-4')).toBe(true);
  });

  it('passes input to the generator function', async () => {
    const context = createWorkflowRunnerContext();
    let receivedInput: unknown;

    async function* inputWorkflow(_ctx: unknown, input: unknown) {
      receivedInput = input;
      return 'processed';
    }

    await handleRunMessage(
      context,
      { workflowId: 'wf-5', workflowType: 'input-test', input: { key: 'value' } },
      () => inputWorkflow,
    );

    expect(receivedInput).toEqual({ key: 'value' });
  });

  it('passes a worker-side context as the first argument with tenant populated', async () => {
    const context = createWorkflowRunnerContext();
    let receivedContext: { workflowId: string; tenant?: { id: string } } | undefined;

    async function* tenantWorkflow(ctx: unknown, _input: unknown) {
      receivedContext = ctx as { workflowId: string; tenant?: { id: string } };
      return 'ok';
    }

    await handleRunMessage(
      context,
      {
        workflowId: 'wf-with-tenant',
        workflowType: 'tenant-test',
        input: null,
        tenant: { id: 'test', attributes: { plan: 'enterprise' } },
      },
      () => tenantWorkflow,
    );

    expect(receivedContext).toBeDefined();
    expect(receivedContext!.workflowId).toBe('wf-with-tenant');
    expect(receivedContext!.tenant?.id).toBe('test');
  });

  it('passes undefined tenant when no tenant is provided on the run message', async () => {
    const context = createWorkflowRunnerContext();
    let receivedContext: { tenant?: unknown } | undefined;

    async function* tenantWorkflow(ctx: unknown, _input: unknown) {
      receivedContext = ctx as { tenant?: unknown };
      return 'ok';
    }

    await handleRunMessage(
      context,
      { workflowId: 'wf-no-tenant', workflowType: 'tenant-test', input: null },
      () => tenantWorkflow,
    );

    expect(receivedContext).toBeDefined();
    expect(receivedContext!.tenant).toBeUndefined();
  });

  it('exposes an abort signal on the worker context that aborts on cancel', async () => {
    const context = createWorkflowRunnerContext();
    let capturedSignal: AbortSignal | undefined;

    const operationRequest: OperationRequest = {
      id: 'op-1',
      workflowId: 'wf-signal',
      kind: 'activity',
      queue: 'default',
      attempt: 1,
      retryPolicy: {
        maxAttempts: 3,
        initialBackoff: 1000,
        backoffMultiplier: 2,
        maxBackoff: 30_000,
      },
      scheduledAt: Date.now(),
    };

    async function* signalWorkflow(ctx: { signal: AbortSignal }, _input: unknown) {
      capturedSignal = ctx.signal;
      yield operationRequest;
    }

    await handleRunMessage(
      context,
      { workflowId: 'wf-signal', workflowType: 'signal-test', input: null },
      () => signalWorkflow,
    );

    expect(capturedSignal).toBeDefined();
    expect(capturedSignal!.aborted).toBe(false);
    await handleCancelMessage(context, { workflowId: 'wf-signal' });
    expect(capturedSignal!.aborted).toBe(true);
  });

  it('registers an abort controller for the workflow', async () => {
    const context = createWorkflowRunnerContext();

    const operationRequest: OperationRequest = {
      id: 'op-1',
      workflowId: 'wf-6',
      kind: 'activity',
      queue: 'default',
      attempt: 1,
      retryPolicy: {
        maxAttempts: 3,
        initialBackoff: 1000,
        backoffMultiplier: 2,
        maxBackoff: 30_000,
      },
      scheduledAt: Date.now(),
    };

    async function* pendingWorkflow() {
      const result: unknown = yield operationRequest;
      return result;
    }

    await handleRunMessage(
      context,
      { workflowId: 'wf-6', workflowType: 'pending', input: null },
      () => pendingWorkflow,
    );

    expect(context.abortControllers.has('wf-6')).toBe(true);
  });
});

describe('handleResumeMessage', () => {
  it('resumes a yielded generator and returns completed', async () => {
    const context = createWorkflowRunnerContext();

    const operationRequest: OperationRequest = {
      id: 'op-1',
      workflowId: 'wf-resume-1',
      kind: 'activity',
      queue: 'default',
      attempt: 1,
      retryPolicy: {
        maxAttempts: 3,
        initialBackoff: 1000,
        backoffMultiplier: 2,
        maxBackoff: 30_000,
      },
      scheduledAt: Date.now(),
    };

    async function* twoStepWorkflow() {
      const result: unknown = yield operationRequest;
      return `got: ${String(result)}`;
    }

    // First, run the workflow to its first yield
    await handleRunMessage(
      context,
      { workflowId: 'wf-resume-1', workflowType: 'two-step', input: null },
      () => twoStepWorkflow,
    );

    // Now resume it
    const result = await handleResumeMessage(context, {
      workflowId: 'wf-resume-1',
      result: 'hello',
    });

    expect(result).toEqual({
      type: 'completed',
      workflowId: 'wf-resume-1',
      result: 'got: hello',
    } satisfies WorkerOutboundMessage);

    // Generator should be cleaned up after completion
    expect(context.generators.has('wf-resume-1')).toBe(false);
  });

  it('returns failed when resuming a non-existent workflow', async () => {
    const context = createWorkflowRunnerContext();

    const result = await handleResumeMessage(context, {
      workflowId: 'wf-nonexistent',
      result: null,
    });

    expect(result.type).toBe('failed');
    expect((result as { error: string }).error).toContain('wf-nonexistent');
  });

  it('throws the operation error into the generator when operationResult is failed', async () => {
    const context = createWorkflowRunnerContext();
    let caughtError: string | undefined;

    const operationRequest: OperationRequest = {
      id: 'op-fail',
      workflowId: 'wf-op-fail',
      kind: 'activity',
      queue: 'default',
      attempt: 1,
      retryPolicy: { maxAttempts: 1, initialBackoff: 0, backoffMultiplier: 1, maxBackoff: 0 },
      scheduledAt: Date.now(),
    };

    async function* failureHandlingWorkflow() {
      try {
        yield operationRequest;
      } catch (error) {
        caughtError = (error as Error).message;
      }
      return 'caught';
    }

    // Run to first yield
    await handleRunMessage(
      context,
      { workflowId: 'wf-op-fail', workflowType: 'fail-test', input: null },
      () => failureHandlingWorkflow,
    );

    // Resume with a failed operation outcome
    const result = await handleResumeMessage(context, {
      workflowId: 'wf-op-fail',
      result: null,
      operationResult: { status: 'failed', error: 'activity timed out' },
    });

    expect(result.type).toBe('completed');
    expect(caughtError).toBe('activity timed out');
  });

  it('returns the next checkpoint when the generator yields again', async () => {
    const context = createWorkflowRunnerContext();

    const firstOperation: OperationRequest = {
      id: 'op-1',
      workflowId: 'wf-multi',
      kind: 'activity',
      queue: 'default',
      activityName: 'step1',
      attempt: 1,
      retryPolicy: {
        maxAttempts: 3,
        initialBackoff: 1000,
        backoffMultiplier: 2,
        maxBackoff: 30_000,
      },
      scheduledAt: Date.now(),
    };

    const secondOperation: OperationRequest = {
      id: 'op-2',
      workflowId: 'wf-multi',
      kind: 'activity',
      queue: 'default',
      activityName: 'step2',
      attempt: 1,
      retryPolicy: {
        maxAttempts: 3,
        initialBackoff: 1000,
        backoffMultiplier: 2,
        maxBackoff: 30_000,
      },
      scheduledAt: Date.now(),
    };

    async function* multiStepWorkflow() {
      const first: unknown = yield firstOperation;
      const second: unknown = yield secondOperation;
      return { first, second };
    }

    // Run to first yield
    await handleRunMessage(
      context,
      { workflowId: 'wf-multi', workflowType: 'multi', input: null },
      () => multiStepWorkflow,
    );

    // Resume with first result -> should yield again
    const secondCheckpoint = await handleResumeMessage(context, {
      workflowId: 'wf-multi',
      result: 'result-1',
    });

    expect(secondCheckpoint.type).toBe('checkpoint');
    expect((secondCheckpoint as { operationRequest: OperationRequest }).operationRequest).toEqual(
      secondOperation,
    );

    // Resume with second result -> should complete
    const final = await handleResumeMessage(context, {
      workflowId: 'wf-multi',
      result: 'result-2',
    });

    expect(final).toEqual({
      type: 'completed',
      workflowId: 'wf-multi',
      result: { first: 'result-1', second: 'result-2' },
    } satisfies WorkerOutboundMessage);
  });
});

describe('handleCancelMessage', () => {
  it('aborts the controller for a running workflow', async () => {
    const context = createWorkflowRunnerContext();

    const operationRequest: OperationRequest = {
      id: 'op-1',
      workflowId: 'wf-cancel',
      kind: 'activity',
      queue: 'default',
      attempt: 1,
      retryPolicy: {
        maxAttempts: 3,
        initialBackoff: 1000,
        backoffMultiplier: 2,
        maxBackoff: 30_000,
      },
      scheduledAt: Date.now(),
    };

    async function* cancellableWorkflow() {
      const result: unknown = yield operationRequest;
      return result;
    }

    await handleRunMessage(
      context,
      { workflowId: 'wf-cancel', workflowType: 'cancellable', input: null },
      () => cancellableWorkflow,
    );

    const controller = context.abortControllers.get('wf-cancel');
    expect(controller).toBeDefined();
    expect(controller!.signal.aborted).toBe(false);

    await handleCancelMessage(context, { workflowId: 'wf-cancel' });

    expect(controller!.signal.aborted).toBe(true);
  });

  it('is a no-op for a non-existent workflow', async () => {
    const context = createWorkflowRunnerContext();

    // Should not throw
    await handleCancelMessage(context, { workflowId: 'wf-nonexistent' });
  });

  it('cleans up generators and controllers after cancellation', async () => {
    const context = createWorkflowRunnerContext();

    const operationRequest: OperationRequest = {
      id: 'op-1',
      workflowId: 'wf-cleanup',
      kind: 'activity',
      queue: 'default',
      attempt: 1,
      retryPolicy: {
        maxAttempts: 3,
        initialBackoff: 1000,
        backoffMultiplier: 2,
        maxBackoff: 30_000,
      },
      scheduledAt: Date.now(),
    };

    async function* workflow() {
      const result: unknown = yield operationRequest;
      return result;
    }

    await handleRunMessage(
      context,
      { workflowId: 'wf-cleanup', workflowType: 'workflow', input: null },
      () => workflow,
    );

    await handleCancelMessage(context, { workflowId: 'wf-cleanup' });

    expect(context.generators.has('wf-cleanup')).toBe(false);
    expect(context.abortControllers.has('wf-cleanup')).toBe(false);
  });

  it('runs finally blocks in the workflow generator when cancelled', async () => {
    const context = createWorkflowRunnerContext();
    let sideEffect = 0;

    const operationRequest: OperationRequest = {
      id: 'op-1',
      workflowId: 'wf-finally',
      kind: 'activity',
      queue: 'default',
      attempt: 1,
      retryPolicy: {
        maxAttempts: 3,
        initialBackoff: 1000,
        backoffMultiplier: 2,
        maxBackoff: 30_000,
      },
      scheduledAt: Date.now(),
    };

    async function* finallyWorkflow() {
      try {
        const result: unknown = yield operationRequest;
        return result;
      } finally {
        sideEffect++;
      }
    }

    await handleRunMessage(
      context,
      { workflowId: 'wf-finally', workflowType: 'finally-test', input: null },
      () => finallyWorkflow,
    );

    expect(sideEffect).toBe(0);

    await handleCancelMessage(context, { workflowId: 'wf-finally' });

    expect(sideEffect).toBe(1);
    expect(context.generators.has('wf-finally')).toBe(false);
    expect(context.abortControllers.has('wf-finally')).toBe(false);
  });

  it('swallows exceptions thrown from a workflow generator finalizer on cancel', async () => {
    const context = createWorkflowRunnerContext();

    const operationRequest: OperationRequest = {
      id: 'op-1',
      workflowId: 'wf-finally-throws',
      kind: 'activity',
      queue: 'default',
      attempt: 1,
      retryPolicy: {
        maxAttempts: 3,
        initialBackoff: 1000,
        backoffMultiplier: 2,
        maxBackoff: 30_000,
      },
      scheduledAt: Date.now(),
    };

    const throwOnDispose = (): never => {
      throw new Error('finalizer exploded');
    };

    async function* throwingFinallyWorkflow() {
      try {
        yield operationRequest;
      } finally {
        throwOnDispose();
      }
    }

    await handleRunMessage(
      context,
      { workflowId: 'wf-finally-throws', workflowType: 'throw-finally', input: null },
      () => throwingFinallyWorkflow,
    );

    // Must not throw even though the finalizer raises.
    await handleCancelMessage(context, { workflowId: 'wf-finally-throws' });

    expect(context.generators.has('wf-finally-throws')).toBe(false);
    expect(context.abortControllers.has('wf-finally-throws')).toBe(false);
  });
});

describe('handleResumeMessage — error paths', () => {
  it('returns failed when the generator throws on resume', async () => {
    const context = createWorkflowRunnerContext();

    const operationRequest: OperationRequest = {
      id: 'op-1',
      workflowId: 'wf-throw-on-resume',
      kind: 'activity',
      queue: 'default',
      attempt: 1,
      retryPolicy: {
        maxAttempts: 3,
        initialBackoff: 1000,
        backoffMultiplier: 2,
        maxBackoff: 30_000,
      },
      scheduledAt: Date.now(),
    };

    async function* throwOnResumeWorkflow() {
      yield operationRequest;
      throw new Error('resume exploded');
    }

    await handleRunMessage(
      context,
      { workflowId: 'wf-throw-on-resume', workflowType: 'throwing', input: null },
      () => throwOnResumeWorkflow,
    );

    const result = await handleResumeMessage(context, {
      workflowId: 'wf-throw-on-resume',
      result: 'trigger',
    });

    expect(result.type).toBe('failed');
    expect((result as { error: string }).error).toContain('resume exploded');

    // Generator should be cleaned up
    expect(context.generators.has('wf-throw-on-resume')).toBe(false);
    expect(context.abortControllers.has('wf-throw-on-resume')).toBe(false);
  });
});

describe('formatError', () => {
  it('handles non-Error thrown values in handleRunMessage', async () => {
    const context = createWorkflowRunnerContext();

    async function* nonErrorThrow() {
      throw 'string-error';
    }

    const result = await handleRunMessage(
      context,
      { workflowId: 'wf-non-error', workflowType: 'non-error', input: null },
      () => nonErrorThrow,
    );

    expect(result.type).toBe('failed');
    expect((result as { error: string }).error).toBe('string-error');
  });

  it('handles non-Error thrown values in handleResumeMessage', async () => {
    const context = createWorkflowRunnerContext();

    const operationRequest: OperationRequest = {
      id: 'op-1',
      workflowId: 'wf-non-error-resume',
      kind: 'activity',
      queue: 'default',
      attempt: 1,
      retryPolicy: {
        maxAttempts: 3,
        initialBackoff: 1000,
        backoffMultiplier: 2,
        maxBackoff: 30_000,
      },
      scheduledAt: Date.now(),
    };

    async function* nonErrorResumeThrow() {
      yield operationRequest;
      throw 42;
    }

    await handleRunMessage(
      context,
      { workflowId: 'wf-non-error-resume', workflowType: 'non-error-resume', input: null },
      () => nonErrorResumeThrow,
    );

    const result = await handleResumeMessage(context, {
      workflowId: 'wf-non-error-resume',
      result: 'trigger',
    });

    expect(result.type).toBe('failed');
    expect((result as { error: string }).error).toBe('42');
  });
});
