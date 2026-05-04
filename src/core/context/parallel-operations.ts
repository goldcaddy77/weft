import { primeParallelOperations } from './child-workflow-pipe.ts';
import type { Context } from './index.ts';
import type { ContextInternals } from './internals.ts';
import type { ContextOperationRequest } from './operation-request.ts';
import { captureCallerStack } from './validation.ts';

/**
 * One slot in a {@link ParallelOperationCacheEntry}'s `branches` table.
 *
 * - `pending`: branch was dispatched but never observed to settle (e.g., the
 *   process crashed before its result was recorded). Re-dispatched on retry.
 * - `fulfilled`: branch completed successfully. Reused on retry; never re-runs.
 * - `rejected`: branch threw. Metadata only — never reused on retry; the
 *   branch re-dispatches just like a `pending` slot. The `reason` is a
 *   normalized `{ name, message }` because raw `Error` objects don't
 *   round-trip through MessagePack.
 * - `aborted`: reserved for `ctx.race` losers. Never produced by
 *   `ctx.all`/`ctx.runAll` because they don't cancel siblings on failure.
 */
export type ParallelBranchSlot =
  | { status: 'pending'; operationId: string }
  | { status: 'fulfilled'; value: unknown; operationId: string }
  | {
      status: 'rejected';
      reason: { name: string; message: string };
      operationId: string;
    }
  | { status: 'aborted'; operationId: string };

/**
 * Persistent record of a parallel operation's per-branch outcomes. Stored
 * in `accumulatedResults` at the parent operation's step. On retry, the
 * generator inspects this entry and lets fulfilled branches skip dispatch
 * while non-fulfilled branches re-execute.
 *
 * `formatVersion: 2` is the v2 shape — the only shape v2-aware engines
 * write or read.
 */
export type ParallelOperationCacheEntry = {
  __weftParallelOperationCache: true;
  formatVersion: 2;
  variant: 'all' | 'race' | 'run-all';
  branches: ParallelBranchSlot[];
  /** Ordered key list for `run-all`; absent for `all` and `race`. */
  branchNames?: string[];
  subOperationCount: number;
};

function isValidVariant(value: unknown): value is 'all' | 'race' | 'run-all' {
  return value === 'all' || value === 'race' || value === 'run-all';
}

function isValidSlotStatus(
  value: unknown,
): value is 'pending' | 'fulfilled' | 'rejected' | 'aborted' {
  return (
    value === 'pending' || value === 'fulfilled' || value === 'rejected' || value === 'aborted'
  );
}

function isValidRejectionReason(value: unknown): boolean {
  if (value === null || typeof value !== 'object') return false;
  const reason = value as Record<string, unknown>;
  return typeof reason['name'] === 'string' && typeof reason['message'] === 'string';
}

function isValidBranchSlot(value: unknown): boolean {
  if (value === null || typeof value !== 'object') return false;
  const slot = value as Record<string, unknown>;
  if (!isValidSlotStatus(slot['status'])) return false;
  if (typeof slot['operationId'] !== 'string') return false;
  if (slot['status'] === 'rejected' && !isValidRejectionReason(slot['reason'])) return false;
  return true;
}

function isValidBranchNames(value: unknown): boolean {
  if (value === undefined) return true;
  return Array.isArray(value) && value.every((name) => typeof name === 'string');
}

function isValidSubOperationCount(value: unknown): boolean {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function hasParallelOperationCacheMarker(value: unknown): boolean {
  return (
    value !== null &&
    typeof value === 'object' &&
    (value as Record<string, unknown>)['__weftParallelOperationCache'] === true
  );
}

function hasValidBranchTopology(
  variant: 'all' | 'race' | 'run-all',
  branches: unknown[],
  subOperationCount: number,
  branchNames: unknown,
): boolean {
  if (variant === 'race') {
    return branches.length <= subOperationCount;
  }
  if (branches.length !== subOperationCount) {
    return false;
  }
  if (variant === 'run-all') {
    return Array.isArray(branchNames) && branchNames.length === subOperationCount;
  }
  return branchNames === undefined;
}

/** Type guard for the v2 parallel-operation cache entry shape. */
export function isParallelOperationCacheEntry(
  value: unknown,
): value is ParallelOperationCacheEntry {
  if (value === null || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  if (record['__weftParallelOperationCache'] !== true) return false;
  if (record['formatVersion'] !== 2) return false;
  if (!isValidVariant(record['variant'])) return false;
  if (!Array.isArray(record['branches'])) return false;
  if (!isValidSubOperationCount(record['subOperationCount'])) return false;
  if (!isValidBranchNames(record['branchNames'])) return false;
  const subOperationCount = record['subOperationCount'] as number;
  if (
    !hasValidBranchTopology(
      record['variant'],
      record['branches'],
      subOperationCount,
      record['branchNames'],
    )
  ) {
    return false;
  }
  return record['branches'].every(isValidBranchSlot);
}

function assertValidParallelOperationCacheEntry(
  value: unknown,
): asserts value is ParallelOperationCacheEntry {
  if (hasParallelOperationCacheMarker(value) && !isParallelOperationCacheEntry(value)) {
    throw new BranchTopologyChangedError(
      'Parallel operation cache entry is malformed or incompatible with this engine version.',
    );
  }
}

/** Build a fresh v2 cache entry with the given branch slots. */
export function createParallelOperationCacheEntry(
  variant: 'all' | 'race' | 'run-all',
  branches: ParallelBranchSlot[],
  subOperationCount: number,
  branchNames?: string[],
): ParallelOperationCacheEntry {
  return {
    __weftParallelOperationCache: true,
    formatVersion: 2,
    variant,
    branches,
    ...(branchNames !== undefined ? { branchNames } : {}),
    subOperationCount,
  };
}

/**
 * Thrown when the workflow's branch topology (count for `ctx.all`, ordered
 * key list for `ctx.runAll`) differs from the cached entry on retry.
 * Indicates non-deterministic workflow code — branches must be stable
 * across retries.
 */
export class BranchTopologyChangedError extends Error {
  override readonly name = 'BranchTopologyChangedError';
}

/** Reconstruct the user-visible array result from a v2 entry's slots. */
function reconstructAllResult(entry: ParallelOperationCacheEntry): unknown[] {
  return entry.branches.map((slot) => {
    if (slot.status !== 'fulfilled') {
      throw new Error(
        `Cannot reconstruct ctx.all result: branch slot is ${slot.status}, not fulfilled`,
      );
    }
    return slot.value;
  });
}

/** Reconstruct the user-visible record result for `ctx.runAll`. */
function reconstructRunAllResult(entry: ParallelOperationCacheEntry): Record<string, unknown> {
  const names = entry.branchNames;
  if (names === undefined) {
    throw new Error('Cannot reconstruct ctx.runAll result: cache entry missing branchNames');
  }
  const result: Record<string, unknown> = {};
  for (let i = 0; i < names.length; i++) {
    const slot = entry.branches[i];
    if (slot?.status !== 'fulfilled') {
      throw new Error(
        `Cannot reconstruct ctx.runAll result: branch '${names[i]}' is ${slot?.status ?? 'missing'}`,
      );
    }
    result[names[i]!] = slot.value;
  }
  return result;
}

/** True iff every slot in the entry is fulfilled (full success). */
function isEntryFullyFulfilled(entry: ParallelOperationCacheEntry): boolean {
  return entry.branches.every((slot) => slot.status === 'fulfilled');
}

export function* all(
  _context: Context,
  internals: ContextInternals,
  operations: Generator<ContextOperationRequest, unknown, unknown>[],
): Generator<ContextOperationRequest, unknown[], unknown> {
  const step = internals.stepIndex++;

  if (internals.accumulatedResults?.has(step)) {
    const cached = internals.accumulatedResults.get(step);
    assertValidParallelOperationCacheEntry(cached);
    if (isParallelOperationCacheEntry(cached)) {
      // Variant guard: a workflow that swapped ctx.all <-> ctx.race at the
      // same step would otherwise reconstruct the wrong shape. Treat as a
      // topology change.
      if (cached.variant !== 'all') {
        throw new BranchTopologyChangedError(
          `ctx.all step ${step} found a cached entry of variant '${cached.variant}'. The same step must use the same parallel primitive across retries.`,
        );
      }
      // Topology guard: branch count must be deterministic across retries
      // even on the fully-fulfilled fast path. If the user changed
      // operations.length between attempts, returning the cached array
      // would silently feed wrong-position values into the workflow.
      if (operations.length !== cached.subOperationCount) {
        throw new BranchTopologyChangedError(
          `ctx.all branch count changed across retry: expected ${cached.subOperationCount}, got ${operations.length}. Branch count must be deterministic.`,
        );
      }
      if (isEntryFullyFulfilled(cached)) {
        internals.stepIndex += cached.subOperationCount;
        return reconstructAllResult(cached);
      }
      // Partial cache: re-yield with the cached entry so the engine reuses
      // fulfilled slots and re-dispatches the rest.
      const subOperations = primeParallelOperations(operations);
      if (subOperations.length !== cached.subOperationCount) {
        throw new BranchTopologyChangedError(
          `ctx.all branch count changed across retry: expected ${cached.subOperationCount}, got ${subOperations.length}. Branch count must be deterministic.`,
        );
      }
      stampDeterministicOperationIds(subOperations, `parallel:${step}`);
      const callerStack = captureCallerStack();
      const result = yield {
        type: 'parallel',
        operationId: `parallel:${step}`,
        operations: subOperations,
        step,
        resumedCacheEntry: cached,
        callerStack,
      };
      // Engine wrote the v2 cache entry; don't overwrite.
      return result as unknown[];
    }

    return cached as unknown[];
  }

  const subOperations = primeParallelOperations(operations);
  const operationId = `parallel:${step}`;
  stampDeterministicOperationIds(subOperations, operationId);
  const callerStack = captureCallerStack();
  const result = yield {
    type: 'parallel',
    operationId,
    operations: subOperations,
    step,
    callerStack,
  };

  // The engine has already written a v2 cache entry to
  // `context.accumulatedResults[step]` via `writePartialEntry`. We don't
  // overwrite it here — keeping the v2 shape is what lets the resume
  // path detect topology changes and reuse fulfilled slots cleanly.
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
    assertValidParallelOperationCacheEntry(cached);
    if (isParallelOperationCacheEntry(cached)) {
      if (cached.variant !== 'race') {
        throw new BranchTopologyChangedError(
          `ctx.race step ${step} found a cached entry of variant '${cached.variant}'. The same step must use the same parallel primitive across retries.`,
        );
      }
      // Branch count must be deterministic across retries. A workflow
      // that changed `operations.length` between attempts would
      // otherwise skip the wrong number of sub-operations on stepIndex
      // advancement.
      if (operations.length !== cached.subOperationCount) {
        throw new BranchTopologyChangedError(
          `ctx.race branch count changed across retry: expected ${cached.subOperationCount}, got ${operations.length}. Branch count must be deterministic.`,
        );
      }
      // Race only ever caches a fulfilled winner; partial entries are not
      // a thing for race because losers are intentionally cancelled.
      const fulfilledSlot = cached.branches.find((slot) => slot.status === 'fulfilled');
      if (fulfilledSlot && fulfilledSlot.status === 'fulfilled') {
        internals.stepIndex += cached.subOperationCount;
        return fulfilledSlot.value;
      }
    }

    return cached;
  }

  const subOperations = primeParallelOperations(operations);
  const operationId = `race:${step}`;
  stampDeterministicOperationIds(subOperations, operationId);
  const callerStack = captureCallerStack();
  const result = yield {
    type: 'race',
    operationId,
    operations: subOperations,
    callerStack,
  };

  // For race, the engine writes the winner directly via the existing
  // operation outcome path; we wrap it in a v2 entry here for symmetry
  // with ctx.all and to use the same isParallelOperationCacheEntry guard
  // on resume. `subOperationCount` keeps the original branch count so
  // the resume path can still advance the workflow's stepIndex past the
  // race's primed sub-operations.
  context.accumulatedResults.set(step, {
    __weftParallelOperationCache: true,
    formatVersion: 2,
    variant: 'race',
    branches: [{ status: 'fulfilled', value: result, operationId: `${operationId}:winner` }],
    subOperationCount: subOperations.length,
  } satisfies ParallelOperationCacheEntry);
  return result;
}

/**
 * Replace each sub-operation's `operationId` with a deterministic value
 * derived from the parent `operationId` and the sub-operation's positional
 * index. Stable across retries — useful for observability and tracing.
 *
 * The deterministic IDs are NOT used as slot keys (slot identity is
 * positional/named). They exist purely as observability metadata.
 */
function stampDeterministicOperationIds(
  subOperations: ContextOperationRequest[],
  parentOperationId: string,
): void {
  for (let i = 0; i < subOperations.length; i++) {
    const op = subOperations[i];
    if (op !== undefined) {
      (op as { operationId: string }).operationId = `${parentOperationId}:${i}`;
    }
  }
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

/**
 * Validate cached `ctx.runAll` topology against the workflow's current
 * branch list. Throws `BranchTopologyChangedError` on variant or
 * name-list mismatch.
 */
function validateRunAllTopology(
  cached: ParallelOperationCacheEntry,
  branchNames: string[],
  step: number,
): void {
  if (cached.variant !== 'run-all') {
    throw new BranchTopologyChangedError(
      `ctx.runAll step ${step} found a cached entry of variant '${cached.variant}'. The same step must use the same parallel primitive across retries.`,
    );
  }
  const cachedNames = cached.branchNames ?? [];
  if (cachedNames.length !== branchNames.length) {
    throw new BranchTopologyChangedError(
      `ctx.runAll branch count changed across retry: expected ${cachedNames.length}, got ${branchNames.length}`,
    );
  }
  for (let i = 0; i < branchNames.length; i++) {
    if (cachedNames[i] !== branchNames[i]) {
      throw new BranchTopologyChangedError(
        `ctx.runAll branch order changed across retry: expected '${cachedNames[i]}' at index ${i}, got '${branchNames[i]}'. Branch names must appear in the same order across retries.`,
      );
    }
  }
}

export function* runAll<T extends Record<string, [Function, ...unknown[]]>>(
  _context: Context,
  internals: ContextInternals,
  branches: T,
): Generator<ContextOperationRequest, Record<keyof T, unknown>, unknown> {
  const step = internals.stepIndex++;
  const branchNames = Object.keys(branches);

  if (internals.accumulatedResults?.has(step)) {
    const cached = internals.accumulatedResults.get(step);
    assertValidParallelOperationCacheEntry(cached);
    if (isParallelOperationCacheEntry(cached)) {
      validateRunAllTopology(cached, branchNames, step);
      if (isEntryFullyFulfilled(cached)) {
        return reconstructRunAllResult(cached) as Record<keyof T, unknown>;
      }
      // Partial cache: re-yield with the cached entry attached.
      const operationId = `run-all:${step}`;
      const callerStack = captureCallerStack();
      const result = yield {
        type: 'run-all' as const,
        operationId,
        branches,
        step,
        resumedCacheEntry: cached,
        callerStack,
      };
      // Engine wrote the v2 cache entry; don't overwrite.
      return result as Record<keyof T, unknown>;
    }
    return cached as Record<keyof T, unknown>;
  }

  if (internals.explainMode) {
    console.log(`[weft] ctx.runAll({ ${branchNames.join(', ')} })`);
    console.log(`  → Creating checkpoint at step ${step}`);
    console.log(`  → Running ${branchNames.length} named branches in parallel`);
  }

  const operationId = `run-all:${step}`;
  const callerStack = captureCallerStack();
  const result = yield {
    type: 'run-all' as const,
    operationId,
    branches,
    step,
    callerStack,
  };

  // The engine wrote a v2 cache entry; don't overwrite. Same reasoning
  // as ctx.all — keep the v2 shape so resume detects topology changes.
  return result as Record<keyof T, unknown>;
}
