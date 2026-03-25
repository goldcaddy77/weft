<script lang="ts" module>
  export type JsonViewerProps = {
    data: unknown;
    label?: string;
    collapsed?: boolean;
  };
</script>

<script lang="ts">
  import { chevronRight } from '../icons.ts';

  let { data, label, collapsed = false }: JsonViewerProps = $props();

  let isCollapsed = $state(collapsed);

  const formatted = $derived.by(() => {
    if (data === null || data === undefined) return null;
    try {
      return JSON.stringify(data, null, 2);
    } catch {
      return String(data);
    }
  });

  function toggle(): void {
    isCollapsed = !isCollapsed;
  }
</script>

{#if formatted === null}
  <span class="text-muted">-</span>
{:else}
  <div class="json-viewer">
    <button class="json-viewer-toggle" onclick={toggle} type="button">
      <span class="json-viewer-chevron" data-expanded={!isCollapsed}>
        {@html chevronRight(14)}
      </span>
      {#if label}
        <span class="json-viewer-label">{label}</span>
      {/if}
    </button>
    {#if !isCollapsed}
      <pre class="json-viewer-content"><code>{formatted}</code></pre>
    {/if}
  </div>
{/if}

<style>
  .json-viewer {
    display: flex;
    flex-direction: column;
    gap: var(--space-1, 0.25rem);
  }

  .json-viewer-toggle {
    display: inline-flex;
    align-items: center;
    gap: var(--space-1, 0.25rem);
    font-size: var(--text-xs, 0.75rem);
    color: var(--text-muted, #6b7280);
    cursor: pointer;
    user-select: none;
  }

  .json-viewer-toggle:hover {
    color: var(--text, #111827);
  }

  .json-viewer-chevron {
    display: inline-flex;
    transition: transform var(--duration-fast, 150ms) var(--ease-standard, ease);
  }

  .json-viewer-chevron[data-expanded='true'] {
    transform: rotate(90deg);
  }

  .json-viewer-label {
    font-weight: var(--font-medium, 500);
  }

  .json-viewer-content {
    font-size: var(--text-xs, 0.75rem);
    line-height: var(--leading-relaxed, 1.625);
    max-height: 24rem;
    overflow: auto;
  }
</style>
