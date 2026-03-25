<script lang="ts">
  import { setContext } from 'svelte';

  import { ApiClient } from './api-client.ts';
  import { moon, sun, activity, inbox } from './icons.ts';
  import { matchRoute, navigate, route } from './router.svelte.ts';
  import WorkflowList from './views/workflow-list.svelte';
  import WorkflowDetail from './views/workflow-detail.svelte';
  import WorkflowDetailAgent from './views/workflow-detail-agent.svelte';
  import HumanReviewQueue from './views/human-review-queue.svelte';
  import NotFound from './views/not-found.svelte';

  // ---------------------------------------------------------------------------
  // Context providers
  // ---------------------------------------------------------------------------

  const apiClient = new ApiClient();
  setContext('api-client', apiClient);

  // Toast store: an array of { id, message, variant } objects
  const toasts: Array<{ id: string; message: string; variant: 'info' | 'success' | 'error' }> =
    $state([]);

  function addToast(message: string, variant: 'info' | 'success' | 'error' = 'info'): void {
    const id = crypto.randomUUID();
    toasts.push({ id, message, variant });
    setTimeout(() => {
      const index = toasts.findIndex((t) => t.id === id);
      if (index !== -1) toasts.splice(index, 1);
    }, 5_000);
  }

  function dismissToast(id: string): void {
    const index = toasts.findIndex((t) => t.id === id);
    if (index !== -1) toasts.splice(index, 1);
  }

  setContext('toasts', { toasts, addToast, dismissToast });

  // ---------------------------------------------------------------------------
  // Theme toggle
  // ---------------------------------------------------------------------------

  let darkMode: boolean = $state(
    document.documentElement.getAttribute('data-theme') === 'dark' ||
      (!document.documentElement.getAttribute('data-theme') &&
        window.matchMedia('(prefers-color-scheme: dark)').matches),
  );

  function toggleTheme(): void {
    darkMode = !darkMode;
    document.documentElement.setAttribute('data-theme', darkMode ? 'dark' : 'light');
  }

  // ---------------------------------------------------------------------------
  // Route matching
  // ---------------------------------------------------------------------------

  const currentMatch = $derived(matchRoute(route.path));

  // ---------------------------------------------------------------------------
  // Navigation helper
  // ---------------------------------------------------------------------------

  function handleNavigationClick(event: MouseEvent, path: string): void {
    event.preventDefault();
    navigate(path);
  }
</script>

<div class="dashboard-layout">
  <!-- Navigation Bar -->
  <header class="navigation-bar">
    <div class="navigation-bar-start">
      <a
        href="/ui"
        class="navigation-bar-brand"
        onclick={(event: MouseEvent) => handleNavigationClick(event, '/ui')}
      >
        {@html activity(20)}
        <span>Weft</span>
      </a>
    </div>

    <nav class="navigation-bar-center">
      <a
        href="/ui/workflows"
        class="navigation-bar-link"
        class:active={currentMatch.view === 'workflow-list' ||
          currentMatch.view === 'workflow-detail' ||
          currentMatch.view === 'workflow-detail-agent'}
        onclick={(event: MouseEvent) => handleNavigationClick(event, '/ui/workflows')}
      >
        Workflows
      </a>
      <a
        href="/ui/reviews"
        class="navigation-bar-link"
        class:active={currentMatch.view === 'human-review-queue'}
        onclick={(event: MouseEvent) => handleNavigationClick(event, '/ui/reviews')}
      >
        {@html inbox(16)}
        Reviews
      </a>
    </nav>

    <div class="navigation-bar-end">
      <button class="theme-toggle" onclick={toggleTheme} aria-label="Toggle theme">
        {#if darkMode}
          {@html sun(18)}
        {:else}
          {@html moon(18)}
        {/if}
      </button>
    </div>
  </header>

  <!-- Main Content -->
  <main class="dashboard-content">
    {#if currentMatch.view === 'workflow-list'}
      <WorkflowList />
    {:else if currentMatch.view === 'workflow-detail'}
      <WorkflowDetail id={currentMatch.params['id'] ?? ''} />
    {:else if currentMatch.view === 'workflow-detail-agent'}
      <WorkflowDetailAgent id={currentMatch.params['id'] ?? ''} />
    {:else if currentMatch.view === 'human-review-queue'}
      <HumanReviewQueue />
    {:else}
      <NotFound />
    {/if}
  </main>

  <!-- Toast Container -->
  {#if toasts.length > 0}
    <div class="toast-container" aria-live="polite">
      {#each toasts as toast (toast.id)}
        <div class="toast" data-variant={toast.variant}>
          <span class="toast-message">{toast.message}</span>
          <button class="toast-dismiss" onclick={() => dismissToast(toast.id)} aria-label="Dismiss">
            &times;
          </button>
        </div>
      {/each}
    </div>
  {/if}
</div>

<style>
  .dashboard-layout {
    display: flex;
    flex-direction: column;
    min-height: 100vh;
  }

  /* Navigation Bar */
  .navigation-bar {
    display: flex;
    align-items: center;
    justify-content: space-between;
    height: 3.5rem;
    padding: 0 var(--space-4, 1rem);
    background: var(--surface, #fff);
    border-bottom: 1px solid var(--border, #e5e7eb);
  }

  .navigation-bar-start {
    display: flex;
    align-items: center;
  }

  .navigation-bar-brand {
    display: flex;
    align-items: center;
    gap: var(--space-2, 0.5rem);
    font-weight: var(--font-semibold, 600);
    font-size: var(--text-base, 1rem);
    color: var(--text, #111);
    text-decoration: none;
  }

  .navigation-bar-brand:hover {
    color: var(--accent, #2563eb);
  }

  .navigation-bar-center {
    display: flex;
    align-items: center;
    gap: var(--space-1, 0.25rem);
  }

  .navigation-bar-link {
    display: flex;
    align-items: center;
    gap: var(--space-1, 0.25rem);
    padding: var(--space-1, 0.25rem) var(--space-3, 0.75rem);
    font-size: var(--text-sm, 0.875rem);
    color: var(--text-muted, #6b7280);
    text-decoration: none;
    border-radius: var(--radius-sm, 0.25rem);
    transition:
      color var(--duration-fast, 100ms) var(--ease-standard, ease),
      background var(--duration-fast, 100ms) var(--ease-standard, ease);
  }

  .navigation-bar-link:hover {
    color: var(--text, #111);
    background: var(--surface-hover, #f3f4f6);
  }

  .navigation-bar-link.active {
    color: var(--accent, #2563eb);
    background: var(--surface-active, #eff6ff);
  }

  .navigation-bar-end {
    display: flex;
    align-items: center;
  }

  .theme-toggle {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 2rem;
    height: 2rem;
    color: var(--text-muted, #6b7280);
    background: none;
    border: none;
    border-radius: var(--radius-sm, 0.25rem);
    cursor: pointer;
    transition:
      color var(--duration-fast, 100ms) var(--ease-standard, ease),
      background var(--duration-fast, 100ms) var(--ease-standard, ease);
  }

  .theme-toggle:hover {
    color: var(--text, #111);
    background: var(--surface-hover, #f3f4f6);
  }

  /* Main Content */
  .dashboard-content {
    flex: 1;
    padding: var(--space-6, 1.5rem);
  }

  /* Toast Container */
  .toast-container {
    position: fixed;
    bottom: var(--space-4, 1rem);
    right: var(--space-4, 1rem);
    display: flex;
    flex-direction: column;
    gap: var(--space-2, 0.5rem);
    z-index: 1000;
    max-width: 24rem;
  }

  .toast {
    display: flex;
    align-items: center;
    gap: var(--space-2, 0.5rem);
    padding: var(--space-3, 0.75rem) var(--space-4, 1rem);
    background: var(--surface-raised, #fff);
    border: 1px solid var(--border, #e5e7eb);
    border-radius: var(--radius-md, 0.375rem);
    box-shadow: var(--shadow-lg, 0 10px 15px -3px rgb(0 0 0 / 0.1));
    font-size: var(--text-sm, 0.875rem);
  }

  .toast[data-variant='success'] {
    border-left: 3px solid var(--success, #22c55e);
  }

  .toast[data-variant='error'] {
    border-left: 3px solid var(--danger, #ef4444);
  }

  .toast[data-variant='info'] {
    border-left: 3px solid var(--accent, #2563eb);
  }

  .toast-message {
    flex: 1;
  }

  .toast-dismiss {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 1.25rem;
    height: 1.25rem;
    font-size: 1rem;
    line-height: 1;
    color: var(--text-muted, #6b7280);
    background: none;
    border: none;
    cursor: pointer;
    border-radius: var(--radius-sm, 0.25rem);
  }

  .toast-dismiss:hover {
    color: var(--text, #111);
    background: var(--surface-hover, #f3f4f6);
  }
</style>
