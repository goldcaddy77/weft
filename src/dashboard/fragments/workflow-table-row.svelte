<script lang="ts" module>
  import type { WorkflowSummary } from '../api-client.ts';

  export type WorkflowTableRowProps = {
    workflow: WorkflowSummary;
  };
</script>

<script lang="ts">
  import { navigate } from '../router.ts';
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
    <span class="font-mono">{truncate(workflow.id, 12)}</span>
  </td>
  <td>{workflow.type}</td>
  <td>
    <WorkflowStatusBadge status={workflow.status} />
  </td>
  <td>{workflow.version}</td>
  <td class="text-muted">{formatRelativeTime(workflow.createdAt)}</td>
  <td class="text-muted">{formatRelativeTime(workflow.updatedAt)}</td>
</tr>
