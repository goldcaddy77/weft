import { afterEach, beforeEach, describe, expect, it } from 'bun:test';

import { decode } from '../core/codec.ts';
import { KEYS } from '../storage/interface.ts';
import { MemoryStorage } from '../storage/memory.ts';
import { HumanReviewRequestedEvent } from './events.ts';
import {
  ReviewCoordinator,
  ReviewTimeoutError,
  type EscalationAction,
  type EscalationStep,
  type ReviewRequest,
} from './human-review.ts';

describe('ReviewCoordinator', () => {
  let storage: MemoryStorage;
  let coordinator: ReviewCoordinator;

  beforeEach(() => {
    storage = new MemoryStorage();
    coordinator = new ReviewCoordinator(storage);
  });

  afterEach(() => {
    storage.clear();
  });

  describe('createReview', () => {
    it('stores request in storage', async () => {
      const request = await coordinator.createReview('wf-1', {
        artifact: { content: 'draft blog post' },
        reviewType: 'content-review',
        reviewers: ['alice', 'bob'],
      });

      const raw = await storage.get(KEYS.review('wf-1', request.reviewId));
      expect(raw).not.toBeNull();

      const stored = decode(raw!) as ReviewRequest;
      expect(stored.workflowId).toBe('wf-1');
      expect(stored.artifact).toEqual({ content: 'draft blog post' });
      expect(stored.reviewType).toBe('content-review');
      expect(stored.reviewers).toEqual(['alice', 'bob']);
    });

    it('returns request with UUID', async () => {
      const request = await coordinator.createReview('wf-1', {
        artifact: 'some artifact',
      });

      expect(request.reviewId).toMatch(
        /^[\da-f]{8}-[\da-f]{4}-4[\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/i,
      );
      expect(request.workflowId).toBe('wf-1');
      expect(request.createdAt).toBeGreaterThan(0);
    });

    it('dispatches HumanReviewRequestedEvent when eventTarget is provided', async () => {
      const eventTarget = new EventTarget();
      const coordinatorWithEvents = new ReviewCoordinator(storage, { eventTarget });
      const receivedEvents: HumanReviewRequestedEvent[] = [];

      eventTarget.addEventListener(HumanReviewRequestedEvent.type, (event) => {
        receivedEvents.push(event as HumanReviewRequestedEvent);
      });

      const request = await coordinatorWithEvents.createReview('wf-event-1', {
        artifact: { content: 'review this' },
        reviewType: 'code-review',
        reviewers: ['alice', 'bob'],
      });

      expect(receivedEvents).toHaveLength(1);
      expect(receivedEvents[0]!.workflowId).toBe('wf-event-1');
      expect(receivedEvents[0]!.reviewId).toBe(request.reviewId);
      expect(receivedEvents[0]!.reviewType).toBe('code-review');
      expect(receivedEvents[0]!.reviewers).toEqual(['alice', 'bob']);
    });

    it('does not dispatch HumanReviewRequestedEvent when no eventTarget is provided', async () => {
      // This test verifies that the coordinator works fine without an eventTarget.
      // If it throws, the test will fail.
      const request = await coordinator.createReview('wf-no-events', {
        artifact: 'some artifact',
      });

      expect(request.workflowId).toBe('wf-no-events');
    });
  });

  describe('getReview', () => {
    it('returns stored request', async () => {
      const created = await coordinator.createReview('wf-1', {
        artifact: { title: 'PR #42' },
        reviewType: 'code-review',
        reviewers: ['charlie'],
      });

      const fetched = await coordinator.getReview('wf-1', created.reviewId);

      expect(fetched).not.toBeNull();
      expect(fetched!.reviewId).toBe(created.reviewId);
      expect(fetched!.artifact).toEqual({ title: 'PR #42' });
      expect(fetched!.reviewType).toBe('code-review');
    });

    it('returns null when not found', async () => {
      const result = await coordinator.getReview('wf-1', 'nonexistent-id');

      expect(result).toBeNull();
    });
  });

  describe('submitDecision', () => {
    it('returns full ReviewDecision', async () => {
      const request = await coordinator.createReview('wf-1', {
        artifact: 'document',
        reviewers: ['alice'],
      });

      const decision = await coordinator.submitDecision(request.reviewId, {
        decision: 'approved',
        reviewer: 'alice',
        feedback: 'Looks good to me!',
      });

      expect(decision.reviewId).toBe(request.reviewId);
      expect(decision.decision).toBe('approved');
      expect(decision.reviewer).toBe('alice');
      expect(decision.feedback).toBe('Looks good to me!');
      expect(decision.timestamp).toBeGreaterThan(0);
    });
  });

  describe('listPendingReviews', () => {
    it('returns all pending reviews', async () => {
      await coordinator.createReview('wf-1', {
        artifact: 'artifact-a',
        reviewers: ['alice'],
      });
      await coordinator.createReview('wf-2', {
        artifact: 'artifact-b',
        reviewers: ['bob'],
      });

      const pending = await coordinator.listPendingReviews();

      expect(pending).toHaveLength(2);
      const workflows = pending.map((review) => review.workflowId);
      expect(workflows).toContain('wf-1');
      expect(workflows).toContain('wf-2');
    });
  });

  describe('cleanupOperations', () => {
    it('produces DELETE batch operations', () => {
      const operations = coordinator.cleanupOperations('wf-1', 'review-123');

      expect(operations).toHaveLength(1);
      expect(operations[0]).toEqual({
        type: 'delete',
        key: KEYS.review('wf-1', 'review-123'),
      });
    });
  });

  describe('checkEscalations', () => {
    const baseReview: ReviewRequest = {
      reviewId: 'rev-1',
      workflowId: 'wf-1',
      artifact: 'some artifact',
      reviewType: 'content-review',
      reviewers: ['alice'],
      allowPartial: false,
      createdAt: 1000,
    };

    it('returns null when no escalation needed', () => {
      const escalation: EscalationStep[] = [{ after: 60_000, to: 'managers' }];

      // Only 30 seconds have passed, threshold is 60 seconds
      const result = coordinator.checkEscalations(baseReview, escalation, 31_000);

      expect(result).toBeNull();
    });

    it('returns escalate action when timeout passed', () => {
      const escalation: EscalationStep[] = [{ after: 60_000, to: 'managers' }];

      // 90 seconds have passed, threshold is 60 seconds
      const result = coordinator.checkEscalations(baseReview, escalation, 91_000);

      expect(result).not.toBeNull();
      expect(result!.type).toBe('escalate');
      expect((result as Extract<EscalationAction, { type: 'escalate' }>).to).toBe('managers');
    });

    it('returns auto-decide for final step', () => {
      const escalation: EscalationStep[] = [
        { after: 60_000, to: 'managers' },
        { after: 120_000, action: 'auto-approve', auditReason: 'No response after escalation' },
      ];

      // 150 seconds have passed, both thresholds exceeded
      const result = coordinator.checkEscalations(baseReview, escalation, 151_000);

      expect(result).not.toBeNull();
      expect(result!.type).toBe('auto-decide');
      const autoDecide = result as Extract<EscalationAction, { type: 'auto-decide' }>;
      expect(autoDecide.decision).toBe('approved');
      expect(autoDecide.auditReason).toBe('No response after escalation');
    });
  });

  describe('ReviewTimeoutError', () => {
    it('has correct properties', () => {
      const error = new ReviewTimeoutError('rev-42', 5000);

      expect(error).toBeInstanceOf(Error);
      expect(error).toBeInstanceOf(ReviewTimeoutError);
      expect(error.reviewId).toBe('rev-42');
      expect(error.elapsed).toBe(5000);
      expect(error.message).toContain('rev-42');
      expect(error.message).toContain('5000');
      expect(error.name).toBe('ReviewTimeoutError');
    });
  });

  describe('partial approval with section decisions', () => {
    it('records section-level decisions', async () => {
      const request = await coordinator.createReview('wf-1', {
        artifact: { sections: ['intro', 'body', 'conclusion'] },
        reviewers: ['alice'],
        allowPartial: true,
      });

      const decision = await coordinator.submitDecision(request.reviewId, {
        decision: 'needs-changes',
        reviewer: 'alice',
        feedback: 'Intro and conclusion are fine, body needs work',
        sectionDecisions: {
          intro: 'approved',
          body: 'rejected',
          conclusion: 'approved',
        },
      });

      expect(decision.decision).toBe('needs-changes');
      expect(decision.sectionDecisions).toEqual({
        intro: 'approved',
        body: 'rejected',
        conclusion: 'approved',
      });
    });
  });
});
