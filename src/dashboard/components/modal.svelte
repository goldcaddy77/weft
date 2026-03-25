<script lang="ts" module>
  import type { Snippet } from 'svelte';

  export type ModalProps = {
    open?: boolean;
    title?: string;
    onclose?: () => void;
    body?: Snippet;
    footer?: Snippet;
    class?: string;
  };
</script>

<script lang="ts">
  import { cn } from '../utilities/class-names.ts';

  let {
    open = $bindable(false),
    title,
    onclose,
    body,
    footer,
    class: className,
  }: ModalProps = $props();

  let dialogElement = $state<HTMLDialogElement | null>(null);

  $effect(() => {
    if (!dialogElement) return;
    if (open && !dialogElement.open) {
      dialogElement.showModal();
    } else if (!open && dialogElement.open) {
      dialogElement.close();
    }
  });

  function handleClose() {
    open = false;
    onclose?.();
  }

  function handleDialogClose() {
    open = false;
    onclose?.();
  }

  function handleBackdropClick(event: MouseEvent) {
    if (event.target === dialogElement) {
      handleClose();
    }
  }
</script>

<dialog
  bind:this={dialogElement}
  class={cn('modal', className)}
  onclose={handleDialogClose}
  onclick={handleBackdropClick}
>
  <div class="modal-container">
    <div class="modal-header">
      {#if title}
        <h2 class="modal-title">{title}</h2>
      {/if}
      <button
        type="button"
        class="modal-close"
        onclick={handleClose}
        aria-label="Close dialog"
      >
        <svg
          xmlns="http://www.w3.org/2000/svg"
          width="16"
          height="16"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="2"
          stroke-linecap="round"
          stroke-linejoin="round"
          aria-hidden="true"
        >
          <line x1="18" y1="6" x2="6" y2="18" />
          <line x1="6" y1="6" x2="18" y2="18" />
        </svg>
      </button>
    </div>

    {#if body}
      <div class="modal-body">
        {@render body()}
      </div>
    {/if}

    {#if footer}
      <div class="modal-footer">
        {@render footer()}
      </div>
    {/if}
  </div>
</dialog>

<style>
  .modal {
    border: none;
    border-radius: var(--radius-lg, 0.75rem);
    background: var(--surface-raised, #fff);
    color: var(--text, #111827);
    box-shadow: var(--shadow-xl, 0 20px 25px -5px rgb(0 0 0 / 0.1));
    padding: 0;
    max-width: min(32rem, calc(100vw - 2rem));
    width: 100%;
    max-height: min(85vh, calc(100vh - 2rem));
    overflow: hidden;
  }

  .modal::backdrop {
    background: oklch(0% 0 0 / 50%);
    backdrop-filter: blur(4px);
  }

  .modal[open] {
    animation: modal-enter var(--duration-normal, 200ms) var(--ease-decelerate, ease-out);
  }

  .modal[open]::backdrop {
    animation: modal-backdrop-enter var(--duration-normal, 200ms) var(--ease-standard, ease);
  }

  @keyframes modal-enter {
    from {
      opacity: 0;
      transform: scale(0.95) translateY(8px);
    }
    to {
      opacity: 1;
      transform: scale(1) translateY(0);
    }
  }

  @keyframes modal-backdrop-enter {
    from {
      opacity: 0;
    }
    to {
      opacity: 1;
    }
  }

  @media (prefers-reduced-motion: reduce) {
    .modal[open],
    .modal[open]::backdrop {
      animation: none;
    }
  }

  .modal-container {
    display: flex;
    flex-direction: column;
    max-height: min(85vh, calc(100vh - 2rem));
  }

  .modal-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--space-3, 0.75rem);
    padding: var(--space-4, 1rem) var(--space-4, 1rem) var(--space-3, 0.75rem);
    border-bottom: 1px solid var(--border-muted, #e5e7eb);
  }

  .modal-title {
    font-size: var(--text-base, 1rem);
    font-weight: var(--font-semibold, 600);
    color: var(--text, #111827);
  }

  .modal-close {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 2rem;
    height: 2rem;
    border-radius: var(--radius-md, 0.375rem);
    border: none;
    background: transparent;
    color: var(--text-muted, #6b7280);
    cursor: pointer;
    flex-shrink: 0;
    transition:
      color var(--duration-fast, 150ms) var(--ease-standard, ease),
      background-color var(--duration-fast, 150ms) var(--ease-standard, ease);
  }

  .modal-close:hover {
    color: var(--text, #111827);
    background: var(--surface-hover, #f9fafb);
  }

  .modal-close:focus-visible {
    outline: 2px solid transparent;
    box-shadow:
      0 0 0 var(--ring-offset, 2px) var(--ring-offset-color, var(--surface, #fff)),
      0 0 0 calc(var(--ring-offset, 2px) + var(--ring-width, 2px))
        var(--control-ring-color, #6366f1);
  }

  .modal-body {
    flex: 1;
    overflow-y: auto;
    padding: var(--space-4, 1rem);
  }

  .modal-footer {
    display: flex;
    align-items: center;
    justify-content: flex-end;
    gap: var(--space-2, 0.5rem);
    padding: var(--space-3, 0.75rem) var(--space-4, 1rem) var(--space-4, 1rem);
    border-top: 1px solid var(--border-muted, #e5e7eb);
  }
</style>
