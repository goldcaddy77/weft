<script lang="ts">
  import { setContext } from 'svelte';

  import { ApiClient } from './api-client.ts';
  import type { Toast } from './toast-context.ts';
  import { moon, sun, activity, cpu, inbox } from './icons.ts';
  import { matchRoute, navigate, route } from './router.svelte.ts';
  import NavigationBar from './components/navigation-bar.svelte';
  import NavigationItem from './components/navigation-item.svelte';
  import WorkflowList from './views/workflow-list.svelte';
  import WorkflowDetail from './views/workflow-detail.svelte';
  import HumanReviewQueue from './views/human-review-queue.svelte';
  import NotFound from './views/not-found.svelte';
  import WorkersAndQueues from './views/workers-and-queues.svelte';

  // ---------------------------------------------------------------------------
  // Context providers
  // ---------------------------------------------------------------------------

  const apiClient = new ApiClient();
  setContext('api-client', apiClient);

  const toasts: Toast[] = $state([]);

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
  <header class="navigation-header">
    <NavigationBar class="navigation-bar">
      {#snippet start()}
        <a
          href="/"
          class="navigation-bar-brand"
          onclick={(event: MouseEvent) => handleNavigationClick(event, '/')}
        >
          {@html activity(20)}
          <span>Weft</span>
        </a>
      {/snippet}

      <NavigationItem
        href="/workflows"
        active={currentMatch.view === 'workflow-list' ||
          currentMatch.view === 'workflow-detail'}
        onclick={(event: MouseEvent) => handleNavigationClick(event, '/workflows')}
      >
        Workflows
      </NavigationItem>
      <NavigationItem
        href="/reviews"
        active={currentMatch.view === 'human-review-queue'}
        onclick={(event: MouseEvent) => handleNavigationClick(event, '/reviews')}
      >
        {@html inbox(16)}
        Reviews
      </NavigationItem>
      <NavigationItem
        href="/workers"
        active={currentMatch.view === 'workers-and-queues'}
        onclick={(event: MouseEvent) => handleNavigationClick(event, '/workers')}
      >
        {@html cpu(16)}
        Workers
      </NavigationItem>

      {#snippet end()}
        <button class="theme-toggle" onclick={toggleTheme} aria-label="Toggle theme">
          {#if darkMode}
            {@html sun(18)}
          {:else}
            {@html moon(18)}
          {/if}
        </button>
      {/snippet}
    </NavigationBar>
  </header>

  <!-- Main Content -->
  <main class="dashboard-content">
    {#if currentMatch.view === 'workflow-list'}
      <WorkflowList />
    {:else if currentMatch.view === 'workflow-detail'}
      <WorkflowDetail id={currentMatch.params['id'] ?? ''} />
    {:else if currentMatch.view === 'human-review-queue'}
      <HumanReviewQueue />
    {:else if currentMatch.view === 'workers-and-queues'}
      <WorkersAndQueues />
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

  /* Navigation Header */
  .navigation-header {
    padding: 0 var(--space-4, 1rem);
    background: var(--surface, #fff);
    border-bottom: 1px solid var(--border, #e5e7eb);
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
