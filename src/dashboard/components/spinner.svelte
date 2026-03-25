<script lang="ts" module>
  import type { HTMLAttributes } from 'svelte/elements';

  export type SpinnerProps = HTMLAttributes<HTMLSpanElement>;
</script>

<script lang="ts">
  import { cn } from '../utilities/class-names.js';

  let { class: className, ...rest }: SpinnerProps = $props();
</script>

<span class={cn('spinner', className)} role="status" aria-label="Loading..." {...rest}>
  <span class="sr-only">Loading...</span>
</span>

<style>
  .spinner {
    display: inline-block;
    width: var(--spinner-size, 1.5rem);
    height: var(--spinner-size, 1.5rem);
    border: 2px solid var(--spinner-track, color-mix(in srgb, currentColor 25%, transparent));
    border-top-color: var(--spinner-indicator, currentColor);
    border-radius: 50%;
    vertical-align: -0.125em;
    animation: spin var(--duration-slow, 1s) linear infinite;
  }

  @keyframes spin {
    to {
      transform: rotate(360deg);
    }
  }

  @media (prefers-reduced-motion: reduce) {
    .spinner {
      animation: none;
      border-top-color: var(--border, #ccc);
      opacity: 0.5;
    }
  }
</style>
