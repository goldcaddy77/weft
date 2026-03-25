<script lang="ts" module>
  import type { Snippet } from 'svelte';
  import type { HTMLAttributes } from 'svelte/elements';

  export type DataListVariant = 'default' | 'compact';

  export type DataListProps<T = unknown> = Omit<HTMLAttributes<HTMLDivElement>, 'children'> & {
    variant?: DataListVariant;
    items: T[];
    getKey: (item: T) => string | number;
    item: Snippet<[item: T, index: number, key: string | number, items: T[]]>;
    empty?: Snippet;
  };
</script>

<script lang="ts" generics="T">
  import { cn } from '../utilities/class-names.js';

  let {
    class: className,
    items,
    getKey,
    item,
    empty,
    variant = 'default',
    ...rest
  }: DataListProps<T> = $props();
</script>

<div class={cn('data-list', className)} data-variant={variant} {...rest}>
  {#if items.length > 0}
    {#each items as itemData, index (getKey(itemData))}
      {@render item(itemData, index, getKey(itemData), items)}
    {/each}
  {:else if empty}
    {@render empty()}
  {/if}
</div>

<style>
  .data-list[data-variant='compact'] {
    background: color-mix(
      in oklch,
      var(--surface-overlay, var(--surface-raised, #fff)),
      transparent 50%
    );
    border-radius: var(--radius-lg, 0.75rem);
    padding: var(--space-4, 1rem);
    display: flex;
    flex-direction: column;
    gap: var(--space-3, 0.75rem);
  }
</style>
