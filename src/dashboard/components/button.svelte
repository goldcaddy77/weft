<script lang="ts" module>
  import type { Snippet } from 'svelte';
  import type { HTMLButtonAttributes, HTMLAnchorAttributes } from 'svelte/elements';

  export type ButtonVariant = 'primary' | 'secondary' | 'danger' | 'ghost';
  export type ButtonSize = 'xs' | 'sm' | 'md' | 'lg';

  type SharedProps = {
    variant?: ButtonVariant;
    size?: ButtonSize;
    fullWidth?: boolean;
    loading?: boolean;
    children?: Snippet;
    label?: string;
    /** HTML string icon to render before the label */
    icon?: string;
  };

  type BaseButtonProps = SharedProps & HTMLButtonAttributes & Omit<HTMLAnchorAttributes, 'type'>;

  type ButtonOnlyProps = BaseButtonProps & {
    href?: undefined;
  };

  type LinkButtonProps = BaseButtonProps & {
    href: string;
  };

  export type ButtonProps = ButtonOnlyProps | LinkButtonProps;
</script>

<script lang="ts">
  import { cn } from '../utilities/class-names.ts';

  let {
    variant = 'secondary',
    size = 'sm',
    fullWidth = false,
    class: className,
    loading = false,
    disabled = false,
    href,
    target,
    rel,
    type = 'button' as const,
    onclick,
    children,
    label,
    icon,
    ...rest
  }: ButtonProps = $props();

  const isDisabled = $derived(disabled || loading);
  const iconSizeClass = $derived(size === 'xs' ? 'icon-xs' : 'icon-sm');
</script>

{#snippet spinnerSvg()}
  <svg
    class="button-spinner"
    xmlns="http://www.w3.org/2000/svg"
    fill="none"
    viewBox="0 0 24 24"
    aria-hidden="true"
  >
    <circle class="spinner-track" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"
    ></circle>
    <path
      class="spinner-head"
      fill="currentColor"
      d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
    ></path>
  </svg>
{/snippet}

{#snippet buttonContent()}
  {#if loading}
    {@render spinnerSvg()}
  {:else if icon}
    <span class="button-icon {iconSizeClass}" aria-hidden="true">{@html icon}</span>
  {/if}
  {#if children}{@render children()}{:else if label}{label}{/if}
{/snippet}

{#if href}
  <a
    {href}
    {target}
    {rel}
    class={cn('button', className)}
    data-full-width={fullWidth}
    data-loading={loading}
    data-variant={variant}
    data-size={size}
    aria-disabled={isDisabled || undefined}
    {onclick}
    {...rest}
  >
    {@render buttonContent()}
  </a>
{:else}
  <button
    {type}
    class={cn('button', className)}
    data-full-width={fullWidth}
    data-loading={loading}
    data-variant={variant}
    data-size={size}
    disabled={isDisabled}
    aria-disabled={isDisabled || undefined}
    aria-busy={loading || undefined}
    {onclick}
    {...rest}
  >
    {@render buttonContent()}
  </button>
{/if}

<style>
  .button {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: var(--space-1-5, 0.375rem);
    font-weight: var(--font-medium, 500);
    white-space: nowrap;
    cursor: pointer;
    text-decoration: none;
    transition:
      background-color var(--duration-fast, 150ms) var(--ease-standard, ease),
      border-color var(--duration-fast, 150ms) var(--ease-standard, ease),
      color var(--duration-fast, 150ms) var(--ease-standard, ease),
      box-shadow var(--duration-fast, 150ms) var(--ease-standard, ease);
  }

  .button:hover {
    text-decoration: none;
  }

  .button:focus-visible {
    outline: 2px solid transparent;
    box-shadow:
      0 0 0 var(--ring-offset, 2px) var(--ring-offset-color, var(--surface, #fff)),
      0 0 0 calc(var(--ring-offset, 2px) + var(--ring-width, 2px))
        var(--button-ring, var(--control-ring-color, #6366f1));
  }

  .button:disabled,
  .button[aria-disabled='true'] {
    cursor: not-allowed;
    background: var(--surface-inset, #f3f4f6);
    color: var(--text-disabled, #9ca3af);
    border-color: var(--border-muted, #e5e7eb);
    opacity: 0.5;
  }

  .button[data-loading='true']:disabled,
  .button[data-loading='true'][aria-disabled='true'] {
    opacity: 1;
  }

  .button[data-full-width='true'] {
    width: 100%;
  }

  .button[data-loading='true'] {
    cursor: wait;
  }

  /* Size variants */
  .button[data-size='xs'] {
    font-size: var(--text-xs, 0.75rem);
    padding: var(--space-0-5, 0.125rem) var(--space-1-5, 0.375rem);
    min-height: 1.5rem;
    border-radius: var(--radius-sm, 0.25rem);
  }

  .button[data-size='sm'] {
    font-size: var(--text-xs, 0.75rem);
    padding: var(--space-1, 0.25rem) var(--space-2, 0.5rem);
    min-height: 2rem;
    border-radius: var(--radius-sm, 0.25rem);
  }

  .button[data-size='md'] {
    font-size: var(--text-sm, 0.875rem);
    padding: var(--space-1-5, 0.375rem) var(--space-3, 0.75rem);
    min-height: 2.25rem;
    border-radius: var(--radius-md, 0.375rem);
  }

  .button[data-size='lg'] {
    font-size: var(--text-sm, 0.875rem);
    padding: var(--space-2, 0.5rem) var(--space-4, 1rem);
    min-height: 2.5rem;
    border-radius: var(--radius-md, 0.375rem);
  }

  /* Variant: primary */
  .button[data-variant='primary'] {
    --button-ring: var(--accent, #6366f1);
    background: var(--accent, #6366f1);
    color: var(--accent-contrast, #fff);
    border: none;
  }

  .button[data-variant='primary']:disabled,
  .button[data-variant='primary'][aria-disabled='true'] {
    background: var(--surface-inset, #f3f4f6);
    color: var(--text-disabled, #9ca3af);
    border: 1px solid var(--border-muted, #e5e7eb);
  }

  .button[data-variant='primary']:hover:not(:disabled):not([aria-disabled='true']) {
    background: color-mix(in oklch, var(--accent, #6366f1), black 15%);
  }

  .button[data-variant='primary']:active:not(:disabled):not([aria-disabled='true']) {
    background: color-mix(in oklch, var(--accent, #6366f1), black 25%);
  }

  /* Variant: secondary */
  .button[data-variant='secondary'] {
    background: var(--surface-raised, #fff);
    color: var(--text, #111827);
    border: 1px solid var(--border, #d1d5db);
  }

  .button[data-variant='secondary']:hover:not(:disabled):not([aria-disabled='true']) {
    background: var(--surface-hover, #f9fafb);
  }

  .button[data-variant='secondary']:active:not(:disabled):not([aria-disabled='true']) {
    background: var(--surface-pressed, #f3f4f6);
  }

  /* Variant: danger */
  .button[data-variant='danger'] {
    --button-ring: var(--error, #dc2626);
    background: var(--error, #dc2626);
    color: var(--error-contrast, #fff);
    border: none;
  }

  .button[data-variant='danger']:hover:not(:disabled):not([aria-disabled='true']) {
    background: color-mix(in oklch, var(--error, #dc2626), black 15%);
  }

  .button[data-variant='danger']:active:not(:disabled):not([aria-disabled='true']) {
    background: color-mix(in oklch, var(--error, #dc2626), black 25%);
  }

  .button[data-variant='danger']:disabled,
  .button[data-variant='danger'][aria-disabled='true'] {
    background: var(--surface-inset, #f3f4f6);
    color: var(--text-disabled, #9ca3af);
    border: 1px solid var(--border-muted, #e5e7eb);
  }

  /* Variant: ghost */
  .button[data-variant='ghost'] {
    background: transparent;
    color: var(--text-muted, #6b7280);
    border: none;
  }

  .button[data-variant='ghost']:hover:not(:disabled):not([aria-disabled='true']) {
    color: var(--text, #111827);
    background: var(--surface-hover, #f9fafb);
  }

  .button[data-variant='ghost']:active:not(:disabled):not([aria-disabled='true']) {
    background: var(--surface-pressed, #f3f4f6);
  }

  .button[data-variant='ghost']:disabled,
  .button[data-variant='ghost'][aria-disabled='true'] {
    background: transparent;
  }

  /* Button icon */
  .button-icon {
    display: inline-flex;
    align-items: center;
    flex-shrink: 0;
  }

  .button-icon :global(svg) {
    width: 100%;
    height: 100%;
  }

  .button-icon.icon-xs {
    width: 0.75rem;
    height: 0.75rem;
  }

  .button-icon.icon-sm {
    width: 1rem;
    height: 1rem;
  }

  /* Spinner */
  .button-spinner {
    flex-shrink: 0;
    animation: spin 1s linear infinite;
  }

  .button[data-size='xs'] .button-spinner {
    width: 0.75rem;
    height: 0.75rem;
  }

  .button[data-size='sm'] .button-spinner,
  .button[data-size='md'] .button-spinner,
  .button[data-size='lg'] .button-spinner {
    width: 1rem;
    height: 1rem;
  }

  .spinner-track {
    opacity: 0.25;
  }

  .spinner-head {
    opacity: 0.75;
  }

  @keyframes spin {
    to {
      transform: rotate(360deg);
    }
  }
</style>
