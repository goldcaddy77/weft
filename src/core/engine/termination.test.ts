import { describe, expect, it, mock } from 'bun:test';

import { KEYS } from '../../storage/interface.ts';
import { MemoryStorage } from '../../storage/memory.ts';
import { sleepForTesting } from '../../testing/fake-timers.ts';
import { Engine } from '../engine.ts';
import type { WorkflowContext } from '../types.ts';
import type { EngineInternals } from './internals.ts';
import { getInternals } from './internals.ts';
import {
  commitWorkflowStateOperations,
  loadWorkflowState,
  runSerializedWorkflowStateWrite,
} from './storage-io.ts';
import {
  cleanupWaiters,
  completeWorkflow,
  failWorkflow,
  type TerminationCallbacks,
} from './termination.ts';

async function flush(): Promise<void> {
  await sleepForTesting(10);
}

function createTerminationCallbacks(
  overrides: Partial<TerminationCallbacks> = {},
): TerminationCallbacks {
  return {
    dispatchEvent: () => {},
    forwardEventToHandle: () => {},
    broadcast: () => {},
    swallowPromiseRejection: async (promise) => {
      await promise?.catch(() => undefined);
    },
    handleCleanupError: () => {},
    handleScheduledWorkflowTerminal: async () => {},
    loadWorkflowState: async () => null,
    runSerializedWorkflowStateWrite: async (_workflowId, writeOperation) => await writeOperation(),
    commitWorkflowStateOperations: async () => {},
    cleanupReviews: async () => {},
    ...overrides,
  };
}

describe('termination helpers', () => {
  it('cleanupWaiters removes single-key signal, update, and review waiters', () => {
    const signalWaiters = new Map<string, () => void>([['wf:signal', () => {}]]);
    const updateWaiters = new Map<string, (payload: unknown) => void>([['wf:update', () => {}]]);
    const reviewWaiters = new Map<string, (decision: unknown) => void>([['wf:review', () => {}]]);
    const internals = {
      signalWaiters,
      signalWaitersByWorkflow: new Map<string, string>([['wf-cleanup', 'wf:signal']]),
      updateWaiters,
      updateWaitersByWorkflow: new Map<string, string>([['wf-cleanup', 'wf:update']]),
      reviewWaiters,
      reviewWaitersByWorkflow: new Map<string, string>([['wf-cleanup', 'wf:review']]),
      sleepResolvers: new Map<string, () => void>(),
      sleepResolversByWorkflow: new Map<string, Set<string>>(),
      workflowReviewIds: new Map<string, Set<string>>(),
      reviewEscalationHandlers: new Map<
        string,
        (entry: { id: string; workflowId: string }) => Promise<boolean>
      >(),
      reviewTimerIds: new Map<string, string[]>(),
      workflowNestingDepths: new Map<string, number>([['wf-cleanup', 1]]),
      workflowHeaders: new Map<string, Map<string, string>>([
        ['wf-cleanup', new Map([['traceparent', 'value']])],
      ]),
      scheduler: {
        cancel: async () => {},
      },
    } as unknown as EngineInternals;

    cleanupWaiters(internals, 'wf-cleanup', createTerminationCallbacks());

    expect(signalWaiters.has('wf:signal')).toBe(false);
    expect(updateWaiters.has('wf:update')).toBe(false);
    expect(reviewWaiters.has('wf:review')).toBe(false);
    expect(internals.signalWaitersByWorkflow.has('wf-cleanup')).toBe(false);
    expect(internals.updateWaitersByWorkflow.has('wf-cleanup')).toBe(false);
    expect(internals.reviewWaitersByWorkflow.has('wf-cleanup')).toBe(false);
    expect(internals.workflowNestingDepths.has('wf-cleanup')).toBe(false);
    expect(internals.workflowHeaders.has('wf-cleanup')).toBe(false);
  });

  it('completeWorkflow falls back to stored search attributes when the checkpoint cache is missing', async () => {
    const storage = new MemoryStorage();
    const engine = new Engine({ storage });

    engine.register('completion-attribute-fallback', {
      handler: async function* (ctx: WorkflowContext) {
        yield* ctx.waitForSignal('finish');
        return 'done';
      },
      searchAttributes: {
        customerId: { type: 'string' },
      },
    });

    const handle = await engine.start('completion-attribute-fallback', null, {
      id: 'completion-attribute-fallback-id',
      searchAttributes: { customerId: 'alpha' },
    });
    await flush();

    const internals = getInternals(engine);
    internals.checkpoints.delete(handle.id);

    const callbacks = createTerminationCallbacks({
      loadWorkflowState: async (workflowId) => await loadWorkflowState(internals, workflowId),
      runSerializedWorkflowStateWrite: async (workflowId, writeOperation) =>
        await runSerializedWorkflowStateWrite(internals, workflowId, writeOperation),
      commitWorkflowStateOperations: async (state, operations, options) =>
        await commitWorkflowStateOperations(internals, state, operations, options),
    });

    await completeWorkflow(internals, handle.id, 'done', callbacks);

    const persistedState = await loadWorkflowState(internals, handle.id);
    expect(persistedState?.status).toBe('completed');
    expect(await storage.get(KEYS.attribute(handle.id))).toBeNull();

    engine[Symbol.dispose]();
  });

  it('failWorkflow returns quietly when the workflow is already missing', async () => {
    const engine = new Engine({ storage: new MemoryStorage() });
    const internals = getInternals(engine);

    const dispatchEvent = mock(() => {});
    await failWorkflow(
      internals,
      'missing-workflow',
      new Error('boom'),
      createTerminationCallbacks({ dispatchEvent }),
    );

    expect(dispatchEvent).not.toHaveBeenCalled();

    engine[Symbol.dispose]();
  });

  it('failWorkflow still rejects the pending result when synchronous cleanup throws', async () => {
    const storage = new MemoryStorage();
    const engine = new Engine({ storage });

    engine.register('failure-cleanup-throw', async function* (ctx: WorkflowContext) {
      yield* ctx.waitForSignal('finish');
      return 'done';
    });

    const handle = await engine.start('failure-cleanup-throw', null, {
      id: 'failure-cleanup-throw-id',
    });
    await flush();

    const internals = getInternals(engine);
    const workflowError = new Error('workflow failed');
    const cleanupError = new Error('cleanup failed');
    const reject = mock((_reason: unknown) => {});

    internals.resultResolvers.set(handle.id, {
      promise: new Promise(() => {}),
      resolve: () => {},
      reject,
    });

    await expect(
      failWorkflow(
        internals,
        handle.id,
        workflowError,
        createTerminationCallbacks({
          cleanupReviews: async () => {
            throw cleanupError;
          },
        }),
      ),
    ).rejects.toBe(cleanupError);

    expect(reject).toHaveBeenCalledWith(workflowError);
    expect(internals.resultResolvers.has(handle.id)).toBe(false);

    const persistedState = await loadWorkflowState(internals, handle.id);
    expect(persistedState?.status).toBe('failed');

    engine[Symbol.dispose]();
  });
});
