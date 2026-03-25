<script lang="ts" module>
  export type ToastContainerPosition =
    | 'top-right'
    | 'top-left'
    | 'top-center'
    | 'bottom-right'
    | 'bottom-left'
    | 'bottom-center';

  export type ToastContainerProps = {
    class?: string;
    position?: ToastContainerPosition;
  };
</script>

<script lang="ts">
  import { cn } from '../utilities/class-names.ts';
  import { toastStore } from './toast-state.svelte.ts';
  import Toast from './toast.svelte';

  let { class: className, position = 'bottom-right' }: ToastContainerProps = $props();

  const toasts = $derived(toastStore.toasts);

  function handleExit(id: string) {
    toastStore.startExit(id);
  }
</script>

<div
  class={cn('toast-container', className)}
  data-position={position}
  role="region"
  aria-label="Notifications"
>
  {#each toasts as toast (toast.id)}
    <Toast
      {toast}
      {position}
      onExit={handleExit}
      onPauseTimer={(id) => toastStore.pauseTimer(id)}
      onResumeTimer={(id, remaining) => toastStore.resumeTimer(id, remaining)}
    />
  {/each}
</div>

<style>
  .toast-container {
    position: fixed;
    z-index: var(--z-toast, 100);
    display: flex;
    flex-direction: column;
    gap: var(--space-2, 0.5rem);
    padding: var(--space-4, 1rem);
    pointer-events: none;
    max-height: 100vh;
    overflow: hidden;
  }

  .toast-container > :global(*) {
    pointer-events: auto;
  }

  /* Position variants */
  .toast-container[data-position='top-right'] {
    top: 0;
    right: 0;
  }

  .toast-container[data-position='top-left'] {
    top: 0;
    left: 0;
  }

  .toast-container[data-position='top-center'] {
    top: 0;
    left: 50%;
    transform: translateX(-50%);
  }

  .toast-container[data-position='bottom-right'] {
    bottom: 0;
    right: 0;
    flex-direction: column-reverse;
  }

  .toast-container[data-position='bottom-left'] {
    bottom: 0;
    left: 0;
    flex-direction: column-reverse;
  }

  .toast-container[data-position='bottom-center'] {
    bottom: 0;
    left: 50%;
    transform: translateX(-50%);
    flex-direction: column-reverse;
  }
</style>
