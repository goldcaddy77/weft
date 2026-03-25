// ---------------------------------------------------------------------------
// Activity execution request / result types
// ---------------------------------------------------------------------------

export interface ActivityExecutionRequest {
  operationId: string;
  activityName: string;
  input: unknown;
  attempt: number;
}

export interface ActivityExecutionResult {
  operationId: string;
  status: 'completed' | 'failed';
  value?: unknown;
  error?: string;
}

// ---------------------------------------------------------------------------
// Execute an activity function with error handling and abort support
// ---------------------------------------------------------------------------

export async function executeActivity(
  request: ActivityExecutionRequest,
  activityFunction: (...arguments_: unknown[]) => unknown,
  signal?: AbortSignal,
): Promise<ActivityExecutionResult> {
  if (signal?.aborted) {
    return {
      operationId: request.operationId,
      status: 'failed',
      error: `Activity "${request.activityName}" aborted before execution`,
    };
  }

  try {
    const result = await activityFunction(request.input);

    return {
      operationId: request.operationId,
      status: 'completed',
      value: result,
    };
  } catch (error) {
    return {
      operationId: request.operationId,
      status: 'failed',
      error: `Activity "${request.activityName}" failed (attempt ${request.attempt}): ${formatError(error)}`,
    };
  }
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function formatError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}
