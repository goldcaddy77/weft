import { primeParallelOperations } from './child-workflow-pipe.ts';
import type { Context } from './index.ts';
import type { ContextInternals } from './internals.ts';
import type { ContextOperationRequest } from './operation-request.ts';
import { captureCallerStack } from './validation.ts';

type ParallelOperationCacheEntry<TResult> = {
  __weftParallelOperationCache: true;
  result: TResult;
  subOperationCount: number;
};

function isParallelOperationCacheEntry<TResult>(
  value: unknown,
): value is ParallelOperationCacheEntry<TResult> {
  return (
    value !== null &&
    typeof value === 'object' &&
    '__weftParallelOperationCache' in value &&
    value['__weftParallelOperationCache'] === true &&
    'subOperationCount' in value &&
    typeof value['subOperationCount'] === 'number' &&
    Number.isSafeInteger(value['subOperationCount']) &&
    value['subOperationCount'] >= 0 &&
    'result' in value
  );
}

function createParallelOperationCacheEntry<TResult>(
  result: TResult,
  subOperationCount: number,
): ParallelOperationCacheEntry<TResult> {
  return {
    __weftParallelOperationCache: true,
    result,
    subOperationCount,
  };
}

export function* all(
  context: Context,
  internals: ContextInternals,
  operations: Generator<ContextOperationRequest, unknown, unknown>[],
): Generator<ContextOperationRequest, unknown[], unknown> {
  const step = internals.stepIndex++;

  if (internals.accumulatedResults?.has(step)) {
    const cached = internals.accumulatedResults.get(step);
    if (isParallelOperationCacheEntry<unknown[]>(cached)) {
      internals.stepIndex += cached.subOperationCount;
      return cached.result;
    }

    return cached as unknown[];
  }

  const subOperations = primeParallelOperations(operations);
  const operationId = crypto.randomUUID();
  const callerStack = captureCallerStack();
  const result = yield {
    type: 'parallel',
    operationId,
    operations: subOperations,
    callerStack,
  };

  context.accumulatedResults.set(
    step,
    createParallelOperationCacheEntry(result as unknown[], subOperations.length),
  );
  return result as unknown[];
}

export function* race(
  context: Context,
  internals: ContextInternals,
  operations: Generator<ContextOperationRequest, unknown, unknown>[],
): Generator<ContextOperationRequest, unknown, unknown> {
  const step = internals.stepIndex++;

  if (internals.accumulatedResults?.has(step)) {
    const cached = internals.accumulatedResults.get(step);
    if (isParallelOperationCacheEntry(cached)) {
      internals.stepIndex += cached.subOperationCount;
      return cached.result;
    }

    return cached;
  }

  const subOperations = primeParallelOperations(operations);
  const operationId = crypto.randomUUID();
  const callerStack = captureCallerStack();
  const result = yield {
    type: 'race',
    operationId,
    operations: subOperations,
    callerStack,
  };

  context.accumulatedResults.set(
    step,
    createParallelOperationCacheEntry(result, subOperations.length),
  );
  return result;
}

export function* memo<T>(
  context: Context,
  internals: ContextInternals,
  key: string,
  fn: () => T | Promise<T>,
): Generator<ContextOperationRequest, T, unknown> {
  const step = internals.stepIndex++;

  if (internals.memoCache?.has(key)) {
    return internals.memoCache.get(key) as T;
  }

  if (internals.accumulatedResults?.has(step)) {
    const cached = internals.accumulatedResults.get(step) as T;
    internals.memoCache ??= new Map();
    internals.memoCache.set(key, cached);
    return cached;
  }

  const operationId = crypto.randomUUID();
  const callerStack = captureCallerStack();
  const result = yield {
    type: 'memo',
    operationId,
    key,
    fn,
    callerStack,
  };

  internals.memoCache ??= new Map();
  internals.memoCache.set(key, result);
  context.accumulatedResults.set(step, result);
  return result as T;
}

export function* runAll<T extends Record<string, [Function, ...unknown[]]>>(
  context: Context,
  internals: ContextInternals,
  branches: T,
): Generator<ContextOperationRequest, Record<keyof T, unknown>, unknown> {
  const step = internals.stepIndex++;

  if (internals.accumulatedResults?.has(step)) {
    return internals.accumulatedResults.get(step) as Record<keyof T, unknown>;
  }

  if (internals.explainMode) {
    const branchNames = Object.keys(branches).join(', ');
    console.log(`[weft] ctx.runAll({ ${branchNames} })`);
    console.log(`  → Creating checkpoint at step ${step}`);
    console.log(`  → Running ${Object.keys(branches).length} named branches in parallel`);
  }

  const operationId = crypto.randomUUID();
  const callerStack = captureCallerStack();
  const result = yield {
    type: 'run-all' as const,
    operationId,
    branches,
    callerStack,
  };

  context.accumulatedResults.set(step, result);
  return result as Record<keyof T, unknown>;
}
