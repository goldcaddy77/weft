<script lang="ts" module>
  import type { HTMLAttributes } from 'svelte/elements';

  export type SkeletonVariant = 'text' | 'circular' | 'rectangular' | 'rounded';
  export type SkeletonAnimation = 'shimmer' | 'pulse' | false;

  export type SkeletonProps = Omit<HTMLAttributes<HTMLDivElement>, 'class'> & {
    class?: string;
    variant?: SkeletonVariant;
    width?: string | number;
    height?: string | number;
    animation?: SkeletonAnimation;
  };
</script>

<script lang="ts">
  import { cn } from '../utilities/class-names.js';

  let {
    class: className,
    variant = 'text',
    width,
    height,
    animation = 'shimmer',
    style,
    ...rest
  }: SkeletonProps = $props();

  const widthValue = $derived(typeof width === 'number' ? `${width}px` : width);
  const heightValue = $derived(typeof height === 'number' ? `${height}px` : height);
  const animationAttribute = $derived(animation === false ? 'false' : animation);

  const variantDefaults = $derived.by(() => {
    switch (variant) {
      case 'circular':
        return {
          width: widthValue ?? '2.5rem',
          height: heightValue ?? '2.5rem',
          radius: '50%',
        };
      case 'rectangular':
        return {
          width: widthValue ?? '100%',
          height: heightValue ?? '1rem',
          radius: 'var(--radius-sm, 0.25rem)',
        };
      case 'rounded':
        return {
          width: widthValue ?? '100%',
          height: heightValue ?? '1rem',
          radius: 'var(--radius-lg, 0.75rem)',
        };
      case 'text':
      default:
        return {
          width: widthValue ?? '100%',
          height: heightValue ?? '1em',
          radius: 'var(--radius-sm, 0.25rem)',
        };
    }
  });
</script>

<div
  class={cn('skeleton', className)}
  data-variant={variant}
  data-animation={animationAttribute}
  style:--skeleton-width={variantDefaults.width}
  style:--skeleton-height={variantDefaults.height}
  style:--skeleton-radius={variantDefaults.radius}
  style={style || undefined}
  aria-hidden="true"
  {...rest}
></div>

<style>
  .skeleton {
    width: var(--skeleton-width);
    height: var(--skeleton-height);
    border-radius: var(--skeleton-radius);
    background: linear-gradient(
      90deg,
      var(--skeleton-base, color-mix(in srgb, var(--surface-inset, #e5e7eb), transparent 0%)) 0%,
      var(--skeleton-highlight, color-mix(in srgb, var(--surface-inset, #e5e7eb), white 40%)) 50%,
      var(--skeleton-base, color-mix(in srgb, var(--surface-inset, #e5e7eb), transparent 0%)) 100%
    );
    background-size: 200% 100%;
    contain: strict;
  }

  .skeleton[data-animation='shimmer'] {
    animation: skeleton-shimmer 1.5s ease-in-out infinite;
    animation-delay: var(--skeleton-delay, 0s);
  }

  .skeleton[data-animation='pulse'] {
    background: var(--skeleton-base, var(--surface-inset, #e5e7eb));
    animation: skeleton-pulse 1.5s ease-in-out infinite;
    animation-delay: var(--skeleton-delay, 0s);
  }

  .skeleton[data-animation='false'] {
    background: var(--skeleton-base, var(--surface-inset, #e5e7eb));
    animation: none;
  }

  @keyframes skeleton-shimmer {
    0% {
      background-position: 200% 0;
    }
    100% {
      background-position: -200% 0;
    }
  }

  @keyframes skeleton-pulse {
    0%,
    100% {
      opacity: 1;
    }
    50% {
      opacity: 0.5;
    }
  }

  @media (prefers-reduced-motion: reduce) {
    .skeleton[data-animation='shimmer'],
    .skeleton[data-animation='pulse'] {
      animation: none;
      background: var(--skeleton-base, var(--surface-inset, #e5e7eb));
    }
  }
</style>
