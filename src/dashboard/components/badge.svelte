<script lang="ts" module>
  import type { Snippet } from 'svelte';
  import type { HTMLAttributes } from 'svelte/elements';

  export type BadgeVariant = 'default' | 'accent' | 'success' | 'warning' | 'danger';
  export type BadgeSize = 'xs' | 'sm';

  export type BadgeProps = HTMLAttributes<HTMLSpanElement> & {
    variant?: BadgeVariant;
    size?: BadgeSize;
    children?: Snippet;
    label?: string;
    /** HTML string icon to render before the label */
    icon?: string;
    code?: boolean;
    truncate?: number;
  };
</script>

<script lang="ts">
  import { cn } from '../utilities/class-names.ts';
  import { truncate as truncateText } from '../utilities/truncate.ts';

  let {
    variant = 'default',
    size = 'sm',
    class: className,
    children,
    label,
    icon,
    code = false,
    truncate,
    ...rest
  }: BadgeProps = $props();

  const displayValue = $derived.by(() => {
    if (!label) return null;
    if (truncate && label.length > truncate) {
      return truncateText(label, truncate);
    }
    return label;
  });
</script>

<span
  class={cn('badge', className)}
  data-code={code}
  data-variant={variant}
  data-size={size}
  title={truncate && label && label.length > truncate ? label : undefined}
  {...rest}
>
  {#if icon}
    <span class="badge-icon" aria-hidden="true">{@html icon}</span>
  {/if}
  {#if children}{@render children()}{:else if displayValue}{displayValue}{/if}
</span>

<style>
  .badge {
    display: inline-flex;
    align-items: center;
    gap: var(--space-1, 0.25rem);
    padding: var(--space-0-5, 0.125rem) var(--space-2, 0.5rem);
    font-size: var(--text-xs, 0.75rem);
    font-weight: var(--font-medium, 500);
    line-height: 1.25;
    border-radius: var(--radius-sm, 0.25rem);
    border-width: 1px;
    border-style: solid;
    white-space: nowrap;
    transition: background-color var(--duration-fast, 150ms) var(--ease-standard, ease);
  }

  .badge[data-size='xs'] {
    font-size: var(--text-3xs, 0.625rem);
    padding: 0 var(--space-1, 0.25rem);
    height: 1rem;
  }

  .badge[data-code='true'] {
    font-family: var(--font-mono, monospace);
    user-select: all;
  }

  .badge-icon {
    display: inline-flex;
    align-items: center;
    flex-shrink: 0;
  }

  .badge-icon :global(svg) {
    width: 0.75rem;
    height: 0.75rem;
  }

  /* Variant: default */
  .badge[data-variant='default'] {
    background: var(--surface-inset, #f3f4f6);
    color: var(--text, #111827);
    border-color: var(--border-muted, #e5e7eb);
  }

  /* Variant: accent */
  .badge[data-variant='accent'] {
    background: color-mix(in oklch, var(--secondary, #6366f1), transparent 85%);
    color: var(--secondary, #6366f1);
    border-color: color-mix(in oklch, var(--secondary, #6366f1), transparent 60%);
  }

  /* Variant: success */
  .badge[data-variant='success'] {
    background: var(--success-bg, #ecfdf5);
    color: var(--success, #059669);
    border-color: var(--success-bg-strong, #a7f3d0);
  }

  /* Variant: warning */
  .badge[data-variant='warning'] {
    background: var(--warning-bg, #fffbeb);
    color: var(--warning, #d97706);
    border-color: var(--warning-bg-strong, #fde68a);
  }

  /* Variant: danger */
  .badge[data-variant='danger'] {
    background: var(--danger-bg, #fef2f2);
    color: var(--danger, #dc2626);
    border-color: var(--danger-bg-strong, #fecaca);
  }
</style>
