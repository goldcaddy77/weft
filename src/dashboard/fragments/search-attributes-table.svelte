<script lang="ts" module>
  export type SearchAttributesTableProps = {
    attributes: Record<string, unknown>;
  };
</script>

<script lang="ts">
  let { attributes }: SearchAttributesTableProps = $props();

  const entries = $derived(Object.entries(attributes));

  function formatAttributeValue(value: unknown): string {
    if (value === null || value === undefined) return '-';
    if (value instanceof Date) return value.toISOString();
    if (typeof value === 'object') return JSON.stringify(value);
    return String(value);
  }
</script>

{#if entries.length > 0}
  <table class="attributes-table">
    <tbody>
      {#each entries as [key, value]}
        <tr>
          <td class="attribute-key">{key}</td>
          <td class="attribute-value font-mono">{formatAttributeValue(value)}</td>
        </tr>
      {/each}
    </tbody>
  </table>
{:else}
  <p class="text-muted" style="font-size: var(--text-sm, 0.875rem);">No search attributes.</p>
{/if}

<style>
  .attributes-table {
    width: 100%;
    border-collapse: collapse;
  }

  .attributes-table td {
    padding: var(--space-1-5, 0.375rem) var(--space-2, 0.5rem);
    font-size: var(--text-xs, 0.75rem);
    border-bottom: 1px solid var(--divider, #e5e7eb);
    vertical-align: top;
  }

  .attribute-key {
    color: var(--text-muted, #6b7280);
    white-space: nowrap;
    width: 1%;
    font-weight: var(--font-medium, 500);
  }

  .attribute-value {
    word-break: break-all;
  }
</style>
