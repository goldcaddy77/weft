<script lang="ts" module>
  import type { AgentTurnData } from './agent-turn-types.ts';

  export type AgentCostWaterfallProps = {
    turns: readonly AgentTurnData[];
  };
</script>

<script lang="ts">
  import { buildTurnUsageRowsFromTurnData } from './agent-cost-waterfall.ts';

  let { turns }: AgentCostWaterfallProps = $props();

  const rows = $derived(buildTurnUsageRowsFromTurnData(turns));
</script>

{#if rows.length === 0}
  <p class="empty">No turn usage data yet.</p>
{:else}
  <table class="usage-table">
    <thead>
      <tr>
        <th scope="col">Turn</th>
        <th scope="col">Input</th>
        <th scope="col">Output</th>
        <th scope="col">Status</th>
      </tr>
    </thead>
    <tbody>
      {#each rows as row (row.turnNumber)}
        <tr>
          <td>{row.turnNumber + 1}</td>
          <td>{row.inputTokens ?? 'n/a'}</td>
          <td>{row.outputTokens ?? 'n/a'}</td>
          <td>
            {#if row.unavailable}
              <span class="badge">unavailable</span>
            {:else}
              <span class="status">reported</span>
            {/if}
          </td>
        </tr>
      {/each}
    </tbody>
  </table>
{/if}

<style>
  .empty {
    margin: 0;
    padding: var(--space-2, 0.5rem) 0;
    color: var(--text-muted, #6b7280);
    font-size: var(--text-sm, 0.875rem);
  }

  .usage-table {
    width: 100%;
    border-collapse: collapse;
    font-size: var(--text-sm, 0.875rem);
    table-layout: fixed;
  }

  th,
  td {
    padding: var(--space-2, 0.5rem);
    border-bottom: 1px solid var(--border-muted, #e5e7eb);
    text-align: left;
    vertical-align: middle;
  }

  th {
    color: var(--text-muted, #6b7280);
    font-weight: 600;
  }

  .badge {
    display: inline-flex;
    align-items: center;
    min-height: 1.5rem;
    padding: 0 var(--space-2, 0.5rem);
    border-radius: 4px;
    background: var(--surface-muted, #f3f4f6);
    color: var(--text-muted, #6b7280);
    font-size: var(--text-xs, 0.75rem);
  }

  .status {
    color: var(--text-muted, #6b7280);
    font-size: var(--text-xs, 0.75rem);
  }
</style>
