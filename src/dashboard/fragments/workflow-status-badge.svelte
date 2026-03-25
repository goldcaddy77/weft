<script lang="ts" module>
  import type { WorkflowStatus } from '../api-client.ts';
  import type { BadgeVariant } from '../components/badge.svelte';

  export type WorkflowStatusBadgeProps = {
    status: WorkflowStatus;
  };

  const STATUS_VARIANT_MAP: Record<WorkflowStatus, BadgeVariant> = {
    pending: 'default',
    running: 'accent',
    completed: 'success',
    failed: 'danger',
    cancelled: 'warning',
    'timed-out': 'danger',
  };

  const STATUS_LABEL_MAP: Record<WorkflowStatus, string> = {
    pending: 'Pending',
    running: 'Running',
    completed: 'Completed',
    failed: 'Failed',
    cancelled: 'Cancelled',
    'timed-out': 'Timed Out',
  };
</script>

<script lang="ts">
  import { play, checkCircle, xCircle, clock, ban, alertTriangle } from '../icons.ts';
  import Badge from '../components/badge.svelte';

  let { status }: WorkflowStatusBadgeProps = $props();

  const variant = $derived(STATUS_VARIANT_MAP[status]);
  const label = $derived(STATUS_LABEL_MAP[status]);

  const iconHtml = $derived.by(() => {
    switch (status) {
      case 'pending':
        return clock(12);
      case 'running':
        return play(12);
      case 'completed':
        return checkCircle(12);
      case 'failed':
        return xCircle(12);
      case 'cancelled':
        return ban(12);
      case 'timed-out':
        return alertTriangle(12);
    }
  });
</script>

<Badge {variant} {label} icon={iconHtml} />
