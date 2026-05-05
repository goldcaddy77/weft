import type { WorkflowResultWaiter } from './engine-internal-types.ts';
import { WorkflowHandle } from './handles.ts';
import type { EngineInternals } from './internals.ts';
import { loadWorkflowResult, loadWorkflowState } from './storage-io.ts';

export function createWorkflowHandleWithResultPromise(
  internals: EngineInternals,
  workflowId: string,
): WorkflowHandle {
  const handle = new WorkflowHandle<unknown>(workflowId, internals.engine);
  cacheHandle(internals, workflowId, handle);
  return handle;
}

export function createWorkflowResultWaiter(
  internals: EngineInternals,
  workflowId: string,
): WorkflowResultWaiter {
  const { promise, resolve, reject } = Promise.withResolvers<unknown>();
  const waiter = { promise, resolve, reject };
  internals.resultResolvers.set(workflowId, waiter);
  void promise.catch(() => {});
  return waiter;
}

export function getWorkflowResultPromise(
  internals: EngineInternals,
  workflowId: string,
): Promise<unknown> {
  const existingWaiter = internals.resultResolvers.get(workflowId);
  if (existingWaiter) {
    return existingWaiter.promise;
  }

  const waiter = createWorkflowResultWaiter(internals, workflowId);
  void bootstrapWorkflowResultResolver(internals, workflowId, waiter);
  return waiter.promise;
}

// oxlint-disable-next-line complexity -- ID:core-engine-bootstrap-workflow-result-resolver-complexity
export async function bootstrapWorkflowResultResolver(
  internals: EngineInternals,
  workflowId: string,
  waiter: WorkflowResultWaiter,
): Promise<void> {
  try {
    const state = await loadWorkflowState(internals, workflowId);
    const currentWaiter = internals.resultResolvers.get(workflowId);
    if (currentWaiter !== undefined && currentWaiter !== waiter) {
      void currentWaiter.promise.then(waiter.resolve, waiter.reject);
      return;
    }

    if (!state) {
      internals.resultResolvers.delete(workflowId);
      waiter.reject(new Error(`Workflow "${workflowId}" not found in storage`));
      return;
    }

    if (state.status === 'running' || state.status === 'pending') {
      return;
    }

    try {
      const result = await loadWorkflowResult(internals, workflowId);
      if (internals.resultResolvers.get(workflowId) === waiter) {
        internals.resultResolvers.delete(workflowId);
      }
      waiter.resolve(result);
    } catch (error) {
      if (internals.resultResolvers.get(workflowId) === waiter) {
        internals.resultResolvers.delete(workflowId);
      }
      waiter.reject(error);
    }
  } catch (error) {
    if (internals.resultResolvers.get(workflowId) === waiter) {
      internals.resultResolvers.delete(workflowId);
    }
    waiter.reject(error);
  }
}

export function cacheHandle(
  internals: EngineInternals,
  workflowId: string,
  handle: WorkflowHandle,
): void {
  const existing = internals.handleCache.get(workflowId);
  if (existing) {
    internals.finalizationRegistry.unregister(existing.unregisterToken);
  }
  const unregisterToken = {};
  internals.handleCache.set(workflowId, {
    ref: new WeakRef(handle),
    unregisterToken,
  });
  internals.finalizationRegistry.register(handle, workflowId, unregisterToken);
}
