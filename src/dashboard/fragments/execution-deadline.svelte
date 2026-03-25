<script lang="ts" module>
  export type ExecutionDeadlineProps = {
    deadline: number | undefined;
  };
</script>

<script lang="ts">
  import { formatDuration } from '../utilities/format-duration.ts';
  import { clock } from '../icons.ts';

  let { deadline }: ExecutionDeadlineProps = $props();

  let remaining = $state('');
  let expired = $state(false);

  $effect(() => {
    if (deadline === undefined) return;

    function update(): void {
      const now = Date.now();
      const delta = deadline! - now;

      if (delta <= 0) {
        remaining = 'Expired';
        expired = true;
      } else {
        remaining = formatDuration(delta);
        expired = false;
      }
    }

    update();
    const interval = setInterval(update, 1_000);

    return () => {
      clearInterval(interval);
    };
  });
</script>

<div class="execution-deadline">
  <span class="execution-deadline-icon" aria-hidden="true">{@html clock(14)}</span>
  {#if deadline === undefined}
    <span class="text-muted">No deadline</span>
  {:else}
    <span class="execution-deadline-value" data-expired={expired}>
      {remaining}
    </span>
  {/if}
</div>

<style>
  .execution-deadline {
    display: flex;
    align-items: center;
    gap: var(--space-2, 0.5rem);
    font-size: var(--text-sm, 0.875rem);
  }

  .execution-deadline-icon {
    display: inline-flex;
    color: var(--text-muted, #6b7280);
  }

  .execution-deadline-value {
    font-weight: var(--font-medium, 500);
    font-family: var(--font-mono, monospace);
  }

  .execution-deadline-value[data-expired='true'] {
    color: var(--danger, #dc2626);
  }
</style>
