/**
 * Inline activity lifecycle events.
 *
 * `executeActivity` runs an activity function for both inline and worker
 * dispatch, but historically nothing on that path dispatched the
 * `activity:started` / `activity:completed` / `activity:failed` events the
 * engine declares (`ActivityStartedEvent` and friends). The events existed —
 * the alert manager's `activity.p99_duration` rule even listens for
 * `activity:completed` — yet under inline execution (the default) they never
 * fired, so operators could observe workflow lifecycle but not per-activity
 * timing, retries, or failures. This module wraps one activity execution and
 * emits those events at the boundary, exactly once per attempt.
 *
 * An async deferral (`ctx.completeAsync()`, which throws `AsyncActivityDeferral`
 * to park the activity for out-of-band completion) is neither a completion nor
 * a failure: it emits `activity:started` here and `activity:async-pending` from
 * `registerPendingAsyncActivity`, and the eventual completion is reported by the
 * async-completion path — so it deliberately emits no `completed`/`failed`.
 */
import { ActivityCompletedEvent, ActivityFailedEvent, ActivityStartedEvent } from '../events.ts';
import { AsyncActivityDeferral } from './async-activity-completion.ts';
import type { EngineInternals } from './internals.ts';

/** The two identity fields an activity operation carries that the events need. */
export interface ObservedActivityOperation {
  readonly operationId: string;
  readonly activityName: string;
}

function toError(reason: unknown): Error {
  return reason instanceof Error ? reason : new Error(String(reason));
}

/**
 * Run `execute` for one activity attempt, dispatching `activity:started` before
 * it, then `activity:completed` (with wall-clock `duration` in ms) on success or
 * `activity:failed` (with the error and `attempt`) on a thrown error. Rethrows
 * every error unchanged so retry, timeout and deferral handling upstream are
 * unaffected.
 */
export async function observeActivityExecution<TResult>(
  internals: EngineInternals,
  workflowId: string,
  operation: ObservedActivityOperation,
  attempt: number,
  execute: () => Promise<TResult>,
): Promise<TResult> {
  const { operationId, activityName } = operation;
  internals.engine.dispatchEvent(
    new ActivityStartedEvent(operationId, workflowId, activityName, attempt),
  );
  const startedAt = Date.now();
  try {
    const result = await execute();
    internals.engine.dispatchEvent(
      new ActivityCompletedEvent(operationId, workflowId, activityName, Date.now() - startedAt),
    );
    return result;
  } catch (error) {
    if (!(error instanceof AsyncActivityDeferral)) {
      internals.engine.dispatchEvent(
        new ActivityFailedEvent(operationId, workflowId, activityName, toError(error), attempt),
      );
    }
    throw error;
  }
}
