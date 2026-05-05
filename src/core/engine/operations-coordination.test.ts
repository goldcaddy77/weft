import { describe, expect, it } from 'bun:test';

import type { ContextOperationRequest } from '../context.ts';
import type { EngineInternals } from './internals.ts';
import { processParallelOperation, processRunAllOperation } from './operations-coordination.ts';

function createWorkerModeInternals(): EngineInternals {
  return { inlineStrategy: null } as unknown as EngineInternals;
}

describe('partial-failure preservation worker-mode boundary', () => {
  it('rejects ctx.all partial preservation when worker mode cannot persist fulfilled slots', async () => {
    const operation: Extract<ContextOperationRequest, { type: 'parallel' }> = {
      type: 'parallel',
      operationId: 'parallel:0',
      step: 0,
      operations: [
        {
          type: 'activity',
          operationId: 'parallel:0:0',
          activityName: 'ok',
          fn: async () => 'ok',
          input: undefined,
        },
        {
          type: 'activity',
          operationId: 'parallel:0:1',
          activityName: 'fail',
          fn: async () => {
            throw new Error('boom');
          },
          input: undefined,
        },
      ],
    };

    let captured: unknown;
    await processParallelOperation(createWorkerModeInternals(), 'wf-worker-all', operation, {
      executeSubOperation: async (_workflowId, subOperation) => {
        if (subOperation.type !== 'activity') throw new Error('unexpected operation');
        if (subOperation.fn === undefined) throw new Error('missing activity function');
        return subOperation.fn(subOperation.input);
      },
      runOperationWithResult: async (_workflowId, _operation, execute) => {
        try {
          await execute();
        } catch (error) {
          captured = error;
        }
      },
    });

    expect(captured).toBeInstanceOf(Error);
    expect((captured as Error).message).toContain(
      'ctx.all partial-failure preservation is not supported in worker execution mode',
    );
  });

  it('rejects ctx.runAll partial preservation when worker mode cannot persist fulfilled slots', async () => {
    const operation: Extract<ContextOperationRequest, { type: 'run-all' }> = {
      type: 'run-all',
      operationId: 'run-all:0',
      step: 0,
      branches: {
        ok: [async () => 'ok'],
        fail: [
          async () => {
            throw new Error('boom');
          },
        ],
      },
    };

    let captured: unknown;
    await processRunAllOperation(createWorkerModeInternals(), 'wf-worker-run-all', operation, {
      runOperationWithResult: async (_workflowId, _operation, execute) => {
        try {
          await execute();
        } catch (error) {
          captured = error;
        }
      },
    });

    expect(captured).toBeInstanceOf(Error);
    expect((captured as Error).message).toContain(
      'ctx.runAll partial-failure preservation is not supported in worker execution mode',
    );
  });
});
