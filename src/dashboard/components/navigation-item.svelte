<script lang="ts" module>
  import type { Snippet } from 'svelte';
  import type { HTMLAnchorAttributes } from 'svelte/elements';

  export type NavigationItemProps = HTMLAnchorAttributes & {
    href: string;
    children?: Snippet;
    /** Whether this navigation item is currently active */
    active?: boolean;
  };
</script>

<script lang="ts">
  import { cn } from '../utilities/class-names.ts';

  let {
    href,
    class: className,
    children,
    active = false,
    ...rest
  }: NavigationItemProps = $props();
</script>

<a
  {href}
  class={cn('navigation-item', className)}
  data-active={active}
  aria-current={active ? 'page' : undefined}
  {...rest}
>
  {@render children?.()}
</a>

<style>
  .navigation-item {
    display: inline-flex;
    align-items: center;
    gap: var(--space-3, 0.75rem);
    min-height: 2rem;
    padding-inline: var(--space-3, 0.75rem);
    padding-block: var(--space-1-5, 0.375rem);
    font-size: var(--text-sm, 0.875rem);
    font-weight: var(--font-medium, 500);
    text-decoration: none;
    border-bottom: 2px solid transparent;
    transition: color var(--duration-fast, 150ms) var(--ease-standard, ease);
  }

  .navigation-item:focus-visible {
    outline: 2px solid transparent;
    box-shadow:
      0 0 0 var(--ring-offset, 2px) var(--ring-offset-color, var(--surface, #fff)),
      0 0 0 calc(var(--ring-offset, 2px) + var(--ring-width, 2px))
        var(--control-ring-color, #6366f1);
  }

  .navigation-item[data-active='true'] {
    color: var(--text, #111827);
    border-bottom-color: var(--accent, #6366f1);
  }

  .navigation-item[data-active='false'] {
    color: var(--text-muted, #6b7280);
  }

  .navigation-item[data-active='false']:hover {
    color: var(--text, #111827);
  }
</style>
