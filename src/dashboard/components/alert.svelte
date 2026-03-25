<script lang="ts" module>
  import type { Snippet } from 'svelte';
  import type { HTMLAttributes } from 'svelte/elements';

  export type AlertVariant = 'info' | 'success' | 'warning' | 'danger';

  export type AlertProps = HTMLAttributes<HTMLDivElement> & {
    variant?: AlertVariant;
    title?: string;
    description?: string;
    children?: Snippet;
    dismissible?: boolean;
    onDismiss?: () => void;
  };
</script>

<script lang="ts">
  import { cn } from '../utilities/class-names.js';

  let {
    variant = 'info',
    class: className,
    title,
    description,
    children,
    dismissible = false,
    onDismiss,
    ...rest
  }: AlertProps = $props();

  let visible = $state(true);

  function handleDismiss() {
    visible = false;
    onDismiss?.();
  }
</script>

{#if visible}
  <div
    class={cn('alert', className)}
    data-variant={variant}
    role="alert"
    aria-live="polite"
    {...rest}
  >
    <div class="alert-icon" aria-hidden="true">
      {#if variant === 'info'}
        <svg viewBox="0 0 20 20" fill="currentColor">
          <path
            fill-rule="evenodd"
            d="M18 10a8 8 0 11-16 0 8 8 0 0116 0zm-7-4a1 1 0 11-2 0 1 1 0 012 0zM9 9a.75.75 0 000 1.5h.253a.25.25 0 01.244.304l-.459 2.066A1.75 1.75 0 0010.747 15H11a.75.75 0 000-1.5h-.253a.25.25 0 01-.244-.304l.459-2.066A1.75 1.75 0 009.253 9H9z"
            clip-rule="evenodd"
          />
        </svg>
      {:else if variant === 'success'}
        <svg viewBox="0 0 20 20" fill="currentColor">
          <path
            fill-rule="evenodd"
            d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.857-9.809a.75.75 0 00-1.214-.882l-3.483 4.79-1.88-1.88a.75.75 0 10-1.06 1.061l2.5 2.5a.75.75 0 001.137-.089l4-5.5z"
            clip-rule="evenodd"
          />
        </svg>
      {:else if variant === 'warning'}
        <svg viewBox="0 0 20 20" fill="currentColor">
          <path
            fill-rule="evenodd"
            d="M8.485 2.495c.673-1.167 2.357-1.167 3.03 0l6.28 10.875c.673 1.167-.17 2.625-1.516 2.625H3.72c-1.347 0-2.189-1.458-1.515-2.625L8.485 2.495zM10 5a.75.75 0 01.75.75v3.5a.75.75 0 01-1.5 0v-3.5A.75.75 0 0110 5zm0 9a1 1 0 100-2 1 1 0 000 2z"
            clip-rule="evenodd"
          />
        </svg>
      {:else if variant === 'danger'}
        <svg viewBox="0 0 20 20" fill="currentColor">
          <path
            fill-rule="evenodd"
            d="M18 10a8 8 0 11-16 0 8 8 0 0116 0zm-8-5a.75.75 0 01.75.75v4.5a.75.75 0 01-1.5 0v-4.5A.75.75 0 0110 5zm0 10a1 1 0 100-2 1 1 0 000 2z"
            clip-rule="evenodd"
          />
        </svg>
      {/if}
    </div>
    <div class="alert-content">
      {#if title}
        <h5 class="alert-title">{title}</h5>
      {/if}
      {#if description}
        <p class="alert-description">{description}</p>
      {:else if children}
        <div class="alert-description">
          {@render children()}
        </div>
      {/if}
    </div>
    {#if dismissible}
      <button type="button" class="alert-close" onclick={handleDismiss} aria-label="Dismiss alert">
        <svg
          class="alert-close-icon"
          xmlns="http://www.w3.org/2000/svg"
          viewBox="0 0 20 20"
          fill="currentColor"
          aria-hidden="true"
        >
          <path
            d="M6.28 5.22a.75.75 0 00-1.06 1.06L8.94 10l-3.72 3.72a.75.75 0 101.06 1.06L10 11.06l3.72 3.72a.75.75 0 101.06-1.06L11.06 10l3.72-3.72a.75.75 0 00-1.06-1.06L10 8.94 6.28 5.22z"
          />
        </svg>
      </button>
    {/if}
  </div>
{/if}

<style>
  .alert {
    position: relative;
    display: flex;
    align-items: flex-start;
    gap: var(--space-3, 0.75rem);
    padding: var(--space-4, 1rem);
    border-radius: var(--radius-lg, 0.75rem);
    border-width: 1px;
    border-style: solid;
    transition: background-color var(--duration-fast, 150ms) var(--ease-standard, ease);
  }

  .alert-icon {
    flex-shrink: 0;
    width: 1.25rem;
    height: 1.25rem;
    margin-top: 1px;
  }

  .alert-icon svg {
    width: 100%;
    height: 100%;
  }

  .alert-content {
    flex: 1;
    min-width: 0;
  }

  .alert-title {
    font-size: var(--text-sm, 0.875rem);
    font-weight: var(--font-semibold, 600);
    margin-bottom: var(--space-1, 0.25rem);
  }

  .alert-description {
    font-size: var(--text-sm, 0.875rem);
    margin-bottom: var(--space-3, 0.75rem);
    word-break: break-word;
  }

  .alert-description:last-child {
    margin-bottom: 0;
  }

  .alert-close {
    position: absolute;
    right: var(--space-3, 0.75rem);
    top: var(--space-3, 0.75rem);
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 1.5rem;
    height: 1.5rem;
    padding: var(--space-0-5, 0.125rem);
    border-radius: var(--radius-md, 0.375rem);
    border: none;
    background: transparent;
    cursor: pointer;
    color: inherit;
    transition:
      background-color var(--duration-fast, 150ms) var(--ease-standard, ease),
      box-shadow var(--duration-fast, 150ms) var(--ease-standard, ease);
  }

  .alert-close::after {
    content: '';
    position: absolute;
    top: 50%;
    left: 50%;
    width: 44px;
    height: 44px;
    transform: translate(-50%, -50%);
  }

  .alert-close:focus-visible {
    outline: 2px solid transparent;
    box-shadow:
      0 0 0 var(--ring-offset, 2px) var(--ring-offset-color, var(--surface, #fff)),
      0 0 0 calc(var(--ring-offset, 2px) + var(--ring-width, 2px)) var(--alert-ring);
  }

  .alert-close-icon {
    width: 1rem;
    height: 1rem;
  }

  /* Variant: info */
  .alert[data-variant='info'] {
    --alert-ring: var(--info, #3b82f6);
    background-color: light-dark(
      oklch(from var(--info, #3b82f6) 96.5% 0.015 h),
      oklch(from var(--info, #3b82f6) 20% 0.03 h)
    );
    border-color: light-dark(
      oklch(from var(--info, #3b82f6) 85% 0.05 h),
      oklch(from var(--info, #3b82f6) 35% 0.08 h)
    );
    color: var(--info, #3b82f6);
  }

  .alert[data-variant='info'] .alert-close:hover {
    background-color: light-dark(
      oklch(from var(--info, #3b82f6) 92% 0.03 h),
      oklch(from var(--info, #3b82f6) 25% 0.05 h)
    );
  }

  /* Variant: success */
  .alert[data-variant='success'] {
    --alert-ring: var(--success, #059669);
    background-color: light-dark(
      oklch(from var(--success, #059669) 96.5% 0.015 h),
      oklch(from var(--success, #059669) 20% 0.03 h)
    );
    border-color: light-dark(
      oklch(from var(--success, #059669) 85% 0.05 h),
      oklch(from var(--success, #059669) 35% 0.08 h)
    );
    color: var(--success, #059669);
  }

  .alert[data-variant='success'] .alert-close:hover {
    background-color: light-dark(
      oklch(from var(--success, #059669) 92% 0.03 h),
      oklch(from var(--success, #059669) 25% 0.05 h)
    );
  }

  /* Variant: warning */
  .alert[data-variant='warning'] {
    --alert-ring: var(--warning, #d97706);
    background-color: light-dark(
      oklch(from var(--warning, #d97706) 96.5% 0.015 h),
      oklch(from var(--warning, #d97706) 20% 0.03 h)
    );
    border-color: light-dark(
      oklch(from var(--warning, #d97706) 85% 0.05 h),
      oklch(from var(--warning, #d97706) 35% 0.08 h)
    );
    color: var(--warning, #d97706);
  }

  .alert[data-variant='warning'] .alert-close:hover {
    background-color: light-dark(
      oklch(from var(--warning, #d97706) 92% 0.03 h),
      oklch(from var(--warning, #d97706) 25% 0.05 h)
    );
  }

  /* Variant: danger */
  .alert[data-variant='danger'] {
    --alert-ring: var(--danger, #dc2626);
    background-color: light-dark(
      oklch(from var(--danger, #dc2626) 96.5% 0.015 h),
      oklch(from var(--danger, #dc2626) 20% 0.03 h)
    );
    border-color: light-dark(
      oklch(from var(--danger, #dc2626) 85% 0.05 h),
      oklch(from var(--danger, #dc2626) 35% 0.08 h)
    );
    color: var(--danger, #dc2626);
  }

  .alert[data-variant='danger'] .alert-close:hover {
    background-color: light-dark(
      oklch(from var(--danger, #dc2626) 92% 0.03 h),
      oklch(from var(--danger, #dc2626) 25% 0.05 h)
    );
  }
</style>
