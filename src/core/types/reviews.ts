// ---------------------------------------------------------------------------
// Review decision types (for engine.submitReview)
// ---------------------------------------------------------------------------

/**
 * Outcome of a human review step initiated by `ctx.waitForReview`. Pass as
 * the `decision` field in {@link SubmitReviewOptions} when calling
 * `engine.submitReview`.
 */
export type ReviewDecision = 'approved' | 'rejected' | 'needs-changes';

/**
 * Options for `engine.submitReview`. Supply the `decision`, the `reviewer`
 * identifier, and optional `feedback`. For workflows with partial approval
 * semantics, provide `sectionDecisions`. Pass `workflowId` when you know the
 * target workflow ID to avoid a full storage scan.
 *
 * @example
 * ```ts
 * import { Engine, type SubmitReviewOptions } from 'weft';
 *
 * const engine = new Engine();
 * const options: SubmitReviewOptions = {
 *   decision: 'approved',
 *   reviewer: 'alice@example.com',
 *   feedback: 'Looks good',
 *   workflowId: 'wf-123',
 * };
 * // await engine.submitReview('review-key', options);
 * void options;
 * ```
 */
export interface SubmitReviewOptions {
  decision: ReviewDecision;
  reviewer: string;
  feedback?: string;
  /** Per-section decisions for partial approval workflows. */
  sectionDecisions?: Record<string, 'approved' | 'rejected'>;
  /** When provided, enables O(1) direct key lookup instead of scanning. */
  workflowId?: string;
}

// ---------------------------------------------------------------------------
// Coordinated update result (for engine.submitCoordinatedUpdate)
// ---------------------------------------------------------------------------

/**
 * Result of a coordinated update sent via `engine.submitCoordinatedUpdate`.
 * Contains the `updateId` and either the resolved `result` or an `error`
 * string if the workflow handler threw.
 * Exactly one of `result` or `error` is populated for a settled update:
 * `result` on handler success, `error` (a stringified failure message) on
 * handler throw. Both may be `undefined` on transport-level rejections from
 * `HttpClient.submitCoordinatedUpdate`.
 */
export interface CoordinatedUpdateResult {
  updateId: string;
  result?: unknown;
  error?: string;
}
