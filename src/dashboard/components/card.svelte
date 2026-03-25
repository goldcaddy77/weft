<script lang="ts" module>
  import type { Snippet } from 'svelte';
  import type { HTMLAttributes } from 'svelte/elements';

  type BaseCardProps = HTMLAttributes<HTMLDivElement> & {
    children?: Snippet;
    footer?: Snippet;
    actions?: Snippet;
    flush?: boolean;
  };

  type CardWithHeader = BaseCardProps & {
    header: Snippet;
    title?: never;
    description?: never;
    icon?: never;
    count?: never;
    actions?: never;
  };

  type CardWithTitleDescription = BaseCardProps & {
    header?: never;
    title?: string;
    description?: string;
    /** HTML string icon to display before the title */
    icon?: string;
    count?: number;
  };

  export type CardProps = CardWithHeader | CardWithTitleDescription;
</script>

<script lang="ts">
  import { cn } from '../utilities/class-names.ts';

  let {
    class: className,
    children,
    title,
    description,
    icon,
    count,
    header,
    footer,
    actions,
    flush = false,
    ...rest
  }: CardProps = $props();

  const hasHeader = $derived(title || description || header || actions);
</script>

<div class={cn('card', className)} data-flush={flush} {...rest}>
  {#if hasHeader}
    <div class="card-header">
      {#if header}
        {@render header()}
      {:else}
        <div class="card-header-main">
          {#if icon}
            <span class="card-icon" aria-hidden="true">{@html icon}</span>
          {/if}
          <div class="card-title-group">
            <div class="card-title-row">
              {#if title}
                <h3 class="card-title">{title}</h3>
              {/if}
              {#if count != null}
                <span class="card-count">{count}</span>
              {/if}
            </div>
            {#if description}
              <p class="card-description">{description}</p>
            {/if}
          </div>
        </div>
        {#if actions}
          <div class="card-header-actions">
            {@render actions()}
          </div>
        {/if}
      {/if}
    </div>
  {/if}

  {#if children}
    <div class="card-content">
      {@render children()}
    </div>
  {/if}

  {#if footer}
    <div class="card-footer">
      {@render footer()}
    </div>
  {/if}
</div>

<style>
  .card {
    border-radius: var(--radius-lg, 0.75rem);
    background: var(--surface-raised, #fff);
    border: 1px solid var(--border-muted, #e5e7eb);
    color: var(--text, #111827);
    box-shadow: var(--shadow-sm, 0 1px 2px 0 rgb(0 0 0 / 0.05));
  }

  .card-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--space-3, 0.75rem);
    padding: var(--space-3, 0.75rem) var(--space-4, 1rem);
    border-bottom: 1px solid var(--border-muted, #e5e7eb);
  }

  .card-header-main {
    display: flex;
    align-items: flex-start;
    gap: var(--space-3, 0.75rem);
    flex: 1;
    min-width: 0;
  }

  .card-icon {
    display: inline-flex;
    flex-shrink: 0;
    margin-top: 2px;
    color: var(--text-disabled, #9ca3af);
  }

  .card-icon :global(svg) {
    width: 1rem;
    height: 1rem;
  }

  .card-title-group {
    display: flex;
    flex-direction: column;
    gap: var(--space-1, 0.25rem);
    flex: 1;
    min-width: 0;
  }

  .card-title-row {
    display: flex;
    align-items: center;
    gap: var(--space-2, 0.5rem);
  }

  .card-title {
    font-size: var(--text-sm, 0.875rem);
    font-weight: var(--font-medium, 500);
    color: var(--text-muted, #6b7280);
    flex-shrink: 0;
  }

  .card-count {
    display: inline-flex;
    align-items: center;
    padding: var(--space-0-5, 0.125rem) var(--space-2, 0.5rem);
    font-size: var(--text-xs, 0.75rem);
    font-weight: var(--font-medium, 500);
    line-height: 1.25;
    border-radius: var(--radius-sm, 0.25rem);
    background: var(--surface-inset, #f3f4f6);
    color: var(--text, #111827);
    border: 1px solid var(--border-muted, #e5e7eb);
  }

  .card-header-actions {
    display: flex;
    align-items: center;
    gap: var(--space-2, 0.5rem);
    flex-shrink: 0;
  }

  .card-description {
    font-size: var(--text-sm, 0.875rem);
    color: var(--text-subtle, #9ca3af);
  }

  .card-content {
    padding: var(--space-4, 1rem);
  }

  .card[data-flush='true'] .card-content {
    padding: 0;
  }

  .card-footer {
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 0 var(--space-4, 1rem) var(--space-3, 0.75rem);
  }
</style>
