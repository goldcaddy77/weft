<script lang="ts">
  import { getContext } from 'svelte';

  import type { ApiClient, ReviewRequest } from '../api-client.ts';
  import { inbox } from '../icons.ts';
  import Page from '../components/page.svelte';
  import Skeleton from '../components/skeleton.svelte';
  import EmptyState from '../components/empty-state.svelte';
  import Alert from '../components/alert.svelte';
  import ReviewItem from '../fragments/review-item.svelte';

  const apiClient = getContext<ApiClient>('api-client');

  interface ToastContext {
    addToast: (message: string, variant: 'info' | 'success' | 'error') => void;
  }

  const { addToast } = getContext<ToastContext>('toasts');

  // ---------------------------------------------------------------------------
  // Data state
  // ---------------------------------------------------------------------------

  let reviews: ReviewRequest[] = $state([]);
  let loading = $state(true);
  let error: string | null = $state(null);

  // ---------------------------------------------------------------------------
  // Fetching
  // ---------------------------------------------------------------------------

  async function fetchReviews(): Promise<void> {
    try {
      reviews = await apiClient.listPendingReviews();
      error = null;
    } catch (fetchError) {
      error = fetchError instanceof Error ? fetchError.message : String(fetchError);
    } finally {
      loading = false;
    }
  }

  $effect(() => {
    loading = true;
    fetchReviews();

    let interval: ReturnType<typeof setInterval> | null = null;

    function startPolling(): void {
      interval = setInterval(() => {
        if (!document.hidden) {
          fetchReviews();
        }
      }, 5_000);
    }

    function handleVisibility(): void {
      if (!document.hidden && interval === null) {
        fetchReviews();
        startPolling();
      } else if (document.hidden && interval !== null) {
        clearInterval(interval);
        interval = null;
      }
    }

    startPolling();
    document.addEventListener('visibilitychange', handleVisibility);

    return () => {
      if (interval !== null) clearInterval(interval);
      document.removeEventListener('visibilitychange', handleVisibility);
    };
  });

  // ---------------------------------------------------------------------------
  // Actions
  // ---------------------------------------------------------------------------

  async function handleApprove(reviewId: string): Promise<void> {
    const review = reviews.find((r) => r.reviewId === reviewId);
    if (!review) return;

    try {
      await apiClient.submitReviewDecision(reviewId, review.workflowId, {
        decision: 'approved',
        reviewer: 'dashboard-user',
      });
      addToast('Review approved', 'success');
      reviews = reviews.filter((r) => r.reviewId !== reviewId);
    } catch (approveError) {
      const message = approveError instanceof Error ? approveError.message : String(approveError);
      addToast(`Failed to approve: ${message}`, 'error');
    }
  }

  async function handleReject(reviewId: string): Promise<void> {
    const review = reviews.find((r) => r.reviewId === reviewId);
    if (!review) return;

    try {
      await apiClient.submitReviewDecision(reviewId, review.workflowId, {
        decision: 'rejected',
        reviewer: 'dashboard-user',
      });
      addToast('Review rejected', 'success');
      reviews = reviews.filter((r) => r.reviewId !== reviewId);
    } catch (rejectError) {
      const message = rejectError instanceof Error ? rejectError.message : String(rejectError);
      addToast(`Failed to reject: ${message}`, 'error');
    }
  }
</script>

<Page title="Reviews">
  {#if loading}
    <div class="review-queue-loading">
      {#each Array(3) as _}
        <Skeleton variant="rounded" height="8rem" />
      {/each}
    </div>
  {:else if error}
    <Alert variant="danger" title="Failed to load reviews" description={error} />
  {:else if reviews.length === 0}
    <EmptyState
      icon={inbox(32)}
      title="No pending reviews"
      description="There are no reviews awaiting a decision."
    />
  {:else}
    <div class="review-queue-list">
      {#each reviews as review (review.reviewId)}
        <ReviewItem {review} onApprove={handleApprove} onReject={handleReject} />
      {/each}
    </div>
  {/if}
</Page>

<style>
  .review-queue-loading {
    display: flex;
    flex-direction: column;
    gap: var(--space-3, 0.75rem);
  }

  .review-queue-list {
    display: flex;
    flex-direction: column;
    gap: var(--space-3, 0.75rem);
  }
</style>
