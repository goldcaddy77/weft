<script lang="ts" module>
  import type { Snippet } from 'svelte';

  export type PageProps = {
    title: string;
    subtitle?: string;
    description?: string;
    /** HTML string icon to show before title */
    icon?: string;
    actions?: Snippet;
    children: Snippet;
  };
</script>

<script lang="ts">
  let {
    title,
    subtitle,
    description,
    icon,
    actions,
    children,
  }: PageProps = $props();
</script>

<header class="page-header">
  <div class="page-header-container">
    <div class="page-header-row">
      <div class="page-header-leading">
        {#if icon}
          <span class="page-header-icon" aria-hidden="true">{@html icon}</span>
        {/if}
        <div class="page-header-title-group">
          <h1 class="page-header-title">{title}</h1>
          {#if subtitle}
            <p class="page-header-subtitle">{subtitle}</p>
          {/if}
          {#if description}
            <p class="page-header-description">{description}</p>
          {/if}
        </div>
      </div>

      {#if actions}
        <div class="page-header-actions">
          {@render actions()}
        </div>
      {/if}
    </div>
  </div>
</header>

<div class="page-content">
  {@render children()}
</div>

<style>
  .page-header {
    position: sticky;
    top: 0;
    z-index: 10;
    border-bottom: 1px solid var(--border-muted, #e5e7eb);
    padding-block: var(--space-3, 0.75rem);
    background: color-mix(in oklch, var(--surface, #fff), transparent 20%);
    backdrop-filter: blur(24px);
  }

  .page-header-container {
    max-width: 72rem;
    margin-inline: auto;
    padding-inline: var(--space-4, 1rem);
  }

  @media (min-width: 640px) {
    .page-header-container {
      padding-inline: var(--space-6, 1.5rem);
    }
  }

  .page-header-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
  }

  .page-header-leading {
    display: flex;
    align-items: center;
    gap: var(--space-3, 0.75rem);
  }

  .page-header-icon {
    display: inline-flex;
    color: var(--text-muted, #6b7280);
  }

  .page-header-icon :global(svg) {
    width: 1.5rem;
    height: 1.5rem;
  }

  .page-header-title-group {
    min-width: 0;
  }

  .page-header-title {
    font-size: var(--text-lg, 1.125rem);
    font-weight: var(--font-semibold, 600);
    color: var(--text, #111827);
  }

  .page-header-subtitle {
    font-size: var(--text-sm, 0.875rem);
    color: var(--text-muted, #6b7280);
    margin-top: 0.125rem;
  }

  .page-header-description {
    font-size: var(--text-sm, 0.875rem);
    color: var(--text-subtle, #9ca3af);
    margin-top: var(--space-1, 0.25rem);
  }

  .page-header-actions {
    display: flex;
    align-items: center;
    gap: var(--space-2, 0.5rem);
  }

  .page-content {
    flex: 1 1 0;
    min-height: 0;
    width: 100%;
    max-width: 72rem;
    margin-inline: auto;
    padding-inline: var(--space-4, 1rem);
    padding-block: var(--space-6, 1.5rem);
    display: flex;
    flex-direction: column;
    gap: var(--space-6, 1.5rem);
  }

  @media (min-width: 640px) {
    .page-content {
      padding-inline: var(--space-6, 1.5rem);
    }
  }
</style>
