import type { WorkflowId } from './identity.ts';

/**
 * Per-workflow error entry in bulk operation results. `id` identifies the
 * workflow that failed; `error` is the error message string.
 */
export type BulkOperationError = {
  id: WorkflowId;
  error: string;
};

/**
 * Result of a bulk cancel operation (`engine.cancelAll`). Reports the count
 * of successfully cancelled workflows, the number that failed, and per-workflow
 * error details in `errors`.
 */
export type BulkCancelResult = {
  cancelled: number;
  failed: number;
  errors: BulkOperationError[];
};

/**
 * Result of a bulk signal operation (`engine.signalAll`). Reports the number
 * of workflows that received the signal and the number for which delivery failed.
 */
export type BulkSignalResult = {
  signalled: number;
  failed: number;
};

/**
 * Result of a bulk delete operation (`engine.deleteAll`). Reports how many
 * terminal workflows were deleted from storage.
 */
export type BulkDeleteResult = {
  deleted: number;
};

/**
 * Result of a bulk tag operation (`engine.tagAll` / `engine.untagAll`).
 * Reports how many workflows had their tags modified.
 */
export type BulkTagResult = {
  modified: number;
};

/**
 * Result of a purge operation (`engine.purge`). Reports how many workflow
 * records were permanently removed from storage.
 */
export interface PurgeResult {
  deleted: number;
}
