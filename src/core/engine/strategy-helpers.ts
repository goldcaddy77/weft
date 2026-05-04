import { serializeCheckpoint } from '../checkpoint.ts';
import type { ComposedActivityInterceptor, ComposedWorkflowInterceptor } from '../interceptor.ts';
import {
  composeActivityInterceptors,
  composeWorkflowInterceptors,
  splitInterceptors,
} from '../interceptor.ts';
import type { OperationOutcome } from '../types.ts';
import type { EngineInternals } from './internals.ts';

export function feedOperationResult(
  internals: EngineInternals,
  workflowId: string,
  outcome: OperationOutcome,
  originalError?: Error,
): void {
  if (internals.inlineStrategy) {
    if (outcome.status === 'completed') {
      internals.inlineStrategy.continueWorkflow(workflowId, outcome.value);
    } else {
      internals.inlineStrategy.throwIntoWorkflow(
        workflowId,
        originalError ?? new Error(outcome.error),
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
