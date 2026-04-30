# Human Review

Your agent just generated a 20-page financial report. Before it goes to the client, someone from the legal team needs to approve it. Maybe they approve the whole thing. Maybe they reject the recommendations section but approve the rest. Maybe they don't respond for 4 hours and the request needs to escalate to a manager. Maybe they ask the agent a clarifying question and the agent responds, and _then_ they approve.

This isn't a simple "pause and wait for a boolean." It's a structured review protocol with escalation, partial approval, and conversation threading. `ReviewCoordinator` provides all of it, built on top of Weft's durable storage so review state survives crashes.

## Creating a review

The `ReviewCoordinator` takes a `Storage` instance and manages the lifecycle of review requests:

```typescript partial
import { ReviewCoordinator } from 'weft';

const coordinator = new ReviewCoordinator(storage);

const review = await coordinator.createReview('workflow-123', {
  artifact: {
    type: 'report',
    content: agentOutput,
    sections: ['executive-summary', 'methodology', 'findings', 'recommendations'],
  },
  reviewType: 'legal-review',
  reviewers: ['legal-team'],
  allowPartial: true,
  timeout: 4 * 60 * 60 * 1000, // 4 hours
  webhookUrl: 'https://slack.com/api/chat.postMessage',
});
```

`createReview()` generates a unique `reviewId`, timestamps the request, and persists it to storage at `review:{workflowId}:{reviewId}`. The returned `ReviewRequest` has this shape:

```typescript
interface ReviewRequest {
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
```

The `artifact` field is intentionally `unknown`—pass whatever the reviewer needs to see. The `reviewType` is a string tag for filtering and routing (think `'legal-review'`, `'security-audit'`, `'content-approval'`).

## Submitting a decision

When a reviewer makes their decision, complete the review through the engine:

```typescript partial
await engine.submitReview(review.reviewId, {
  decision: 'approved',
  reviewer: 'jane@legal.example.com',
  feedback: 'Looks good. Minor typo in section 3.',
});
```

The `ReviewDecision` structure:

```typescript
interface ReviewDecision {
  reviewId: string;
  decision: 'approved' | 'rejected' | 'needs-changes';
  reviewer: string;
  feedback?: string;
  sectionDecisions?: Record<string, 'approved' | 'rejected'>;
  timestamp: number;
}
```

When `allowPartial` is true on the request, reviewers can approve or reject individual sections:

```typescript partial
await engine.submitReview(review.reviewId, {
  decision: 'needs-changes',
  reviewer: 'jane@legal.example.com',
  feedback: 'Recommendations need revision, rest is fine.',
  sectionDecisions: {
    'executive-summary': 'approved',
    methodology: 'approved',
    findings: 'approved',
    recommendations: 'rejected',
  },
});
```

This lets the agent revise only the rejected sections instead of regenerating the entire artifact.

Note: `coordinator.submitDecision()` is a low-level helper that constructs and returns a `ReviewDecision` object—it does not persist state or emit events. To actually complete a review and trigger `HumanReviewCompletedEvent`, call `engine.submitReview(reviewId, { decision, reviewer, feedback })` or POST to the `/v1/reviews/:reviewId/decision` HTTP endpoint.

## Querying reviews

Fetch a specific review or list all pending ones:

```typescript partial
const review = await coordinator.getReview('workflow-123', reviewId);
const pending = await coordinator.listPendingReviews();
```

`listPendingReviews()` scans all review keys in storage and returns them. In a production setup, the built-in HTTP server exposes these at `GET /v1/reviews` for dashboard integration. All returned reviews are pending by definition—completed reviews are removed from storage via `cleanupOperations()`.

## Escalation chains

Reviews that sit too long need escalation. Define a chain of escalation steps when creating the review:

```typescript partial
const review = await coordinator.createReview(workflowId, {
  artifact: report,
  reviewers: ['legal-team'],
  escalation: [
    { after: 4 * 60 * 60 * 1000, to: 'manager-queue' },
    { after: 24 * 60 * 60 * 1000, action: 'auto-approve', auditReason: 'Timeout after 24 hours' },
  ],
});
```

Each `EscalationStep` has an `after` field (milliseconds since creation) and either a `to` field (escalate to a different reviewer) or an `action` field (`'auto-approve'` or `'auto-reject'`) with an `auditReason`.

Check for triggered escalations:

```typescript partial
const action = coordinator.checkEscalations(review, escalationSteps, Date.now());

if (action?.type === 'escalate') {
  // Reassign to action.to
} else if (action?.type === 'auto-decide') {
  // action.decision is 'approved' or 'rejected'
  // action.auditReason explains why
}
```

`checkEscalations()` walks the steps in reverse order (most advanced first) and returns the most advanced triggered action. If no step has triggered yet, it returns `null`.

## ReviewTimeoutError

If the review exceeds its timeout without a decision, throw `ReviewTimeoutError`:

```typescript partial
import { ReviewTimeoutError } from 'weft';

const elapsed = Date.now() - review.createdAt;
if (review.timeout && elapsed > review.timeout) {
  throw new ReviewTimeoutError(review.reviewId, elapsed);
}
```

The error carries the `reviewId` and `elapsed` time, making it easy to log which review timed out and how long it waited.

The engine throws `ReviewTimeoutError` automatically when a workflow waiting on a review crosses its configured `timeout`. The pattern above is most useful in custom coordinators or tests.

## Event integration

The engine dispatches events when reviews are created and completed:

```typescript partial
engine.addEventListener('human-review:requested', (event) => {
  console.log(
    `Review ${event.reviewId} requested for workflow ${event.workflowId}`,
    `(type: ${event.reviewType}, reviewers: ${event.reviewers.join(', ')})`,
  );
});

engine.addEventListener('human-review:completed', (event) => {
  console.log(
    `Review ${event.reviewId} completed: ${event.decision}`,
    `by ${event.reviewer} in ${event.duration}ms`,
  );
});
```

See the [observability guide](./agent-observability.md) for the full event type definitions.

## Durability

Review state is stored in Weft's standard storage layer. If the process crashes while waiting for human review, recovery loads the pending review and continues waiting. The reviewer's experience is uninterrupted—the review request, escalation timers, and any partial conversation history are all preserved.

Cleanup after a completed review is straightforward:

```typescript partial
const operations = coordinator.cleanupOperations(workflowId, reviewId);
await storage.batch(operations);
```

Human review is where autonomous execution meets organizational trust boundaries. The coordinator gives you structured, durable review flows without reinventing approval workflows from scratch.
