<script lang="ts" module>
  export type ExecutionDeadlineProps = {
    deadline: number | undefined;
    /** Workflow creation timestamp, used to derive the configured timeout duration. */
    createdAt?: number | undefined;
  };
</script>

<script lang="ts">
  import { formatDuration } from '../utilities/format-duration.ts';
  import { clock } from '../icons.ts';

  let { deadline, createdAt }: ExecutionDeadlineProps = $props();

  let remaining = $state('');
  let expired = $state(false);

  const configuredTimeout = $derived.by(() => {
    if (deadline === undefined || createdAt === undefined) return undefined;
    const total = deadline - createdAt;
    return total > 0 ? formatDuration(total) : undefined;
  });

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

<div class="execution-deadline" aria-live="polite" aria-atomic="true">
  <span class="execution-deadline-icon" aria-hidden="true">{@html clock(14)}</span>
  {#if deadline === undefined}
    <span class="text-muted">No deadline</span>
  {:else}
    <div class="execution-deadline-details">
      {#if configuredTimeout !== undefined}
        <span class="execution-deadline-label">Timeout: {configuredTimeout}</span>
      {/if}
      <span class="execution-deadline-value" data-expired={expired}>
        {remaining}
      </span>
    </div>
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

  .execution-deadline-details {
    display: flex;
    flex-direction: column;
    gap: var(--space-0-5, 0.125rem);
  }

  .execution-deadline-label {
    color: var(--text-muted, #6b7280);
    font-size: var(--text-xs, 0.75rem);
  }

  .execution-deadline-value {
    font-weight: var(--font-medium, 500);
    font-family: var(--font-mono, monospace);
  }

  .execution-deadline-value[data-expired='true'] {
    color: var(--danger, #dc2626);
  }
</style>
