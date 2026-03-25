<script lang="ts" module>
  import type { Snippet } from 'svelte';
  import type { HTMLAttributes } from 'svelte/elements';

  export type EmptyStateProps = HTMLAttributes<HTMLDivElement> & {
    /** HTML string icon */
    icon?: string;
    title: string;
    description?: string;
    action?: Snippet;
  };
</script>

<script lang="ts">
  import { cn } from '../utilities/class-names.js';

  let {
    icon,
    title,
    description,
    action,
    class: className,
    ...rest
  }: EmptyStateProps = $props();
</script>

<div class="empty-state-container">
  <div class={cn('empty-state', className)} {...rest}>
    {#if icon}
      <div class="empty-state-icon" aria-hidden="true">
        {@html icon}
      </div>
    {/if}
    <h3 class="empty-state-title">{title}</h3>
    {#if description}
      <p class="empty-state-description">{description}</p>
    {/if}
    {#if action}
      <div class="empty-state-action">
        {@render action()}
      </div>
    {/if}
  </div>
</div>

<style>
  .empty-state-container {
    container-type: inline-size;
  }

  .empty-state {
    text-align: center;
    padding-block: var(--space-8, 2rem);
  }

  .empty-state-icon {
    display: flex;
    justify-content: center;
    color: var(--text-disabled, #9ca3af);
    margin-bottom: var(--space-2, 0.5rem);
  }

  .empty-state-icon :global(svg) {
    width: 2rem;
    height: 2rem;
  }

  .empty-state-title {
    font-weight: var(--font-medium, 500);
    color: var(--text-muted, #6b7280);
    font-size: var(--text-sm, 0.875rem);
    margin-bottom: var(--space-1, 0.25rem);
  }

  .empty-state-description {
    color: var(--text-muted, #6b7280);
    font-size: var(--text-sm, 0.875rem);
  }

  .empty-state-action {
    margin-top: var(--space-4, 1rem);
  }

  @container (max-width: 400px) {
    .empty-state {
      padding-block: var(--space-6, 1.5rem);
    }

    .empty-state-description {
      display: none;
    }

    .empty-state-action {
      margin-top: var(--space-3, 0.75rem);
    }
  }
</style>
