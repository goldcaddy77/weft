/**
 * Fired by {@link ReviewCoordinator} when a new human review request is
 * persisted. Carries the `workflowId`, `reviewId`, `reviewType`, and the list
 * of requested `reviewers`. Subscribe to this event to notify reviewers via
 * email, webhook, or ticketing system.
 *
 * @example Route review notifications to a webhook
 * ```ts
 * import { HumanReviewRequestedEvent } from 'weft';
 *
 * const target = new EventTarget();
 *
 * target.addEventListener(HumanReviewRequestedEvent.type, (e) => {
 *   const event = e as HumanReviewRequestedEvent;
 *   console.log(`Review ${event.reviewId} requested for workflow ${event.workflowId}`);
 *   console.log('Reviewers:', event.reviewers);
 * });
 * ```
 */
export class HumanReviewRequestedEvent extends Event {
  static readonly type = 'human-review:requested' as const;
  readonly workflowId: string;
  readonly reviewId: string;
  readonly reviewType: string;
  readonly reviewers: string[];

  constructor(workflowId: string, reviewId: string, reviewType: string, reviewers: string[]) {
    super(HumanReviewRequestedEvent.type);
    this.workflowId = workflowId;
    this.reviewId = reviewId;
    this.reviewType = reviewType;
    this.reviewers = reviewers;
  }
}

/**
 * Fired by {@link ReviewCoordinator} when a reviewer submits a decision.
 * Carries the `reviewId`, `decision` string, `reviewer` identifier, and the
 * time elapsed since the review was created. Use this to close tickets, record
 * audit logs, or trigger downstream workflow steps.
 *
 * @example Record review decisions in an audit log
 * ```ts
 * import { HumanReviewCompletedEvent } from 'weft';
 *
 * const target = new EventTarget();
 *
 * target.addEventListener(HumanReviewCompletedEvent.type, (e) => {
 *   const event = e as HumanReviewCompletedEvent;
 *   console.log(`Review ${event.reviewId}: '${event.decision}' by ${event.reviewer} in ${event.duration}ms`);
 * });
 * ```
 */
export class HumanReviewCompletedEvent extends Event {
  static readonly type = 'human-review:completed' as const;
  readonly workflowId: string;
  readonly reviewId: string;
  readonly decision: string;
  readonly reviewer: string;
  readonly duration: number;

  constructor(
    workflowId: string,
    reviewId: string,
    decision: string,
    reviewer: string,
    duration: number,
  ) {
    super(HumanReviewCompletedEvent.type);
    this.workflowId = workflowId;
    this.reviewId = reviewId;
    this.decision = decision;
    this.reviewer = reviewer;
    this.duration = duration;
  }
}
