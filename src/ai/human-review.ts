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

export interface ReviewCoordinatorOptions {
  /** When provided, the coordinator dispatches human review events. */
  eventTarget?: EventTarget;
}

export class ReviewCoordinator {
  #storage: Storage;
  #getNow: () => number;

  constructor(storage: Storage, getNow?: () => number) {
    this.#storage = storage;
    this.#getNow = getNow ?? Date.now;
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
        new HumanReviewRequestedEvent(
          workflowId,
          reviewId,
          request.reviewType,
          request.reviewers,
        ),
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
