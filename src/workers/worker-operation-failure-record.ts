import type { FailureCategory, OperationOutcome } from '../core/types.ts';

const WORKER_OPERATION_FAILURE_MARKER = '__weftWorkerOperationFailure';
const WORKER_OPERATION_FAILURE_VERSION = 1;

export interface StoredWorkerOperationFailure {
  [WORKER_OPERATION_FAILURE_MARKER]: true;
  version: typeof WORKER_OPERATION_FAILURE_VERSION;
  outcome: Extract<OperationOutcome, { status: 'failed' }>;
}

export function createStoredWorkerOperationFailure(
  outcome: Extract<OperationOutcome, { status: 'failed' }>,
): StoredWorkerOperationFailure {
  return {
    [WORKER_OPERATION_FAILURE_MARKER]: true,
    version: WORKER_OPERATION_FAILURE_VERSION,
    outcome,
  };
}

export function isStoredWorkerOperationFailure(
  value: unknown,
): value is StoredWorkerOperationFailure {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    record[WORKER_OPERATION_FAILURE_MARKER] === true &&
    record['version'] === WORKER_OPERATION_FAILURE_VERSION &&
    isStoredWorkerFailedOutcome(record['outcome'])
  );
}

function isStoredWorkerFailedOutcome(
  value: unknown,
): value is Extract<OperationOutcome, { status: 'failed' }> {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Record<string, unknown>;
  if (record['status'] !== 'failed' || typeof record['error'] !== 'string') return false;
  if (record['errorName'] !== undefined && typeof record['errorName'] !== 'string') return false;
  if (record['failureCategory'] === undefined) return true;
  return isFailureCategory(record['failureCategory']);
}

function isFailureCategory(value: unknown): value is FailureCategory {
  switch (value) {
    case 'application':
    case 'cancellation':
    case 'resource':
    case 'system':
    case 'timeout':
      return true;
    default:
      return false;
  }
}
