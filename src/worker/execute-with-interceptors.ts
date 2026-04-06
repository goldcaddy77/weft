/**
 * Shared utility for executing activities through an optional interceptor chain.
 * Used by both RemoteWorker (WebSocket) and LongPollWorker (HTTP).
 */

import type { ActivityInterceptor } from '../core/interceptor.ts';
import { composeActivityInterceptors } from '../core/interceptor.ts';

export interface TaskInfo {
  activityName: string;
  operationId: string;
  attempt?: number;
  input: unknown;
  headers?: Record<string, string>;
}

export interface ComposedInterceptor {
  execute: ReturnType<typeof composeActivityInterceptors>['execute'];
}

/**
 * Pre-compose interceptors once (at construction time) so the chain
 * is not rebuilt on every task execution.
 */
export function buildComposedInterceptor(
  interceptors: ActivityInterceptor[] | undefined,
): ComposedInterceptor | null {
  if (!interceptors || interceptors.length === 0) return null;
  return composeActivityInterceptors(interceptors);
}

/**
 * Execute an activity function, optionally wrapped by a pre-composed interceptor chain.
 * Provides a consistent AbortSignal and headers Map to the interception context.
 */
export async function executeWithInterceptors(
  activityFunction: (input: unknown, context?: { signal: AbortSignal }) => Promise<unknown>,
  task: TaskInfo,
  composed: ComposedInterceptor | null,
  signal?: AbortSignal,
): Promise<unknown> {
  if (!composed) {
    return activityFunction(task.input, signal ? { signal } : undefined);
  }

  const headers = new Map<string, string>(Object.entries(task.headers ?? {}));
  return composed.execute(
    {
      activityName: task.activityName,
      operationId: task.operationId,
      attempt: task.attempt ?? 1,
      input: task.input,
      headers,
      ...(signal && { signal }),
    },
    async (interception) => {
      return activityFunction(interception.input, signal ? { signal } : undefined);
    },
  );
}
