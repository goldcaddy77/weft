/**
 * Shared dispatch helper for `ctx.all` and `ctx.runAll`. Runs branches with
 * `Promise.allSettled` semantics so successful branches' results can be
 * persisted to the parent operation's cache entry before any rejection
 * propagates. The returned partial entry is written to the workflow's
 * `accumulatedResults` map by the caller, so on retry the workflow's
 * generator can reuse fulfilled slots and re-dispatch the rest.
 *
 * Why this is a separate module: the same `Promise.allSettled` pattern is
 * needed in three places — `processParallelOperation` (top-level
 * `ctx.all`), `executeSubOperation` (`ctx.all` nested inside another
 * sub-operation), and `executeRunAllBranches` (`ctx.runAll`). One helper
 * means one place to maintain the slot/error contract.
 *
 * Persistence model: the helper does NOT call `persistCheckpoint`
 * directly. It mutates `context.accumulatedResults[parentStep]` in place
 * with the partial entry; the existing checkpoint-persistence path picks
 * it up on the next yield boundary (whether that's the user's catch
 * block re-yielding or the workflow failing on the next operation). This
 * trades some durability under hard process crashes for a much smaller
 * blast radius into the engine's checkpoint-write machinery — see the
 * `parallel-execution.md` guide for the precise durability contract.
 */

import type {
  ParallelBranchSlot,
  ParallelOperationCacheEntry,
} from '../context/parallel-operations.ts';
import { createParallelOperationCacheEntry } from '../context/parallel-operations.ts';

export type ParallelDispatchResult = {
  /** Final slot table — every entry is `fulfilled` or `rejected`. */
  slots: ParallelBranchSlot[];
  /**
   * Whether at least one branch rejected. Distinguishes "no rejection"
   * from "rejected with `undefined`" — the latter is rare but valid in
   * `Promise.all` semantics.
   */
  hasFirstError: boolean;
  /**
   * The first rejection observed by settlement timing, in its original
   * shape. `Promise.all` rethrows whatever was thrown — including
   * non-`Error` values like strings, numbers, or `undefined`. Callers
   * rethrow this as-is to preserve that contract.
   */
  firstError: unknown;
};

export type DispatchOneBranch = (index: number) => Promise<unknown>;

/**
 * Run every branch via `executeOne(index)`, capturing per-branch outcomes
 * in a slot table. Reused fulfilled slots (passed in via `resumedSlots`)
 * skip dispatch entirely; missing/rejected/aborted slots dispatch fresh.
 *
 * The promise NEVER rejects — callers receive a `slots` array, a
 * `hasFirstError` flag, and the original `firstError` value. Callers
 * translate that into rejection of the parent operation themselves so
 * they can write the partial entry first. Persisted rejection metadata
 * is normalized to `{ name, message }` because raw `Error` objects
 * don't round-trip through MessagePack, but the value rethrown to the
 * workflow generator is the original `unknown` reason.
 */
export async function dispatchBranchesAllSettled(
  operationIds: string[],
  resumedSlots: ParallelBranchSlot[] | undefined,
  executeOne: DispatchOneBranch,
): Promise<ParallelDispatchResult> {
  const slots: ParallelBranchSlot[] = operationIds.map((operationId, i) => {
    const cached = resumedSlots?.[i];
    if (cached?.status === 'fulfilled') return cached;
    return { status: 'pending', operationId };
  });

  let hasFirstError = false;
  let firstError: unknown = undefined;

  await Promise.all(
    operationIds.map(async (operationId, index) => {
      if (slots[index]?.status === 'fulfilled') {
        // Already-fulfilled resumed slot — no-op.
        return;
      }
      try {
        const value = await executeOne(index);
        slots[index] = { status: 'fulfilled', value, operationId };
      } catch (error) {
        // Persist normalized name/message because Error objects don't
        // round-trip through MessagePack, but capture the original
        // reason to rethrow.
        const reasonError = error instanceof Error ? error : new Error(String(error));
        slots[index] = {
          status: 'rejected',
          reason: { name: reasonError.name, message: reasonError.message },
          operationId,
        };
        if (!hasFirstError) {
          hasFirstError = true;
          firstError = error;
        }
      }
    }),
  );

  return { slots, hasFirstError, firstError };
}

/**
 * Build a v2 cache entry from the result of `dispatchBranchesAllSettled`.
 * Convenience wrapper used by every dispatch site.
 */
export function buildEntryFromSlots(
  variant: 'all' | 'race' | 'run-all',
  slots: ParallelBranchSlot[],
  branchNames?: string[],
): ParallelOperationCacheEntry {
  return createParallelOperationCacheEntry(variant, slots, slots.length, branchNames);
}

/**
 * Reconstruct the user-visible array result from a fully-fulfilled slot
 * table. Throws if any slot is non-fulfilled — callers must check
 * `firstError` first and throw it instead of calling this on a partial
 * result.
 */
export function valuesFromSlots(slots: ParallelBranchSlot[]): unknown[] {
  return slots.map((slot, i) => {
    if (slot.status !== 'fulfilled') {
      throw new Error(`Branch slot ${i} is ${slot.status}, not fulfilled`);
    }
    return slot.value;
  });
}
