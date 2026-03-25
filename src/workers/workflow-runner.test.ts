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

    async function* inputWorkflow(input: unknown) {
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

    handleCancelMessage(context, { workflowId: 'wf-cancel' });

    expect(controller!.signal.aborted).toBe(true);
  });

  it('is a no-op for a non-existent workflow', () => {
    const context = createWorkflowRunnerContext();

    // Should not throw
    handleCancelMessage(context, { workflowId: 'wf-nonexistent' });
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

    handleCancelMessage(context, { workflowId: 'wf-cleanup' });

    expect(context.generators.has('wf-cleanup')).toBe(false);
    expect(context.abortControllers.has('wf-cleanup')).toBe(false);
  });
});
