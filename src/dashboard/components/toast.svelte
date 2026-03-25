<script lang="ts" module>
  import type { HTMLAttributes } from 'svelte/elements';
  import type { ToastData } from './toast-state.svelte.ts';

  export type ToastPosition =
    | 'top-right'
    | 'top-left'
    | 'top-center'
    | 'bottom-right'
    | 'bottom-left'
    | 'bottom-center';

  export type ToastProps = Omit<HTMLAttributes<HTMLDivElement>, 'class' | 'id'> & {
    class?: string;
    toast: ToastData;
    position?: ToastPosition;
    onExit: (id: string) => void;
    onPauseTimer?: (id: string) => void;
    onResumeTimer?: (id: string, remaining: number) => void;
  };
</script>

<script lang="ts">
  import { untrack } from 'svelte';
  import { cn } from '../utilities/class-names.ts';

  let {
    class: className,
    toast: toastData,
    position = 'bottom-right',
    onExit,
    onPauseTimer,
    onResumeTimer,
    ...rest
  }: ToastProps = $props();

  const animationDirection = $derived(
    position.includes('center') ? 'center' : position.includes('left') ? 'left' : 'right',
  );

  let isManuallyExiting = $state(false);
  const isExiting = $derived(isManuallyExiting || toastData.exiting);
  let isPaused = $state(false);
  let startTime = $state(Date.now());
  let remainingTime = $state(untrack(() => toastData.duration ?? 5000));

  function handleDismiss() {
    if (isExiting) return;
    isManuallyExiting = true;
    onExit(toastData.id);
  }

  function handleActionClick() {
    toastData.action?.onClick();
    if (toastData.action?.dismissOnClick !== false) {
      handleDismiss();
    }
  }

  function handleMouseEnter() {
    if (toastData.duration && toastData.duration > 0 && !isPaused && !isExiting) {
      remainingTime = remainingTime - (Date.now() - startTime);
      if (remainingTime <= 0) {
        handleDismiss();
        return;
      }
      isPaused = true;
      onPauseTimer?.(toastData.id);
    }
  }

  function handleMouseLeave() {
    if (toastData.duration && toastData.duration > 0 && isPaused && !isExiting) {
      if (remainingTime <= 0) {
        handleDismiss();
        return;
      }
      startTime = Date.now();
      isPaused = false;
      onResumeTimer?.(toastData.id, remainingTime);
    }
  }
</script>

<div
  class={cn('toast', className)}
  data-variant={toastData.variant}
  data-exiting={isExiting}
  data-animation-direction={animationDirection}
  role={toastData.variant === 'danger' ? 'alert' : 'status'}
  aria-live={toastData.variant === 'danger' ? undefined : 'polite'}
  aria-atomic="true"
  onmouseenter={handleMouseEnter}
  onmouseleave={handleMouseLeave}
  onfocusin={handleMouseEnter}
  onfocusout={handleMouseLeave}
  {...rest}
>
  <div class="toast-icon" aria-hidden="true">
    {#if toastData.variant === 'success'}
      <svg viewBox="0 0 20 20" fill="currentColor">
        <path
          fill-rule="evenodd"
          d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.857-9.809a.75.75 0 00-1.214-.882l-3.483 4.79-1.88-1.88a.75.75 0 10-1.06 1.061l2.5 2.5a.75.75 0 001.137-.089l4-5.5z"
          clip-rule="evenodd"
        />
      </svg>
    {:else if toastData.variant === 'danger'}
      <svg viewBox="0 0 20 20" fill="currentColor">
        <path
          fill-rule="evenodd"
          d="M18 10a8 8 0 11-16 0 8 8 0 0116 0zm-8-5a.75.75 0 01.75.75v4.5a.75.75 0 01-1.5 0v-4.5A.75.75 0 0110 5zm0 10a1 1 0 100-2 1 1 0 000 2z"
          clip-rule="evenodd"
        />
      </svg>
    {:else if toastData.variant === 'warning'}
      <svg viewBox="0 0 20 20" fill="currentColor">
        <path
          fill-rule="evenodd"
          d="M8.485 2.495c.673-1.167 2.357-1.167 3.03 0l6.28 10.875c.673 1.167-.17 2.625-1.516 2.625H3.72c-1.347 0-2.189-1.458-1.515-2.625L8.485 2.495zM10 5a.75.75 0 01.75.75v3.5a.75.75 0 01-1.5 0v-3.5A.75.75 0 0110 5zm0 9a1 1 0 100-2 1 1 0 000 2z"
          clip-rule="evenodd"
        />
      </svg>
    {:else}
      <svg viewBox="0 0 20 20" fill="currentColor">
        <path
          fill-rule="evenodd"
          d="M18 10a8 8 0 11-16 0 8 8 0 0116 0zm-7-4a1 1 0 11-2 0 1 1 0 012 0zM9 9a.75.75 0 000 1.5h.253a.25.25 0 01.244.304l-.459 2.066A1.75 1.75 0 0010.747 15H11a.75.75 0 000-1.5h-.253a.25.25 0 01-.244-.304l.459-2.066A1.75 1.75 0 009.253 9H9z"
          clip-rule="evenodd"
        />
      </svg>
    {/if}
  </div>

  <div class="toast-content">
    {#if toastData.title}
      <p class="toast-title">{toastData.title}</p>
    {/if}
    <p class="toast-message">{toastData.message}</p>
  </div>

  {#if toastData.action}
    <button type="button" class="toast-action" onclick={handleActionClick}>
      {toastData.action.label}
    </button>
  {/if}

  {#if toastData.dismissible}
    <button
      type="button"
      class="toast-dismiss"
      onclick={handleDismiss}
      aria-label="Dismiss notification"
    >
      <svg viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
        <path
          d="M6.28 5.22a.75.75 0 00-1.06 1.06L8.94 10l-3.72 3.72a.75.75 0 101.06 1.06L10 11.06l3.72 3.72a.75.75 0 101.06-1.06L11.06 10l3.72-3.72a.75.75 0 00-1.06-1.06L10 8.94 6.28 5.22z"
        />
      </svg>
    </button>
  {/if}
</div>

<style>
  .toast {
    display: flex;
    align-items: flex-start;
    gap: var(--space-3, 0.75rem);
    padding: var(--space-3, 0.75rem) var(--space-4, 1rem);
    background: var(--surface-overlay, var(--surface-raised, #fff));
    border: 1px solid var(--border, #d1d5db);
    border-radius: 0 var(--radius-lg, 0.75rem) var(--radius-lg, 0.75rem) 0;
    box-shadow: var(--shadow-lg, 0 10px 15px -3px rgb(0 0 0 / 0.1));
    max-width: 24rem;
  }

  .toast[data-variant='success'] {
    border-left: 3px solid var(--success, #059669);
  }
  .toast[data-variant='danger'] {
    border-left: 3px solid var(--danger, #dc2626);
  }
  .toast[data-variant='warning'] {
    border-left: 3px solid var(--warning, #d97706);
  }
  .toast[data-variant='info'] {
    border-left: 3px solid var(--info, #3b82f6);
  }

  .toast-icon {
    flex-shrink: 0;
    width: 1.25rem;
    height: 1.25rem;
  }

  .toast-icon svg {
    width: 100%;
    height: 100%;
  }

  .toast[data-variant='success'] .toast-icon {
    color: var(--success, #059669);
  }
  .toast[data-variant='danger'] .toast-icon {
    color: var(--danger, #dc2626);
  }
  .toast[data-variant='warning'] .toast-icon {
    color: var(--warning, #d97706);
  }
  .toast[data-variant='info'] .toast-icon {
    color: var(--info, #3b82f6);
  }

  .toast-content {
    flex: 1;
    min-width: 0;
  }

  .toast-title {
    font-size: var(--text-sm, 0.875rem);
    font-weight: var(--font-semibold, 600);
    color: var(--text, #111827);
    margin: 0 0 var(--space-1, 0.25rem) 0;
  }

  .toast-message {
    font-size: var(--text-sm, 0.875rem);
    color: var(--text, #111827);
    margin: 0;
  }

  .toast-action {
    flex-shrink: 0;
    font-size: var(--text-sm, 0.875rem);
    font-weight: var(--font-medium, 500);
    color: var(--text, #111827);
    text-decoration: underline;
    text-underline-offset: 2px;
    background: transparent;
    border: none;
    padding: var(--space-1, 0.25rem);
    cursor: pointer;
    border-radius: var(--radius-sm, 0.25rem);
    transition: background-color var(--duration-fast, 150ms) var(--ease-standard, ease);
  }

  .toast-action:hover {
    background: var(--surface-hover, #f9fafb);
  }

  .toast-action:focus-visible {
    outline: 2px solid transparent;
    box-shadow:
      0 0 0 var(--ring-offset, 2px) var(--ring-offset-color, var(--surface, #fff)),
      0 0 0 calc(var(--ring-offset, 2px) + var(--ring-width, 2px))
        var(--ring-color, #6366f1);
  }

  .toast-dismiss {
    flex-shrink: 0;
    background: transparent;
    border: none;
    color: var(--text-muted, #6b7280);
    cursor: pointer;
    padding: var(--space-1, 0.25rem);
    border-radius: var(--radius-sm, 0.25rem);
    display: flex;
    align-items: center;
    justify-content: center;
    transition:
      color var(--duration-fast, 150ms) var(--ease-standard, ease),
      background-color var(--duration-fast, 150ms) var(--ease-standard, ease);
  }

  .toast-dismiss:hover {
    color: var(--text, #111827);
    background: var(--surface-hover, #f9fafb);
  }

  .toast-dismiss:focus-visible {
    outline: 2px solid transparent;
    box-shadow:
      0 0 0 var(--ring-offset, 2px) var(--ring-offset-color, var(--surface, #fff)),
      0 0 0 calc(var(--ring-offset, 2px) + var(--ring-width, 2px))
        var(--ring-color, #6366f1);
  }

  .toast-dismiss svg {
    width: 1rem;
    height: 1rem;
  }

  /* Right-side animations */
  @keyframes toast-enter-right {
    from {
      opacity: 0;
      transform: translateX(100%);
    }
    to {
      opacity: 1;
      transform: translateX(0);
    }
  }

  @keyframes toast-exit-right {
    from {
      opacity: 1;
      transform: translateX(0);
    }
    to {
      opacity: 0;
      transform: translateX(100%);
    }
  }

  /* Left-side animations */
  @keyframes toast-enter-left {
    from {
      opacity: 0;
      transform: translateX(-100%);
    }
    to {
      opacity: 1;
      transform: translateX(0);
    }
  }

  @keyframes toast-exit-left {
    from {
      opacity: 1;
      transform: translateX(0);
    }
    to {
      opacity: 0;
      transform: translateX(-100%);
    }
  }

  /* Center animations */
  @keyframes toast-enter-center {
    from {
      opacity: 0;
      transform: translateY(8px);
    }
    to {
      opacity: 1;
      transform: translateY(0);
    }
  }

  @keyframes toast-exit-center {
    from {
      opacity: 1;
      transform: translateY(0);
    }
    to {
      opacity: 0;
      transform: translateY(-8px);
    }
  }

  .toast[data-animation-direction='right'] {
    animation: toast-enter-right var(--duration, 300ms) var(--ease-decelerate, ease-out);
  }

  .toast[data-animation-direction='right'][data-exiting='true'] {
    animation: toast-exit-right var(--duration-fast, 150ms) var(--ease-accelerate, ease-in) forwards;
  }

  .toast[data-animation-direction='left'] {
    animation: toast-enter-left var(--duration, 300ms) var(--ease-decelerate, ease-out);
  }

  .toast[data-animation-direction='left'][data-exiting='true'] {
    animation: toast-exit-left var(--duration-fast, 150ms) var(--ease-accelerate, ease-in) forwards;
  }

  .toast[data-animation-direction='center'] {
    animation: toast-enter-center var(--duration, 300ms) var(--ease-decelerate, ease-out);
  }

  .toast[data-animation-direction='center'][data-exiting='true'] {
    animation: toast-exit-center var(--duration-fast, 150ms) var(--ease-accelerate, ease-in)
      forwards;
  }

  @media (prefers-reduced-motion: reduce) {
    .toast,
    .toast[data-exiting='true'] {
      animation: none;
    }
  }
</style>
