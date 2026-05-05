import { serializeCheckpoint } from '../checkpoint.ts';
import type { ComposedActivityInterceptor, ComposedWorkflowInterceptor } from '../interceptor.ts';
import {
  composeActivityInterceptors,
  composeWorkflowInterceptors,
  splitInterceptors,
} from '../interceptor.ts';
import type { OperationOutcome } from '../types.ts';
import type { EngineInternals } from './internals.ts';

/**
 * Wrapper that carries a captured rejection reason alongside a presence
 * flag, so callers can distinguish "no reason captured" from "reason
 * captured and happens to be `undefined`" (a workflow that threw
 * `undefined` explicitly). Using a wrapper instead of `arguments.length`
 * avoids tripping the lint rule against `arguments`.
 */
export type CapturedRejectionReason = { value: unknown };

/**
 * Feed an operation outcome back to the strategy. For failures, callers
 * pass the original thrown reason via a `CapturedRejectionReason`
 * wrapper so the workflow throw boundary can rethrow it as-is —
 * matching `Promise.all`'s rethrow semantics for non-`Error` values
 * like strings or `undefined`. The string-form `outcome.error` is used
 * only for storage/timeline metadata. When the reason wasn't captured
 * (worker-strategy resume path), we fall back to constructing an Error
 * from the outcome message.
 */
export function feedOperationResult(
  internals: EngineInternals,
  workflowId: string,
  outcome: OperationOutcome,
  originalReason?: CapturedRejectionReason,
): void {
  if (internals.inlineStrategy) {
    if (outcome.status === 'completed') {
      internals.inlineStrategy.continueWorkflow(workflowId, outcome.value);
    } else {
      internals.inlineStrategy.throwIntoWorkflow(
        workflowId,
        originalReason !== undefined ? originalReason.value : new Error(outcome.error),
      );
    }
    return;
  }

  const checkpoint = internals.checkpoints.get(workflowId);
  const serialized = checkpoint ? serializeCheckpoint(checkpoint) : new ArrayBuffer(0);
  internals.strategy.resumeWorkflow({
    workflowId,
    checkpoint: serialized,
    operationResult: outcome,
  });
}

export async function swallowPromiseRejection(
  promise: Promise<unknown> | undefined,
): Promise<void> {
  if (!promise) {
    return;
  }

  try {
    await promise;
  } catch {
    // Best-effort cleanup and warmup operations intentionally ignore rejections.
  }
}

export function getComposedWorkflowInterceptor(
  internals: EngineInternals,
): ComposedWorkflowInterceptor | null {
  if (internals.interceptors.length === 0) return null;
  if (internals.composedWorkflowInterceptor) return internals.composedWorkflowInterceptor;
  const workflowSlice = splitInterceptors(internals.interceptors).workflow;
  if (workflowSlice.length === 0) return null;
  internals.composedWorkflowInterceptor = composeWorkflowInterceptors(workflowSlice);
  return internals.composedWorkflowInterceptor;
}

export function getComposedActivityInterceptor(
  internals: EngineInternals,
): ComposedActivityInterceptor | null {
  if (internals.interceptors.length === 0) return null;
  if (internals.composedActivityInterceptor) return internals.composedActivityInterceptor;
  const activitySlice = splitInterceptors(internals.interceptors).activity;
  if (activitySlice.length === 0) return null;
  internals.composedActivityInterceptor = composeActivityInterceptors(activitySlice);
  return internals.composedActivityInterceptor;
}
