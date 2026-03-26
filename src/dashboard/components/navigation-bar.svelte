<script lang="ts" module>
  import type { Snippet } from 'svelte';
  import type { HTMLAttributes } from 'svelte/elements';

  export type NavigationBarProps = HTMLAttributes<HTMLElement> & {
    /** Left side content (e.g., logo) */
    start?: Snippet;
    /** Navigation items */
    children?: Snippet;
    /** Right side content (e.g., user menu) */
    end?: Snippet;
  };
</script>

<script lang="ts">
  import { cn } from '../utilities/class-names.ts';

  let { class: className, start, children, end, ...rest }: NavigationBarProps = $props();
</script>

<nav class={cn('navigation', className)} aria-label="Main navigation" {...rest}>
  {#if start}
    <div class="navigation-start">
      {@render start()}
    </div>
  {/if}

  <div class="navigation-items">
    {@render children?.()}
  </div>

  {#if end}
    <div class="navigation-end">
      {@render end()}
    </div>
  {/if}
</nav>

<style>
  .navigation {
    position: relative;
    display: flex;
    align-items: center;
    justify-content: space-between;
    height: 3.5rem;
  }

  .navigation-start {
    display: flex;
    align-items: center;
  }

  .navigation-items {
    display: flex;
    align-items: center;
    gap: var(--space-1, 0.25rem);
  }

  .navigation-end {
    display: flex;
    align-items: center;
    gap: var(--space-2, 0.5rem);
  }
</style>
