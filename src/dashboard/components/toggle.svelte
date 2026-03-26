<script lang="ts" module>
  import type { HTMLButtonAttributes } from 'svelte/elements';

  export type ToggleProps = Omit<HTMLButtonAttributes, 'type' | 'id'> & {
    id: string;
    checked?: boolean;
    label: string;
    hideLabel?: boolean;
  };
</script>

<script lang="ts">
  import { cn } from '../utilities/class-names.ts';

  let {
    class: className,
    checked = $bindable(false),
    label,
    hideLabel = false,
    disabled,
    id,
    ...rest
  }: ToggleProps = $props();

  function toggle() {
    if (!disabled) {
      checked = !checked;
    }
  }
</script>

<div class="toggle-container">
  <button
    {id}
    type="button"
    role="switch"
    aria-checked={checked}
    aria-label={hideLabel ? label : undefined}
    {disabled}
    onclick={toggle}
    onkeydown={(event) => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        toggle();
      }
    }}
    class={cn('toggle', className)}
    data-checked={checked}
    {...rest}
  >
    <span aria-hidden="true" class="toggle-thumb"></span>
  </button>
  <label for={id} class={cn('toggle-label', hideLabel && 'sr-only')} data-disabled={disabled}>
    {label}
  </label>
</div>

<style>
  .toggle-container {
    display: inline-flex;
    align-items: center;
    gap: var(--space-3, 0.75rem);
  }

  .toggle {
    position: relative;
    display: inline-flex;
    flex-shrink: 0;
    height: 1.5rem;
    width: 2.75rem;
    cursor: pointer;
    border-radius: 9999px;
    border: 2px solid transparent;
    background: var(--control-border, #d1d5db);
    transition:
      background-color var(--duration-fast, 150ms) var(--ease-standard, ease),
      box-shadow var(--duration-fast, 150ms) var(--ease-standard, ease);
  }

  .toggle:focus-visible {
    outline: 2px solid transparent;
    box-shadow:
      0 0 0 var(--ring-offset, 2px) var(--ring-offset-color, var(--surface, #fff)),
      0 0 0 calc(var(--ring-offset, 2px) + var(--ring-width, 2px))
        var(--control-ring-color, #6366f1);
  }

  .toggle:disabled {
    cursor: not-allowed;
    opacity: 0.6;
    filter: grayscale(1);
  }

  .toggle[data-checked='true'] {
    background: var(--accent, #6366f1);
  }

  .toggle-thumb {
    pointer-events: none;
    display: inline-block;
    width: 1.25rem;
    height: 1.25rem;
    border-radius: 50%;
    background: white;
    box-shadow: var(--shadow-md, 0 4px 6px -1px rgb(0 0 0 / 0.1));
    transition: transform var(--duration-fast, 150ms) var(--ease-standard, ease);
    transform: translateX(0);
  }

  .toggle[data-checked='true'] .toggle-thumb {
    transform: translateX(1.25rem);
  }

  .toggle-label {
    font-size: var(--text-sm, 0.875rem);
    color: var(--text, #111827);
    cursor: pointer;
    user-select: none;
  }

  .toggle-label[data-disabled='true'] {
    cursor: not-allowed;
  }
</style>
