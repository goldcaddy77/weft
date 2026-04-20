<script lang="ts" module>
  import type { WorkflowSummary } from '../api-client.ts';

  export type WorkflowTableRowProps = {
    workflow: WorkflowSummary;
  };
</script>

<script lang="ts">
  import { navigate } from '../router.svelte.ts';
  import Badge from '../components/badge.svelte';
  import { truncate } from '../utilities/truncate.ts';
  import { formatRelativeTime } from '../utilities/format-date.ts';
  import WorkflowStatusBadge from './workflow-status-badge.svelte';

  let { workflow }: WorkflowTableRowProps = $props();

  function handleClick(): void {
    navigate(`/ui/workflows/${encodeURIComponent(workflow.id)}`);
  }

  function handleKeydown(event: KeyboardEvent): void {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      handleClick();
    }
  }
</script>

<tr onclick={handleClick} onkeydown={handleKeydown} role="link" tabindex="0">
  <td>
    <div class="workflow-identity">
      <span class="font-mono">{truncate(workflow.id, 12)}</span>
      {#if workflow.tags && workflow.tags.length > 0}
        <div class="workflow-tags">
          {#each workflow.tags as tag (tag)}
            <Badge size="xs" variant="accent" label={tag} />
          {/each}
        </div>
      {/if}
    </div>
  </td>
  <td>{workflow.type}</td>
  <td>
    <WorkflowStatusBadge status={workflow.status} />
  </td>
  <td>{workflow.version}</td>
  <td class="text-muted">{formatRelativeTime(workflow.createdAt)}</td>
  <td class="text-muted">{formatRelativeTime(workflow.updatedAt)}</td>
</tr>

<style>
  .workflow-identity {
    display: flex;
    flex-direction: column;
    gap: var(--space-1, 0.25rem);
  }

  .workflow-tags {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-1, 0.25rem);
  }
</style>
