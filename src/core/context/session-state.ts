import {
  assertValidSessionStateKey,
  cloneSessionStateStore,
  cloneSessionStateValue,
  createSessionStateStore,
  hasSessionStateKey,
  SESSION_STATE_LOCAL_KEY,
  validateSessionStateStore,
} from '../session-state.ts';
import type { ActivityCallOptions, WorkflowSessionState } from '../types.ts';
import type { Context } from './index.ts';
import type { ContextInternals } from './internals.ts';
import type { ContextOperationRequest } from './operation-request.ts';

const EMPTY_CHECKPOINT_LOCALS = Object.freeze({}) as Record<string, unknown>;

const ACTIVITY_CALL_OPTION_KEYS = new Set<string>([
  'timeout',
  'queue',
  'retry',
  'idempotencyKey',
  'sticky',
  'visibilityTimeout',
]);

const DISCRIMINATOR_KEYS = new Set<string>([
  'queue',
  'retry',
  'idempotencyKey',
  'sticky',
  'visibilityTimeout',
]);

/** Detect whether a value is an {@link ActivityCallOptions} object. */
export function isActivityCallOptions(value: unknown): value is ActivityCallOptions {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const keys = Object.keys(value as Record<string, unknown>);
  if (keys.length === 0) return false;
  for (const key of keys) {
    if (!ACTIVITY_CALL_OPTION_KEYS.has(key)) {
      return false;
    }
  }
  for (const key of keys) {
    if (DISCRIMINATOR_KEYS.has(key)) {
      return true;
    }
  }
  return false;
}

export function createCheckpointLocals(
  sessionStateStore: Record<string, unknown> | undefined,
  existingLocals: Record<string, unknown> | undefined,
): Record<string, unknown> {
  const localEntries =
    existingLocals === undefined
      ? []
      : Object.entries(existingLocals).filter(([key]) => key !== SESSION_STATE_LOCAL_KEY);

  if (sessionStateStore === undefined) {
    if (localEntries.length === 0) {
      return EMPTY_CHECKPOINT_LOCALS;
    }

    return Object.fromEntries(localEntries);
  }

  return {
    ...Object.fromEntries(localEntries),
    [SESSION_STATE_LOCAL_KEY]: sessionStateStore,
  };
}

export function commitSessionStateStore(
  internals: ContextInternals,
  sessionStateStore: Record<string, unknown> | undefined,
): void {
  internals.sessionState = sessionStateStore;
  internals.checkpointLocals = createCheckpointLocals(
    sessionStateStore,
    internals.checkpointLocals,
  );
}

export function getSessionStateValue<T>(
  internals: ContextInternals,
  key: string,
  initialValue?: T,
): T | undefined {
  assertValidSessionStateKey(key);

  if (internals.sessionState && hasSessionStateKey(internals.sessionState, key)) {
    return cloneSessionStateValue(internals.sessionState[key] as T);
  }

  return initialValue === undefined ? undefined : cloneSessionStateValue(initialValue);
}

export function setSessionStateValue<T>(internals: ContextInternals, key: string, value: T): T {
  assertValidSessionStateKey(key);
  const candidate = cloneSessionStateStore(internals.sessionState) ?? createSessionStateStore();
  candidate[key] = cloneSessionStateValue(value) as unknown;
  validateSessionStateStore(candidate);
  commitSessionStateStore(internals, candidate);
  return cloneSessionStateValue(candidate[key] as T);
}

export function updateSessionStateValue<T>(
  internals: ContextInternals,
  key: string,
  initialValue: T | undefined,
  updater: (current: T | undefined) => T,
): T {
  return setSessionStateValue(
    internals,
    key,
    updater(getSessionStateValue(internals, key, initialValue)),
  );
}

export function clearSessionStateValue(internals: ContextInternals, key: string): void {
  assertValidSessionStateKey(key);

  if (!internals.sessionState || !hasSessionStateKey(internals.sessionState, key)) {
    return;
  }

  const candidate = cloneSessionStateStore(internals.sessionState);
  if (!candidate) {
    return;
  }

  delete candidate[key];
  commitSessionStateStore(internals, Object.keys(candidate).length === 0 ? undefined : candidate);
}

export function mergeSessionStateRunOptions(rest: unknown[]): unknown[] {
  if (rest.length > 0 && isActivityCallOptions(rest[rest.length - 1])) {
    const options = rest[rest.length - 1] as ActivityCallOptions;
    return [...rest.slice(0, -1), { ...options, sticky: true }];
  }

  return [...rest, { sticky: true }];
}

export function executeSessionStateOperation<TResult>(
  internals: ContextInternals,
  apply: () => TResult,
): TResult {
  const step = internals.stepIndex++;

  if (internals.accumulatedResults?.has(step)) {
    return internals.accumulatedResults.get(step) as TResult;
  }

  const result = apply();
  internals.accumulatedResults ??= new Map();
  internals.accumulatedResults.set(step, result);
  return result;
}

export function sessionState<T>(
  context: Context,
  internals: ContextInternals,
  key: string,
  initialValue?: T,
): WorkflowSessionState<T> {
  const sessionStateInitialValue =
    initialValue === undefined ? undefined : cloneSessionStateValue(initialValue);
  const get = (): T | undefined =>
    executeSessionStateOperation(internals, () =>
      getSessionStateValue(internals, key, sessionStateInitialValue),
    );
  const set = (value: T): T =>
    executeSessionStateOperation(internals, () => setSessionStateValue(internals, key, value));
  const update = (updater: (current: T | undefined) => T): T =>
    executeSessionStateOperation(internals, () =>
      updateSessionStateValue(internals, key, sessionStateInitialValue, updater),
    );
  const clear = (): void => {
    executeSessionStateOperation(internals, () => {
      clearSessionStateValue(internals, key);
      return undefined;
    });
  };
  const run = <TResult>(
    fn: (...args: unknown[]) => Promise<TResult> | TResult,
    ...rest: unknown[]
  ): Generator<ContextOperationRequest, TResult, unknown> =>
    context.run(fn, ...mergeSessionStateRunOptions(rest));

  return {
    get,
    set,
    update,
    clear,
    run,
  };
}
