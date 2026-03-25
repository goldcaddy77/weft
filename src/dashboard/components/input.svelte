<script lang="ts" module>
  import type { HTMLInputAttributes } from 'svelte/elements';

  export type InputProps = Omit<HTMLInputAttributes, 'size' | 'value' | 'placeholder' | 'id'> & {
    id: string;
    error?: string;
    label: string;
    hideLabel?: boolean;
    placeholder?: string;
    description?: string;
    value?: string;
  };
</script>

<script lang="ts">
  import { cn } from '../utilities/class-names.js';

  let {
    class: className,
    error,
    label,
    hideLabel = false,
    placeholder,
    description,
    id,
    required,
    disabled,
    value = $bindable(''),
    ...rest
  }: InputProps = $props();

  const descriptionId = $derived(description ? `${id}-description` : undefined);
  const errorId = $derived(error ? `${id}-error` : undefined);
  const describedBy = $derived([descriptionId, errorId].filter(Boolean).join(' ') || undefined);
  const effectivePlaceholder = $derived(hideLabel && !placeholder ? label : placeholder);
</script>

<div class="form-field">
  <label
    for={id}
    class={cn('field-label', hideLabel && 'sr-only')}
    data-disabled={disabled}
  >
    {label}
    {#if required}
      <span class="field-required" aria-hidden="true"></span>
      <span class="sr-only">(required)</span>
    {/if}
  </label>
  <input
    {id}
    class={cn('control', className)}
    aria-invalid={error ? 'true' : undefined}
    aria-describedby={describedBy}
    placeholder={effectivePlaceholder}
    {required}
    {disabled}
    bind:value
    {...rest}
  />
  {#if description}
    <p id={descriptionId} class="field-description">{description}</p>
  {/if}
  {#if error}
    <p id={errorId} class="field-error">{error}</p>
  {/if}
</div>

<style>
  .form-field {
    display: flex;
    flex-direction: column;
    gap: var(--field-gap, var(--space-1-5, 0.375rem));
  }

  .field-label {
    display: inline-flex;
    align-items: center;
    gap: var(--space-1, 0.25rem);
    font-size: var(--text-xs, 0.75rem);
    font-weight: var(--font-medium, 500);
    line-height: 1;
    color: var(--text, #111827);
  }

  .field-label[data-disabled='true'] {
    cursor: not-allowed;
  }

  .field-required {
    flex-shrink: 0;
    width: 0.375rem;
    height: 0.375rem;
    background: var(--error, #dc2626);
    border-radius: 50%;
  }

  .control {
    display: block;
    width: 100%;
    min-height: var(--control-height, 2.25rem);
    padding: var(--space-1-5, 0.375rem) var(--space-3, 0.75rem);
    font-size: var(--text-sm, 0.875rem);
    line-height: var(--leading-normal, 1.5);
    color: var(--text, #111827);
    background: var(--control-bg, var(--surface, #fff));
    border: 1px solid var(--control-border, #d1d5db);
    border-radius: var(--radius-md, 0.375rem);
    transition:
      border-color var(--duration-fast, 150ms) var(--ease-standard, ease),
      box-shadow var(--duration-fast, 150ms) var(--ease-standard, ease);
    appearance: none;
  }

  .control::placeholder {
    color: var(--control-placeholder, #9ca3af);
  }

  .control:hover:not(:disabled) {
    border-color: var(--control-border-hover, #9ca3af);
  }

  .control:focus-visible {
    outline: 2px solid transparent;
    box-shadow:
      0 0 0 var(--ring-offset, 2px) var(--ring-offset-color, var(--surface, #fff)),
      0 0 0 calc(var(--ring-offset, 2px) + var(--ring-width, 2px))
        var(--control-ring-color, #6366f1);
  }

  .control:disabled {
    background: var(--control-bg-disabled, #f9fafb);
    border-color: var(--control-border-disabled, #e5e7eb);
    color: var(--control-text-disabled, #9ca3af);
    cursor: not-allowed;
  }

  .control[aria-invalid='true'] {
    border-color: var(--control-border-error, var(--error, #dc2626));
  }

  .control[aria-invalid='true']:focus-visible {
    box-shadow:
      0 0 0 var(--ring-offset, 2px) var(--ring-offset-color, var(--surface, #fff)),
      0 0 0 calc(var(--ring-offset, 2px) + var(--ring-width, 2px))
        var(--control-ring-color-error, var(--error, #dc2626));
  }

  .field-description {
    font-size: var(--text-sm, 0.875rem);
    color: var(--text-muted, #6b7280);
  }

  .field-error {
    font-size: var(--text-sm, 0.875rem);
    color: var(--field-error-color, var(--error, #dc2626));
  }
</style>
