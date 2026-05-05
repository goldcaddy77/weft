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

/** Create a finalizer callback that evicts only the stale handle entry that was actually finalized. */
export function createHandleCacheFinalizer<TValue extends object>(
  handleCache: Map<
    string,
    {
      ref: Pick<WeakRef<TValue>, 'deref'>;
    }
  >,
): (workflowId: string) => void {
  return (workflowId: string) => {
    const entry = handleCache.get(workflowId);
    if (!entry || entry.ref.deref() !== undefined) return;
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

/**
 * Settled outcome for a single `ctx.runAll` branch. Returned by
 * `executeRunAllBranchesSettled` so callers can record partial-failure
 * state in the parent operation's cache entry before propagating the
 * first rejection.
 */
export type RunAllBranchOutcome =
  | { status: 'fulfilled'; name: string; value: unknown }
  | { status: 'rejected'; name: string; reason: unknown };

/**
 * Result of `executeRunAllBranchesSettled`. `firstError` carries the
 * original rejection reason captured by settlement timing (matching
 * native `Promise.all` behavior — whichever branch rejects first at
 * runtime, not whichever appears first in branch insertion order).
 * `hasFirstError` distinguishes "no rejection" from "rejected with
 * `undefined`" (a workflow that threw `undefined` explicitly).
 */
export type RunAllSettledResult = {
  outcomes: RunAllBranchOutcome[];
  hasFirstError: boolean;
  firstError: unknown;
};

/**
 * Execute every `ctx.runAll()` branch and return per-branch settled
 * outcomes plus the first rejection captured by settlement timing.
 * Never rejects: callers inspect the result and decide how to surface
 * failure. Used by the top-level run-all dispatch path so fulfilled
 * branches can be persisted before any rejection propagates.
 */
export async function executeRunAllBranchesSettled(
  branches: Record<string, [fn: Function, ...args: unknown[]]>,
  callActivity: (fn: Function, args: unknown[]) => unknown,
): Promise<RunAllSettledResult> {
  const entries = Object.entries(branches);
  let hasFirstError = false;
  let firstError: unknown = undefined;
  const outcomes = await Promise.all(
    entries.map(async ([name, [fn, ...args]]): Promise<RunAllBranchOutcome> => {
      try {
        const value = await callActivity(fn, args);
        return { status: 'fulfilled', name, value };
      } catch (error) {
        // Capture the FIRST rejection by settlement timing — the
        // first branch to actually reject wins, not the first branch
        // in insertion order.
        if (!hasFirstError) {
          hasFirstError = true;
          firstError = error;
        }
        return { status: 'rejected', name, reason: error };
      }
    }),
  );
  return { outcomes, hasFirstError, firstError };
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
