/**
 * The storage batch-size cap and its guard. Extracted from `interface.ts` into
 * a dependency-free leaf module so both `interface.ts` (which re-exports these
 * for the public surface) and `derived-operations.ts` (which enforces the cap in
 * its chunked delete fallbacks) can import the value without forming an import
 * cycle. Import from here inside `src/storage/**`; import from `interface.ts` (or
 * a package entry point) everywhere else.
 *
 * @module storage/batch-limits
 */

/**
 * Maximum number of operations or conditions accepted by one storage batch call.
 *
 * @example
 * ```ts
 * import { MAX_BATCH_OPERATIONS } from '@lostgradient/weft/storage';
 *
 * console.log(MAX_BATCH_OPERATIONS); // 10000
 * ```
 */
export const MAX_BATCH_OPERATIONS = 10_000;

/**
 * Batch input category named by {@link StorageBatchOperationLimitExceededError}.
 *
 * @example
 * ```ts
 * import type { StorageBatchOperationLimitTarget } from '@lostgradient/weft/storage';
 *
 * const target: StorageBatchOperationLimitTarget = 'batch operations';
 * void target;
 * ```
 */
export type StorageBatchOperationLimitTarget =
  | 'batch operations'
  | 'conditionalBatch conditions'
  | 'conditionalBatch operations';

/**
 * Error thrown before a storage batch exceeds {@link MAX_BATCH_OPERATIONS}.
 *
 * @example
 * ```ts
 * import { StorageBatchOperationLimitExceededError } from '@lostgradient/weft/storage';
 *
 * const error = new StorageBatchOperationLimitExceededError('batch operations', 10001);
 * console.log(error.cap); // 10000
 * ```
 */
export class StorageBatchOperationLimitExceededError extends Error {
  readonly code = 'StorageBatchOperationLimitExceededError' as const;
  readonly cap = MAX_BATCH_OPERATIONS;
  readonly count: number;
  readonly target: StorageBatchOperationLimitTarget;

  constructor(target: StorageBatchOperationLimitTarget, count: number) {
    super(`${target} count ${count} exceeds MAX_BATCH_OPERATIONS (${MAX_BATCH_OPERATIONS}).`);
    this.name = 'StorageBatchOperationLimitExceededError';
    this.target = target;
    this.count = count;
  }
}

/**
 * Throw when a storage batch target exceeds {@link MAX_BATCH_OPERATIONS}.
 *
 * @example
 * ```ts
 * import { assertStorageBatchOperationCount } from '@lostgradient/weft/storage';
 *
 * assertStorageBatchOperationCount('batch operations', 1);
 * ```
 */
export function assertStorageBatchOperationCount(
  target: StorageBatchOperationLimitTarget,
  count: number,
): void {
  if (count > MAX_BATCH_OPERATIONS) {
    throw new StorageBatchOperationLimitExceededError(target, count);
  }
}
