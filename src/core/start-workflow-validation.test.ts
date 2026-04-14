import { describe, expect, it } from 'bun:test';

import {
  assertExclusiveStartWorkflowOptions,
  coerceStartWorkflowDuration,
  coerceStartWorkflowId,
  coerceStartWorkflowTimestamp,
  parseStartWorkflowDuration,
  StartWorkflowValidationError,
} from './start-workflow-validation.ts';

function captureValidationError(action: () => void): StartWorkflowValidationError {
  try {
    action();
  } catch (error) {
    expect(error).toBeInstanceOf(StartWorkflowValidationError);
    return error as StartWorkflowValidationError;
  }

  throw new Error('Expected StartWorkflowValidationError');
}

describe('start workflow validation', () => {
  it('rejects providing both startAt and startAfter', () => {
    expect(() => assertExclusiveStartWorkflowOptions(1, '5s')).toThrow(
      new StartWorkflowValidationError('Provide only one of startAt or startAfter'),
    );
  });

  it('allows providing only one delayed-start option', () => {
    expect(() => assertExclusiveStartWorkflowOptions(1, undefined)).not.toThrow();
    expect(() => assertExclusiveStartWorkflowOptions(undefined, '5s')).not.toThrow();
  });

  it('returns a valid workflow id unchanged', () => {
    expect(coerceStartWorkflowId('workflow-123', 'options.id')).toBe('workflow-123');
  });

  it('rejects non-string workflow ids', () => {
    const error = captureValidationError(() => coerceStartWorkflowId(42, 'options.id'));

    expect(error).toEqual(new StartWorkflowValidationError('options.id must be a string'));
  });

  it('wraps invalid workflow ids in a start workflow validation error', () => {
    const error = captureValidationError(() => coerceStartWorkflowId('', 'options.id'));

    expect(error).toEqual(
      new StartWorkflowValidationError('options.id must not be an empty string'),
    );
  });

  it('returns valid millisecond timestamps unchanged', () => {
    expect(coerceStartWorkflowTimestamp(1_234, 'options.startAt')).toBe(1_234);
  });

  it('rejects timestamps that are negative or non-integer', () => {
    expect(() => coerceStartWorkflowTimestamp(-1, 'options.startAt')).toThrow(
      new StartWorkflowValidationError(
        'options.startAt must be a non-negative integer millisecond timestamp',
      ),
    );
    expect(() => coerceStartWorkflowTimestamp(1.5, 'options.startAt')).toThrow(
      new StartWorkflowValidationError(
        'options.startAt must be a non-negative integer millisecond timestamp',
      ),
    );
  });

  it('parses valid workflow durations', () => {
    expect(parseStartWorkflowDuration('5s', 'options.startAfter')).toBe(5_000);
    expect(parseStartWorkflowDuration(2_500, 'options.executionTimeout')).toBe(2_500);
  });

  it('wraps invalid workflow durations in a validation error', () => {
    expect(() => parseStartWorkflowDuration('later', 'options.startAfter')).toThrow(
      new StartWorkflowValidationError(
        'options.startAfter must be a finite, non-negative number or a valid duration string',
      ),
    );
  });

  it('returns a validated duration in its original representation', () => {
    expect(coerceStartWorkflowDuration('5s', 'options.startAfter')).toBe('5s');
    expect(coerceStartWorkflowDuration(2_500, 'options.executionTimeout')).toBe(2_500);
  });

  it('rejects duration values that are neither strings nor numbers', () => {
    const error = captureValidationError(() =>
      coerceStartWorkflowDuration(false, 'options.startAfter'),
    );

    expect(error).toEqual(
      new StartWorkflowValidationError(
        'options.startAfter must be a finite, non-negative number or valid duration string',
      ),
    );
  });
});
