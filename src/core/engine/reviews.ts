import type { BatchOperation } from '../../storage/interface.ts';
import { KEYS, encodeStorageKeyComponent } from '../../storage/interface.ts';
import { ReviewCompletedEvent, ReviewRequestedEvent } from '../review/events.ts';
import {
  ReviewTimeoutError,
  type HumanReviewOptions,
  type HumanReviewResult,
  type ReviewOptions,
  type ReviewRequest,
} from '../review/index.ts';
import type {
  CompletedReviewEntry,
  OperationOutcome,
  PendingReviewEntry,
  ReviewListEntry,
  ReviewListFilter,
  SubmitReviewOptions,
} from '../types.ts';
import {
  deleteCompletedReviewsForWorkflow,
  listCompletedReviewsFromStorage,
  persistCompletedReviewRecord,
} from './completed-review-storage.ts';
import type { EngineInternals } from './internals.ts';
import { parseStoredReviewRequest, toPendingReviewEntry } from './review-list-entries.ts';
import { trackWaiterKey, untrackWaiterKey } from './signals.ts';

type ReviewOperationOutcome = { ok: true; value: HumanReviewResult } | { ok: false; error: Error };

export type SubmitReviewCallbacks = {
  dispatchEvent: (event: Event) => boolean;
};

export type ReviewOperationCallbacks = {
  dispatchEvent: (event: Event) => boolean;
  failWorkflow: (workflowId: string, error: Error) => Promise<void>;
  feedOperationResult: (workflowId: string, result: OperationOutcome) => void;
  ensureTerminalCleanupTracked: (workflowId: string) => Promise<void>;
};

function reviewScanPrefix(filter: ReviewListFilter): string {
  if (filter.workflowId === undefined) {
    return 'review:';
  }

  return `review:${encodeStorageKeyComponent(filter.workflowId)}:`;
}

function matchesReviewFilter(
  review: Pick<CompletedReviewEntry, 'workflowId' | 'reviewType'>,
  filter: ReviewListFilter,
): boolean {
  if (filter.workflowId !== undefined && review.workflowId !== filter.workflowId) {
    return false;
  }

  if (filter.reviewType !== undefined && review.reviewType !== filter.reviewType) {
    return false;
  }

  return true;
}

async function listPendingReviews(
  internals: EngineInternals,
  filter: ReviewListFilter,
): Promise<PendingReviewEntry[]> {
  const reviews: PendingReviewEntry[] = [];

  for await (const [, value] of internals.storage.scan(reviewScanPrefix(filter))) {
    const review = parseStoredReviewRequest(value);
    if (review !== null && matchesReviewFilter(review, filter)) {
      reviews.push(toPendingReviewEntry(review));
    }
  }

  return reviews;
}

async function dispatchCompletedReview(
  internals: EngineInternals,
  reviewKey: string,
  reviewData: ReviewRequest,
  decisionResult: HumanReviewResult,
  dispatchEvent: (event: Event) => boolean,
): Promise<void> {
  await persistCompletedReviewRecord(internals.storage, reviewKey, reviewData, decisionResult);
  dispatchEvent(
    new ReviewCompletedEvent(
      reviewData.workflowId,
      reviewData.reviewId,
      decisionResult.decision,
      decisionResult.reviewer,
      decisionResult.timestamp - reviewData.createdAt,
    ),
  );
}

/** List pending reviews by default, or completed reviews when explicitly requested. */
export async function listReviews(
  internals: EngineInternals,
  filter: ReviewListFilter = {},
): Promise<ReviewListEntry[]> {
  if (filter.status === 'completed') {
    return listCompletedReviewsFromStorage(internals.storage, filter);
  }

  return listPendingReviews(internals, filter);
}

/** Retrieve a specific review by workflowId and reviewId. */
export async function getReview(
  internals: EngineInternals,
  workflowId: string,
  reviewId: string,
): Promise<ReviewRequest | null> {
  return internals.reviewCoordinator.getReview(workflowId, reviewId);
}

/**
 * Submit a decision for a pending review. Stores the decision, removes
 * the pending review, and wakes the paused workflow if one is waiting.
 */
// oxlint-disable-next-line complexity -- ID:core-engine-submit-review-complexity
export async function submitReview(
  internals: EngineInternals,
  reviewId: string,
  options: SubmitReviewOptions,
  callbacks: SubmitReviewCallbacks,
): Promise<void> {
  const { decision, reviewer, feedback, sectionDecisions, workflowId } = options;

  // Look up the review by direct key when workflowId is provided (O(1)),
  // otherwise fall back to scanning all review entries (O(n)).
  let reviewKey: string | null = null;
  let resolvedWorkflowId: string | undefined = workflowId;
  let reviewData: ReviewRequest | undefined;

  if (workflowId !== undefined) {
    const directKey = KEYS.review(workflowId, reviewId);
    const existing = await internals.storage.get(directKey);
    if (existing !== null) {
      reviewKey = directKey;
      reviewData = parseStoredReviewRequest(existing) ?? undefined;
    }
  } else {
    for await (const [key, value] of internals.storage.scan('review:')) {
      const review = parseStoredReviewRequest(value);
      if (review !== null && review.reviewId === reviewId) {
        reviewKey = key;
        reviewData = review;
        resolvedWorkflowId = review.workflowId;
        break;
      }
    }
  }

  if (reviewKey === null) {
    throw new Error(`Review "${reviewId}" not found`);
  }

  if (reviewData === undefined) {
    throw new Error(`Review "${reviewId}" could not be loaded`);
  }

  const now = internals.options.getNow();
  const decisionResult: HumanReviewResult = {
    reviewId,
    decision,
    reviewer,
    timestamp: now,
  };

  if (feedback !== undefined) {
    decisionResult.feedback = feedback;
  }

  if (sectionDecisions !== undefined) {
    decisionResult.sectionDecisions = sectionDecisions;
  }

  await dispatchCompletedReview(
    internals,
    reviewKey,
    reviewData,
    decisionResult,
    callbacks.dispatchEvent,
  );

  // Wake the waiting workflow by resolving its review waiter
  if (resolvedWorkflowId) {
    const waiterKey = `${resolvedWorkflowId}:${reviewId}`;
    const waiter = internals.reviewWaiters.get(waiterKey);
    if (waiter) {
      internals.reviewWaiters.delete(waiterKey);
      untrackWaiterKey(internals.reviewWaitersByWorkflow, resolvedWorkflowId, waiterKey);
      waiter(decisionResult);
    }
  }
}

export function resolveReviewDecision(
  resolve: (result: ReviewOperationOutcome) => void,
  decision: HumanReviewResult,
): void {
  resolve({ ok: true, value: decision });
}

export async function handleReviewEscalationTimer(
  internals: EngineInternals,
  workflowId: string,
  reviewId: string,
  waiterKey: string,
  reviewRequest: ReviewRequest,
  options: HumanReviewOptions,
  resolve: (result: ReviewOperationOutcome) => void,
  entry: { id: string; workflowId: string },
  callbacks: Pick<ReviewOperationCallbacks, 'dispatchEvent' | 'failWorkflow'>,
): Promise<boolean> {
  if (
    !entry.id.startsWith(`review-escalation:${reviewId}:`) &&
    entry.id !== `review-timeout:${reviewId}`
  ) {
    return false;
  }

  if (entry.id === `review-timeout:${reviewId}`) {
    internals.reviewWaiters.delete(waiterKey);
    untrackWaiterKey(internals.reviewWaitersByWorkflow, workflowId, waiterKey);
    const elapsed = internals.options.getNow() - reviewRequest.createdAt;
    await internals.storage.delete(KEYS.review(workflowId, reviewId));

    const timeoutError = new ReviewTimeoutError(reviewId, elapsed);
    await callbacks.failWorkflow(workflowId, timeoutError);
    resolve({ ok: false, error: timeoutError });
    return true;
  }

  if (!options.escalation) {
    return false;
  }

  const action = internals.reviewCoordinator.checkEscalations(
    reviewRequest,
    options.escalation,
    internals.options.getNow(),
  );

  if (!action) {
    return false;
  }

  if (action.type === 'escalate') {
    options.onEscalation?.(action);
    return false;
  }

  internals.reviewWaiters.delete(waiterKey);
  untrackWaiterKey(internals.reviewWaitersByWorkflow, workflowId, waiterKey);
  const autoResult: HumanReviewResult = {
    reviewId,
    decision: action.decision,
    reviewer: 'system',
    feedback: action.auditReason,
    timestamp: internals.options.getNow(),
  };

  await dispatchCompletedReview(
    internals,
    KEYS.review(workflowId, reviewId),
    reviewRequest,
    autoResult,
    callbacks.dispatchEvent,
  );
  resolve({ ok: true, value: autoResult });
  return true;
}

export async function sendReviewWebhook(
  internals: EngineInternals,
  workflowId: string,
  reviewRequest: ReviewRequest,
  webhookUrl: string,
  webhookAbort: AbortController,
): Promise<void> {
  try {
    await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        workflowId,
        reviewId: reviewRequest.reviewId,
        reviewType: reviewRequest.reviewType,
        reviewers: reviewRequest.reviewers,
        artifact: reviewRequest.artifact,
      }),
      signal: webhookAbort.signal,
    });
  } catch (error: unknown) {
    if (!(error instanceof DOMException && error.name === 'AbortError')) {
      console.warn(`[weft] Failed to send review webhook for ${reviewRequest.reviewId}`, error);
    }
  } finally {
    internals.pendingWebhooks.delete(webhookAbort);
  }
}

/** Remove all pending review entries from storage for a given workflow. */
export async function cleanupReviews(
  internals: EngineInternals,
  workflowId: string,
): Promise<void> {
  const pendingPrefix = `review:${encodeStorageKeyComponent(workflowId)}:`;
  const deleteOperations: BatchOperation[] = [];

  if (internals.storage.deletePrefix) {
    await internals.storage.deletePrefix(pendingPrefix);
  } else {
    for await (const [key] of internals.storage.scan(pendingPrefix)) {
      deleteOperations.push({ type: 'delete', key });
    }
  }

  if (deleteOperations.length > 0) {
    await internals.storage.batch(deleteOperations);
  }

  await deleteCompletedReviewsForWorkflow(internals.storage, workflowId);
}

/**
 * Handle a `wait-review` operation: create a durable review request,
 * dispatch events, fire webhooks, set up escalation timers, and block
 * until a decision arrives via `submitReview()`.
 */
// oxlint-disable-next-line complexity -- ID:core-engine-process-review-operation-complexity
export async function processReviewOperation(
  internals: EngineInternals,
  workflowId: string,
  options: HumanReviewOptions,
  callbacks: ReviewOperationCallbacks,
): Promise<void> {
  const now = internals.options.getNow();
  await callbacks.ensureTerminalCleanupTracked(workflowId);

  // Create a review request in storage
  const reviewOptions: ReviewOptions = {
    artifact: options.artifact,
  };
  if (options.reviewType !== undefined) reviewOptions.reviewType = options.reviewType;
  if (options.reviewers !== undefined) reviewOptions.reviewers = options.reviewers;
  if (options.allowPartial !== undefined) reviewOptions.allowPartial = options.allowPartial;
  if (options.timeout !== undefined) reviewOptions.timeout = options.timeout;
  if (options.escalation !== undefined) reviewOptions.escalation = options.escalation;
  if (options.webhookUrl !== undefined) reviewOptions.webhookUrl = options.webhookUrl;

  const reviewRequest = await internals.reviewCoordinator.createReview(workflowId, reviewOptions);

  const reviewId = reviewRequest.reviewId;

  // Dispatch ReviewRequestedEvent
  callbacks.dispatchEvent(
    new ReviewRequestedEvent(
      workflowId,
      reviewId,
      reviewRequest.reviewType,
      reviewRequest.reviewers,
    ),
  );

  // Fire webhook notification with cancellation support tied to engine lifecycle
  if (options.webhookUrl) {
    const webhookAbort = new AbortController();
    internals.pendingWebhooks.add(webhookAbort);
    void sendReviewWebhook(internals, workflowId, reviewRequest, options.webhookUrl, webhookAbort);
  }

  // Set up escalation timers and track their IDs for cleanup
  const timerIds: string[] = [];
  if (options.escalation && options.escalation.length > 0) {
    for (const step of options.escalation) {
      const fireAt = now + step.after;
      const timerId = `review-escalation:${reviewId}:${step.after}`;
      timerIds.push(timerId);
      await internals.scheduler.schedule({
        id: timerId,
        workflowId,
        fireAt,
        kind: 'sleep', // Reuse sleep kind — the timer handler checks the id prefix
      });
    }
  }

  // Set up timeout timer
  if (options.timeout !== undefined) {
    const timeoutFireAt = now + options.timeout;
    const timeoutTimerId = `review-timeout:${reviewId}`;
    timerIds.push(timeoutTimerId);
    await internals.scheduler.schedule({
      id: timeoutTimerId,
      workflowId,
      fireAt: timeoutFireAt,
      kind: 'sleep',
    });
  }

  // Wait for the review decision (blocks the workflow generator).
  // We use a result-or-error wrapper instead of rejection to avoid
  // unhandled rejection timing issues with bun:test.
  const { promise, resolve } = Promise.withResolvers<ReviewOperationOutcome>();
  const waiterKey = `${workflowId}:${reviewId}`;
  internals.reviewWaiters.set(waiterKey, (decision) => resolveReviewDecision(resolve, decision));
  trackWaiterKey(internals.reviewWaitersByWorkflow, workflowId, waiterKey);

  // Register the escalation handler and track the reviewId → workflowId association
  internals.reviewEscalationHandlers.set(reviewId, (entry) =>
    handleReviewEscalationTimer(
      internals,
      workflowId,
      reviewId,
      waiterKey,
      reviewRequest,
      options,
      resolve,
      entry,
      callbacks,
    ),
  );
  if (timerIds.length > 0) {
    internals.reviewTimerIds.set(reviewId, timerIds);
  }
  let reviewIdSet = internals.workflowReviewIds.get(workflowId);
  if (!reviewIdSet) {
    reviewIdSet = new Set();
    internals.workflowReviewIds.set(workflowId, reviewIdSet);
  }
  reviewIdSet.add(reviewId);

  const outcome = await promise;

  // Clean up escalation handler, timer IDs, and workflow-reviewId tracking
  internals.reviewEscalationHandlers.delete(reviewId);
  internals.reviewTimerIds.delete(reviewId);
  const trackedIds = internals.workflowReviewIds.get(workflowId);
  if (trackedIds) {
    trackedIds.delete(reviewId);
    if (trackedIds.size === 0) internals.workflowReviewIds.delete(workflowId);
  }

  // Cancel any remaining escalation/timeout timers
  if (options.escalation) {
    for (const step of options.escalation) {
      await internals.scheduler.cancel(`review-escalation:${reviewId}:${step.after}`, workflowId);
    }
  }
  if (options.timeout !== undefined) {
    await internals.scheduler.cancel(`review-timeout:${reviewId}`, workflowId);
  }

  if (!outcome.ok) {
    // The workflow was already failed directly (e.g., by the timeout handler).
    // Just return without feeding a result.
    return;
  }

  callbacks.feedOperationResult(workflowId, { status: 'completed', value: outcome.value });
}
