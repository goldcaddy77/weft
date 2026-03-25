<script lang="ts" module>
  import type { HTMLAttributes } from 'svelte/elements';

  export type PaginationProps = Omit<HTMLAttributes<HTMLElement>, 'class'> & {
    class?: string;
    /** Current page (1-indexed) */
    page: number;
    /** Total number of pages */
    totalPages: number;
    /** Pages to show on each side of current */
    siblings?: number;
    /** Pages to always show at start/end */
    boundaries?: number;
    /** Callback for page changes */
    onPageChange?: (page: number) => void;
  };
</script>

<script lang="ts">
  import { cn } from '../utilities/class-names.ts';

  let {
    class: className,
    page: currentPage,
    totalPages,
    siblings = 1,
    boundaries = 1,
    onPageChange,
    'aria-label': ariaLabel = 'Pagination',
    ...rest
  }: PaginationProps = $props();

  type PageItem = number | 'ellipsis-start' | 'ellipsis-end';

  const pageRange = $derived.by((): PageItem[] => {
    const pages: PageItem[] = [];

    if (totalPages <= 1) return pages;

    const effectiveBoundaries = Math.min(boundaries, Math.floor(totalPages / 2));
    const totalVisible = effectiveBoundaries * 2 + siblings * 2 + 3;

    if (totalPages <= totalVisible) {
      for (let i = 1; i <= totalPages; i++) pages.push(i);
      return pages;
    }

    const firstBoundaryEnd = Math.min(effectiveBoundaries, totalPages);
    for (let i = 1; i <= firstBoundaryEnd; i++) {
      pages.push(i);
    }

    const leftSibling = Math.max(currentPage - siblings, effectiveBoundaries + 2);
    const rightSibling = Math.min(currentPage + siblings, totalPages - effectiveBoundaries - 1);

    if (leftSibling > effectiveBoundaries + 2) {
      pages.push('ellipsis-start');
    } else if (leftSibling === effectiveBoundaries + 2) {
      pages.push(effectiveBoundaries + 1);
    }

    for (let i = leftSibling; i <= rightSibling; i++) {
      pages.push(i);
    }

    if (rightSibling < totalPages - effectiveBoundaries - 1) {
      pages.push('ellipsis-end');
    } else if (rightSibling === totalPages - effectiveBoundaries - 1) {
      pages.push(totalPages - effectiveBoundaries);
    }

    const lastBoundaryStart = Math.max(1, totalPages - effectiveBoundaries + 1);
    for (let i = lastBoundaryStart; i <= totalPages; i++) {
      if (!pages.includes(i)) {
        pages.push(i);
      }
    }

    return pages;
  });

  const canGoPrevious = $derived(currentPage > 1);
  const canGoNext = $derived(currentPage < totalPages);

  function handlePageClick(page: number) {
    onPageChange?.(page);
  }
</script>

{#if totalPages > 1}
  <nav class={cn('pagination', className)} aria-label={ariaLabel} {...rest}>
    <button
      type="button"
      class="pagination-button"
      aria-label="Go to previous page"
      disabled={!canGoPrevious}
      onclick={() => handlePageClick(currentPage - 1)}
    >
      <svg
        xmlns="http://www.w3.org/2000/svg"
        width="16"
        height="16"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="2"
        stroke-linecap="round"
        stroke-linejoin="round"
        aria-hidden="true"
      >
        <polyline points="15 18 9 12 15 6" />
      </svg>
    </button>

    <div class="pagination-pages">
      {#each pageRange as item (typeof item === 'string' ? item : `page-${item}`)}
        {#if typeof item === 'string'}
          <span class="pagination-ellipsis" aria-hidden="true">...</span>
        {:else}
          <button
            type="button"
            class="pagination-page"
            aria-label={item === currentPage
              ? `Page ${item}, current page`
              : `Go to page ${item}`}
            aria-current={item === currentPage ? 'page' : undefined}
            data-current={item === currentPage}
            onclick={() => handlePageClick(item)}
          >
            {item}
          </button>
        {/if}
      {/each}
    </div>

    <button
      type="button"
      class="pagination-button"
      aria-label="Go to next page"
      disabled={!canGoNext}
      onclick={() => handlePageClick(currentPage + 1)}
    >
      <svg
        xmlns="http://www.w3.org/2000/svg"
        width="16"
        height="16"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="2"
        stroke-linecap="round"
        stroke-linejoin="round"
        aria-hidden="true"
      >
        <polyline points="9 18 15 12 9 6" />
      </svg>
    </button>
  </nav>
{/if}

<style>
  .pagination {
    display: flex;
    align-items: center;
    gap: var(--space-1, 0.25rem);
  }

  .pagination-button,
  .pagination-page {
    display: flex;
    align-items: center;
    justify-content: center;
    min-width: 2.5rem;
    min-height: 2.5rem;
    padding: var(--space-2, 0.5rem);
    border-radius: var(--radius-md, 0.375rem);
    font-size: var(--text-sm, 0.875rem);
    font-weight: var(--font-medium, 500);
    color: var(--text, #111827);
    background: transparent;
    border: 1px solid transparent;
    text-decoration: none;
    cursor: pointer;
    transition:
      background-color var(--duration-fast, 150ms) var(--ease-standard, ease),
      border-color var(--duration-fast, 150ms) var(--ease-standard, ease);
  }

  .pagination-button:hover:not(:disabled),
  .pagination-page:hover:not([data-current='true']) {
    background: var(--surface-hover, #f9fafb);
  }

  .pagination-button:focus-visible,
  .pagination-page:focus-visible {
    outline: 2px solid transparent;
    box-shadow:
      0 0 0 var(--ring-offset, 2px) var(--ring-offset-color, var(--surface, #fff)),
      0 0 0 calc(var(--ring-offset, 2px) + var(--ring-width, 2px))
        var(--control-ring-color, #6366f1);
  }

  .pagination-button:disabled {
    color: var(--text-disabled, #9ca3af);
    cursor: not-allowed;
    pointer-events: none;
  }

  .pagination-page[data-current='true'] {
    background: var(--accent, #6366f1);
    color: var(--accent-contrast, #fff);
    border-color: var(--accent, #6366f1);
  }

  .pagination-pages {
    display: flex;
    align-items: center;
    gap: var(--space-1, 0.25rem);
  }

  .pagination-ellipsis {
    padding: var(--space-2, 0.5rem);
    color: var(--text-muted, #6b7280);
    user-select: none;
  }

  @media (max-width: 480px) {
    .pagination-pages {
      display: none;
    }
  }
</style>
