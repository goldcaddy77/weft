/**
 * Human-in-the-loop review protocol.
 *
 * Coordinates review requests, decisions, escalation chains,
 * and partial approval workflows for human oversight of AI artifacts.
 *
 * @module human-review
 */

import { decode, encode } from '../core/codec.ts';
import type { BatchOperation, Storage } from '../storage/interface.ts';
import { KEYS } from '../storage/interface.ts';
import { HumanReviewRequestedEvent } from './events.ts';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ReviewRequest {
  reviewId: string;
  workflowId: string;
  artifact: unknown;
  reviewType: string;
  reviewers: string[];
  allowPartial: boolean;
  timeout?: number;
  webhookUrl?: string;
  createdAt: number;
}

export interface ReviewDecision {
  reviewId: string;
  decision: 'approved' | 'rejected' | 'needs-changes';
  reviewer: string;
  feedback?: string;
  sectionDecisions?: Record<string, 'approved' | 'rejected'>;
  timestamp: number;
}

export interface EscalationStep {
  after: number;
  to?: string;
  action?: 'auto-approve' | 'auto-reject';
  auditReason?: string;
}

export interface ReviewOptions {
  artifact: unknown;
  reviewType?: string;
  reviewers?: string[];
  allowPartial?: boolean;
  timeout?: number;
  escalation?: EscalationStep[];
  webhookUrl?: string;
}

/**
 * Options passed to `ctx.humanReview()` inside a workflow generator.
 * Extends the base ReviewOptions with context-level callbacks.
 */
export interface HumanReviewOptions extends ReviewOptions {
  /** Enable conversation round-trips between reviewer and workflow. */
  conversation?: boolean;
  /** Handler for incoming reviewer messages during conversation. */
  onMessage?: (message: string) => string;
  /** Handler called when an escalation step fires. */
  onEscalation?: (action: EscalationAction) => void;
}

/** The decision payload returned to the workflow from `ctx.humanReview()`. */
export type HumanReviewResult = ReviewDecision;

export type EscalationAction =
  | { type: 'escalate'; to: string }
  | { type: 'auto-decide'; decision: 'approved' | 'rejected'; auditReason: string };

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/**
 * Thrown when a human review request exceeds its configured `timeout`
 * milliseconds without receiving a decision. Carries the `reviewId` and the
 * elapsed time so callers can decide whether to escalate or auto-approve.
 *
 * @example Catch a review timeout and escalate
 * ```ts
 * import { ReviewTimeoutError } from 'weft';
 *
 * try {
 *   // Await a review decision (may timeout)
 *   await coordinator.getReview(workflowId, reviewId);
 * } catch (error) {
 *   if (error instanceof ReviewTimeoutError) {
 *     console.warn(`Review ${error.reviewId} timed out after ${error.elapsed}ms — escalating.`);
 *   }
 * }
 * ```
 */
export class ReviewTimeoutError extends Error {
  readonly reviewId: string;
  readonly elapsed: number;

  constructor(reviewId: string, elapsed: number) {
    super(`Review ${reviewId} timed out after ${elapsed}ms`);
    this.name = 'ReviewTimeoutError';
    this.reviewId = reviewId;
    this.elapsed = elapsed;
  }
}

// ---------------------------------------------------------------------------
// Coordinator
// ---------------------------------------------------------------------------

/**
 * Options for constructing a {@link ReviewCoordinator}. Accepts an optional
 * `EventTarget` to dispatch {@link HumanReviewRequestedEvent} on review
 * creation, and a custom `getNow` clock function for deterministic testing.
 *
 * @example Attach an event target and a fixed clock for tests
 * ```ts
 * import { ReviewCoordinator, type ReviewCoordinatorOptions } from 'weft';
 * import { MemoryStorage } from 'weft/storage/memory';
 *
 * const storage = new MemoryStorage();
 * const options: ReviewCoordinatorOptions = {
 *   eventTarget: new EventTarget(),
 *   getNow: () => 1_700_000_000_000,
 * };
 *
 * const coordinator = new ReviewCoordinator(storage, options);
 * ```
 */
export interface ReviewCoordinatorOptions {
  /** When provided, the coordinator dispatches human review events. */
  eventTarget?: EventTarget;
  /** Custom time source for testing. Defaults to `Date.now`. */
  getNow?: () => number;
}

/**
 * Persists human review requests to storage, dispatches
 * {@link HumanReviewRequestedEvent} on creation, accepts reviewer decisions,
 * and checks escalation timeouts. Used by `ctx.humanReview()` inside workflow
 * generators to pause execution pending a human decision.
 *
 * @example Create a review and later submit a decision
 * ```ts
 * import { ReviewCoordinator } from 'weft';
 * import { MemoryStorage } from 'weft/storage/memory';
 *
 * const storage = new MemoryStorage();
 * const coordinator = new ReviewCoordinator(storage);
 *
 * const review = await coordinator.createReview('wf-123', {
 *   artifact: { text: 'Draft email body…' },
 *   reviewType: 'content',
 *   reviewers: ['alice@example.com'],
 * });
 *
 * const decision = await coordinator.submitDecision(review.reviewId, {
 *   decision: 'approved',
 *   reviewer: 'alice@example.com',
 * });
 * console.log(decision.decision); // 'approved'
 * ```
 */
export class ReviewCoordinator {
  #storage: Storage;
  #getNow: () => number;
  #eventTarget: EventTarget | undefined;

  constructor(storage: Storage, optionsOrGetNow?: ReviewCoordinatorOptions | (() => number)) {
    this.#storage = storage;
    if (typeof optionsOrGetNow === 'function') {
      this.#getNow = optionsOrGetNow;
    } else {
      this.#getNow = optionsOrGetNow?.getNow ?? Date.now;
      this.#eventTarget = optionsOrGetNow?.eventTarget;
    }
  }

  /** Create a review request and persist it. */
  async createReview(workflowId: string, options: ReviewOptions): Promise<ReviewRequest> {
    const reviewId = crypto.randomUUID();

    const request: ReviewRequest = {
      reviewId,
      workflowId,
      artifact: options.artifact,
      reviewType: options.reviewType ?? 'general',
      reviewers: options.reviewers ?? [],
      allowPartial: options.allowPartial ?? false,
      createdAt: this.#getNow(),
    };

    if (options.timeout !== undefined) {
      request.timeout = options.timeout;
    }

    if (options.webhookUrl !== undefined) {
      request.webhookUrl = options.webhookUrl;
    }

    const key = KEYS.review(workflowId, reviewId);
    await this.#storage.put(key, encode(request));

    if (this.#eventTarget) {
      this.#eventTarget.dispatchEvent(
        new HumanReviewRequestedEvent(workflowId, reviewId, request.reviewType, request.reviewers),
      );
    }

    return request;
  }

  /** Submit a review decision. */
  async submitDecision(
    reviewId: string,
    decision: Omit<ReviewDecision, 'reviewId' | 'timestamp'>,
  ): Promise<ReviewDecision> {
    const full: ReviewDecision = {
      reviewId,
      decision: decision.decision,
      reviewer: decision.reviewer,
      timestamp: Date.now(),
    };

    if (decision.feedback !== undefined) {
      full.feedback = decision.feedback;
    }

    if (decision.sectionDecisions !== undefined) {
      full.sectionDecisions = decision.sectionDecisions;
    }

    return full;
  }

  /** Get a pending review. */
  async getReview(workflowId: string, reviewId: string): Promise<ReviewRequest | null> {
    const key = KEYS.review(workflowId, reviewId);
    const raw = await this.#storage.get(key);
    if (!raw) return null;

    return decode(raw) as ReviewRequest;
  }

  /** List pending reviews. */
  async listPendingReviews(): Promise<ReviewRequest[]> {
    const prefix = 'review:';
    const results: ReviewRequest[] = [];

    for await (const [, value] of this.#storage.scan(prefix)) {
      results.push(decode(value) as ReviewRequest);
    }

    return results;
  }

  /** Build cleanup operations for completed workflow. */
  cleanupOperations(workflowId: string, reviewId: string): BatchOperation[] {
    return [{ type: 'delete', key: KEYS.review(workflowId, reviewId) }];
  }

  /** Check for escalation timeouts. Returns actions to take. */
  checkEscalations(
    review: ReviewRequest,
    escalation: EscalationStep[],
    now: number,
  ): EscalationAction | null {
    const elapsed = now - review.createdAt;

    // Walk steps in reverse order so the most advanced triggered step wins.
    for (let i = escalation.length - 1; i >= 0; i--) {
      const step = escalation[i]!;

      if (elapsed < step.after) continue;

      if (step.action !== undefined) {
        const decision = step.action === 'auto-approve' ? 'approved' : 'rejected';
        return {
          type: 'auto-decide',
          decision,
          auditReason: step.auditReason ?? `Auto-${decision} after ${step.after}ms`,
        };
      }

      if (step.to !== undefined) {
        return { type: 'escalate', to: step.to };
      }
    }

    return null;
  }
}
