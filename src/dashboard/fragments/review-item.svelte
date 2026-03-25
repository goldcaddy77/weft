<script lang="ts" module>
  import type { ReviewRequest } from '../api-client.ts';

  export type ReviewItemProps = {
    review: ReviewRequest;
    submittingReviewId: string | null;
    onApprove: (reviewId: string) => void;
    onReject: (reviewId: string) => void;
  };
</script>

<script lang="ts">
  import { navigate } from '../router.svelte.ts';
  import { truncate } from '../utilities/truncate.ts';
  import { formatRelativeTime } from '../utilities/format-date.ts';
  import Badge from '../components/badge.svelte';
  import Button from '../components/button.svelte';
  import Card from '../components/card.svelte';

  let { review, submittingReviewId, onApprove, onReject }: ReviewItemProps = $props();

  const isSubmitting = $derived(submittingReviewId === review.reviewId);
  const isAnySubmitting = $derived(submittingReviewId !== null);

  const artifactPreview = $derived.by(() => {
    if (review.artifact === null || review.artifact === undefined) return '-';
    try {
      const json = JSON.stringify(review.artifact);
      return truncate(json, 120);
    } catch {
      return String(review.artifact);
    }
  });

  function handleWorkflowClick(event: MouseEvent): void {
    event.stopPropagation();
    navigate(`/ui/workflows/${encodeURIComponent(review.workflowId)}`);
  }
</script>

<Card title={review.reviewType}>
  <div class="review-item-content">
    <div class="review-item-row">
      <span class="review-item-label">Workflow</span>
      <button class="review-item-link font-mono" onclick={handleWorkflowClick} type="button">
        {truncate(review.workflowId, 20)}
      </button>
    </div>

    <div class="review-item-row">
      <span class="review-item-label">Artifact</span>
      <span class="review-item-value font-mono">{artifactPreview}</span>
    </div>

    {#if review.reviewers.length > 0}
      <div class="review-item-row">
        <span class="review-item-label">Reviewers</span>
        <div class="review-item-reviewers">
          {#each review.reviewers as reviewer}
            <Badge label={reviewer} size="xs" />
          {/each}
        </div>
      </div>
    {/if}

    <div class="review-item-row">
      <span class="review-item-label">Created</span>
      <span class="review-item-value text-muted">{formatRelativeTime(review.createdAt)}</span>
    </div>

    <div class="review-item-actions">
      <Button
        variant="primary"
        size="sm"
        label="Approve"
        loading={isSubmitting}
        disabled={isAnySubmitting}
        onclick={() => onApprove(review.reviewId)}
      />
      <Button
        variant="danger"
        size="sm"
        label="Reject"
        loading={isSubmitting}
        disabled={isAnySubmitting}
        onclick={() => onReject(review.reviewId)}
      />
    </div>
  </div>
</Card>

<style>
  .review-item-content {
    display: flex;
    flex-direction: column;
    gap: var(--space-2, 0.5rem);
  }

  .review-item-row {
    display: flex;
    align-items: baseline;
    gap: var(--space-2, 0.5rem);
    font-size: var(--text-sm, 0.875rem);
  }

  .review-item-label {
    color: var(--text-muted, #6b7280);
    min-width: 5rem;
    flex-shrink: 0;
    font-size: var(--text-xs, 0.75rem);
    font-weight: var(--font-medium, 500);
  }

  .review-item-value {
    word-break: break-all;
    font-size: var(--text-xs, 0.75rem);
  }

  .review-item-link {
    font-size: var(--text-xs, 0.75rem);
    color: var(--link, var(--accent, #2563eb));
    text-decoration: underline;
    text-underline-offset: 0.15em;
    cursor: pointer;
  }

  .review-item-link:hover {
    color: var(--accent-hover, #4f46e5);
  }

  .review-item-reviewers {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-1, 0.25rem);
  }

  .review-item-actions {
    display: flex;
    gap: var(--space-2, 0.5rem);
    margin-top: var(--space-2, 0.5rem);
  }
</style>
