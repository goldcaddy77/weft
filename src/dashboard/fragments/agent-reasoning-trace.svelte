<script lang="ts" module>
  import type { AgentTurnData } from './agent-turn-types.ts';

  export type AgentReasoningTraceProps = {
    turns: readonly AgentTurnData[];
  };
</script>

<script lang="ts">
  import { buildReasoningEntries } from './agent-reasoning-trace.ts';

  let { turns }: AgentReasoningTraceProps = $props();

  const entries = $derived(buildReasoningEntries(turns));
</script>

{#if entries.length === 0}
  <p class="empty">No reasoning traces captured for this run.</p>
{:else}
  <div class="reasoning">
    {#each entries as entry (entry.turnIndex)}
      <details class="reasoning-entry">
        <summary>Turn {entry.turnIndex + 1} — {entry.model}</summary>
        <pre>{entry.trace}</pre>
      </details>
    {/each}
  </div>
{/if}

<style>
  .empty {
    margin: 0;
    padding: var(--space-2, 0.5rem) 0;
    color: var(--text-muted, #6b7280);
    font-size: var(--text-sm, 0.875rem);
  }

  .reasoning {
    display: flex;
    flex-direction: column;
    gap: var(--space-2, 0.5rem);
  }

  .reasoning-entry {
    border: 1px solid var(--border-muted, #e5e7eb);
    border-radius: var(--radius-md, 0.375rem);
    padding: var(--space-2, 0.5rem) var(--space-3, 0.75rem);
  }

  summary {
    cursor: pointer;
    font-size: var(--text-sm, 0.875rem);
    font-weight: var(--font-medium, 500);
    color: var(--text, #111827);
  }

  pre {
    margin: var(--space-2, 0.5rem) 0 0;
    padding: var(--space-2, 0.5rem);
    background: var(--surface-inset, #f3f4f6);
    border-radius: var(--radius-sm, 0.25rem);
    white-space: pre-wrap;
    word-break: break-word;
    font-family: var(--font-mono, monospace);
    font-size: var(--text-xs, 0.75rem);
    line-height: var(--leading-relaxed, 1.625);
  }
</style>
