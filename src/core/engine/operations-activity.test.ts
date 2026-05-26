import { describe, expect, it, mock } from 'bun:test';

import type { ContextOperationRequest } from '../context.ts';
import type { ActivityInterception } from '../interceptor.ts';
import {
  executeActivity,
  executeActivityOperationResult,
  getActivityFunctionWithMetadata,
  invokeWorkerActivity,
  resolveActivityFunction,
  type ActivityFunctionWithMetadata,
  type ActivityOperationCallbacks,
} from './operations-activity.ts';

function createActivityOperation(
  overrides: Partial<Extract<ContextOperationRequest, { type: 'activity' }>> = {},
): Extract<ContextOperationRequest, { type: 'activity' }> {
  return {
    type: 'activity',
    operationId: 'activity-operation',
    activityName: 'test-activity',
    input: 'payload',
    ...overrides,
  };
}

function createCallbacks(
  overrides: Partial<ActivityOperationCallbacks> = {},
): ActivityOperationCallbacks {
  return {
    getComposedActivityInterceptor: () => null,
    getComposedWorkflowInterceptor: () => null,
    runOperationWithResult: async (_workflowId, _operation, execute) => {
      await execute();
    },
    ...overrides,
  };
}

function createInternals(overrides: Record<string, unknown> = {}) {
  return {
    activityRegistriesByWorkflow: new Map(),
    activityRegistry: { resolve: () => undefined },
    heartbeatDetails: new Map(),
    options: { payloadSizePolicy: { maxBytes: null } },
    workflowTypeByWorkflowId: new Map(),
    ...overrides,
  };
}

describe('activity operation helpers', () => {
  it('resolves global activities for unknown workflow ids', () => {
    const activityFunction = () => 'global-result';
    const operation = createActivityOperation();

    const resolved = resolveActivityFunction(
      createInternals({
        activityRegistry: {
          resolve: (name: string) =>
            name === operation.activityName ? activityFunction : undefined,
        },
      }) as never,
      'missing-workflow',
      operation,
    );

    expect(resolved).toBe(activityFunction);
  });

  it('falls back to the operation function for metadata lookup', () => {
    const fallback = (() => 'fallback') as ActivityFunctionWithMetadata;
    const operation = createActivityOperation({ fn: fallback });

    expect(
      getActivityFunctionWithMetadata(createInternals() as never, 'workflow-id', operation),
    ).toBe(fallback);
  });

  it('returns undefined metadata when no registry or inline function matches', () => {
    expect(
      getActivityFunctionWithMetadata(
        createInternals() as never,
        'workflow-id',
        createActivityOperation(),
      ),
    ).toBeUndefined();
  });

  it('throws when worker activity execution is requested without a dispatcher', async () => {
    await expect(
      invokeWorkerActivity(createInternals() as never, 'op-1', 'missing-dispatcher', 'payload'),
    ).rejects.toThrow('No activity worker dispatcher available for "missing-dispatcher"');
  });

  it('copies activity-interceptor headers onto the operation before returning', async () => {
    const operation = createActivityOperation({
      fn: () => 'activity-result',
    });

    const result = await executeActivity(
      createInternals() as never,
      'workflow-id',
      operation,
      createCallbacks({
        getComposedActivityInterceptor: () => ({
          execute: async (interception, next) => {
            interception.headers.set('x-trace-id', 'activity');
            return next(interception);
          },
        }),
      }),
    );

    expect(result).toBe('activity-result');
    expect(operation.headers).toEqual([['x-trace-id', 'activity']]);
  });

  it('copies workflow-interceptor headers onto the operation before returning', async () => {
    const operation = createActivityOperation({
      fn: () => 'workflow-result',
    });

    const result = await executeActivity(
      createInternals() as never,
      'workflow-id',
      operation,
      createCallbacks({
        getComposedWorkflowInterceptor: () =>
          ({
            *activity(
              interception: ActivityInterception,
              next: (interception: ActivityInterception) => Generator<unknown, unknown, unknown>,
            ) {
              interception.headers.set('x-trace-id', 'workflow');
              return yield* next(interception);
            },
          }) as never,
      }),
    );

    expect(result).toBe('workflow-result');
    expect(operation.headers).toEqual([['x-trace-id', 'workflow']]);
  });

  it('records verification promises on speculative execution state', async () => {
    const verificationPromises: Promise<void>[] = [];
    const verify = mock(async () => true);
    const activityFunction = Object.assign(() => 'verified-result', { verify });
    const operation = createActivityOperation({ fn: activityFunction });

    const result = await executeActivityOperationResult(
      createInternals() as never,
      'workflow-id',
      operation,
      createCallbacks(),
      {
        recordCompensation: () => undefined,
        recordVerification: (verification: Promise<void>) => {
          verificationPromises.push(verification);
        },
      } as never,
    );

    expect(result).toBe('verified-result');
    expect(verificationPromises).toHaveLength(1);
    await expect(verificationPromises[0]).resolves.toBeUndefined();
    expect(verify).toHaveBeenCalledWith('verified-result');
  });

  it('awaits verification immediately when no speculative execution state is present', async () => {
    const verify = mock(async () => true);
    const activityFunction = Object.assign(() => 'verified-inline', { verify });
    const operation = createActivityOperation({ fn: activityFunction });

    await expect(
      executeActivityOperationResult(
        createInternals() as never,
        'workflow-id',
        operation,
        createCallbacks(),
      ),
    ).resolves.toBe('verified-inline');

    expect(verify).toHaveBeenCalledWith('verified-inline');
  });
});
