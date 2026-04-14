import { parseDuration } from './scheduler.ts';
import type { Duration } from './types.ts';
import { assertValidWorkflowId } from './workflow-identifiers.ts';

const EXCLUSIVE_START_WORKFLOW_OPTIONS_ERROR = 'Provide only one of startAt or startAfter';

export class StartWorkflowValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StartWorkflowValidationError';
  }
}

export function assertExclusiveStartWorkflowOptions(startAt: unknown, startAfter: unknown): void {
  if (startAt !== undefined && startAfter !== undefined) {
    throw new StartWorkflowValidationError(EXCLUSIVE_START_WORKFLOW_OPTIONS_ERROR);
  }
}

export function coerceStartWorkflowId(value: unknown, fieldName: string): string {
  if (typeof value !== 'string') {
    throw new StartWorkflowValidationError(`${fieldName} must be a string`);
  }

  try {
    assertValidWorkflowId(value, fieldName);
    return value;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new StartWorkflowValidationError(message);
  }
}

export function coerceStartWorkflowTimestamp(value: unknown, fieldName: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new StartWorkflowValidationError(
      `${fieldName} must be a non-negative integer millisecond timestamp`,
    );
  }

  return value;
}

export function parseStartWorkflowDuration(duration: Duration, fieldName: string): number {
  try {
    return parseDuration(duration);
  } catch {
    throw new StartWorkflowValidationError(
      `${fieldName} must be a finite, non-negative number or a valid duration string`,
    );
  }
}

export function coerceStartWorkflowDuration(value: unknown, fieldName: string): Duration {
  if (typeof value !== 'number' && typeof value !== 'string') {
    throw new StartWorkflowValidationError(
      `${fieldName} must be a finite, non-negative number or valid duration string`,
    );
  }

  parseStartWorkflowDuration(value, fieldName);
  return value;
}
