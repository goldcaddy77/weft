import { describe, expect, it } from 'bun:test';

import { createCheckpoint } from '../checkpoint.ts';
import type { EngineInternals } from './internals.ts';
import {
  feedOperationResult,
  getComposedActivityInterceptor,
  swallowPromiseRejection,
} from './strategy-helpers.ts';

describe('strategy helpers', () => {
  it('returns the cached composed activity interceptor when already computed', () => {
    const internals = {
      interceptors: [{}],
      composedActivityInterceptor: null,
    } as EngineInternals;

    expect(getComposedActivityInterceptor(internals)).toBeNull();
  });

  it('treats an absent promise as a no-op rejection sink', async () => {
    await expect(swallowPromiseRejection(undefined)).resolves.toBeUndefined();
  });

  it('resumes worker strategy execution with the latest checkpoint bytes', () => {
    const resumed: unknown[] = [];
    const internals = {
      checkpoints: new Map([
        ['workflow-worker-result', createCheckpoint('workflow-worker-result', '1', 1_000)],
      ]),
      inlineStrategy: null,
      strategy: {
        resumeWorkflow: (message: unknown) => {
          resumed.push(message);
        },
      },
    } as EngineInternals;

    feedOperationResult(internals, 'workflow-worker-result', {
      status: 'completed',
      value: 'done',
    });

    expect(resumed).toEqual([
      expect.objectContaining({
        operationResult: { status: 'completed', value: 'done' },
        workflowId: 'workflow-worker-result',
      }),
    ]);
  });
});
