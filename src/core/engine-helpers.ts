import type { Storage as WeftStorage } from '../storage/interface.ts';
import { KEYS } from '../storage/interface.ts';
import type { AgentInterception } from './interceptor.ts';

/** Apply callback handlers provided by an agent interceptor to the active interception. */
export function applyAgentInterceptorCallbacks(
  target: AgentInterception,
  source: AgentInterception,
): void {
  if (source.onTurnStarted) target.onTurnStarted = source.onTurnStarted;
  if (source.onTurnCompleted) target.onTurnCompleted = source.onTurnCompleted;
  if (source.onToolCalled) target.onToolCalled = source.onToolCalled;
  if (source.onToolReturned) target.onToolReturned = source.onToolReturned;
}

/** Build a cleanup reporter that preserves the workflow identifier for downstream error handling. */
export function createCleanupErrorReporter(
  onCleanupError: (source: string, error: unknown, workflowId: string) => void,
  workflowId: string,
): (source: string, error: unknown, _ignoredWorkflowId: string) => void {
  return (source: string, error: unknown) => {
    onCleanupError(source, error, workflowId);
  };
}

/** Create a finalizer callback that removes stale workflow handles from a cache map. */
export function createHandleCacheFinalizer<TValue>(
  handleCache: Map<string, TValue>,
): (workflowId: string) => void {
  return (workflowId: string) => {
    handleCache.delete(workflowId);
  };
}

/** Create the periodic update-response cleanup callback used by the engine interval. */
export function createExpiredResponseCleanupTick(
  updateCoordinator: { cleanupExpiredResponses(): Promise<unknown> },
  onCleanupError: (source: string, error: unknown) => void,
): () => void {
  return () => {
    updateCoordinator.cleanupExpiredResponses().catch((error: unknown) => {
      onCleanupError('cleanupExpiredResponses', error);
    });
  };
}

/** Delete partially written stream chunks and surface any cleanup failure through the callback. */
export async function cleanupPartialStreamChunks(
  storage: WeftStorage,
  workflowId: string,
  key: string,
  writtenKeys: string[],
  onCleanupError: (source: string, error: unknown, workflowId: string) => void,
): Promise<void> {
  if (writtenKeys.length === 0) {
    return;
  }

  const deleteOperations = [
    ...writtenKeys.map((writtenKey) => ({ type: 'delete' as const, key: writtenKey })),
    { type: 'delete' as const, key: KEYS.streamMetadata(workflowId, key) },
  ];

  await storage.batch(deleteOperations).catch((deleteError: unknown) => {
    onCleanupError('cleanupPartialStreamChunks', deleteError, workflowId);
  });
}

/** Execute the `ctx.runAll()` branches and return a name-keyed result record. */
export async function executeRunAllBranches(
  branches: Record<string, [fn: Function, ...args: unknown[]]>,
  callActivity: (fn: Function, args: unknown[]) => unknown,
): Promise<Record<string, unknown>> {
  const results: Record<string, unknown> = {};
  const entries = Object.entries(branches);
  await Promise.all(
    entries.map(async ([name, [fn, ...args]]) => {
      results[name] = await callActivity(fn, args);
    }),
  );
  return results;
}

/** Create the generator function passed through the agent interceptor chain. */
export function createAgentInterceptorExecute(
  activeInterception: AgentInterception,
): (ctx: AgentInterception) => Generator<unknown, undefined, unknown> {
  return function* execute(ctx: AgentInterception): Generator<unknown, undefined, unknown> {
    applyAgentInterceptorCallbacks(activeInterception, ctx);
    yield;
    return undefined;
  };
}
