<script lang="ts" module>
  import type { WorkflowEvent } from '../api-client.ts';

  export type EventTimelineItemProps = {
    event: WorkflowEvent;
  };

  type TimelineStatus = 'completed' | 'failed' | 'running' | 'info' | 'neutral';

  function mapEventTypeToStatus(eventType: string): TimelineStatus {
    if (eventType === 'workflow:completed' || eventType === 'activity:completed') return 'completed';
    if (
      eventType === 'workflow:failed' ||
      eventType === 'workflow:cancelled' ||
      eventType === 'workflow:timed-out' ||
      eventType === 'activity:failed'
    )
      return 'failed';
    if (eventType === 'workflow:started' || eventType === 'activity:started') return 'running';
    if (eventType.startsWith('signal:')) return 'info';
    return 'neutral';
  }

  function formatEventLabel(eventType: string): string {
    return eventType
      .split(':')
      .map((segment) => segment.charAt(0).toUpperCase() + segment.slice(1))
      .join(' ');
  }
</script>

<script lang="ts">
  import { formatTimestamp } from '../utilities/format-date.ts';

  let { event }: EventTimelineItemProps = $props();

  const status = $derived(mapEventTypeToStatus(event.type));
  const label = $derived(formatEventLabel(event.type));

  const relevantData = $derived.by(() => {
    const { type: _type, timestamp: _timestamp, ...rest } = event.data;
    return Object.keys(rest).length > 0 ? rest : null;
  });
</script>

<div class="timeline-item" data-status={status}>
  <div class="timeline-item-header">
    <span class="timeline-item-label">{label}</span>
    <span class="timeline-item-time text-muted">{formatTimestamp(event.timestamp)}</span>
  </div>
  {#if relevantData}
    <div class="timeline-item-data">
      {#each Object.entries(relevantData) as [key, value]}
        <span class="timeline-item-datum">
          <span class="timeline-item-datum-key">{key}:</span>
          <span class="timeline-item-datum-value">
            {typeof value === 'object' ? JSON.stringify(value) : String(value)}
          </span>
        </span>
      {/each}
    </div>
  {/if}
</div>

<style>
  .timeline-item-header {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: var(--space-2, 0.5rem);
    margin-bottom: var(--space-1, 0.25rem);
  }

  .timeline-item-label {
    font-size: var(--text-sm, 0.875rem);
    font-weight: var(--font-medium, 500);
    color: var(--text, #111827);
  }

  .timeline-item-time {
    font-size: var(--text-xs, 0.75rem);
    white-space: nowrap;
  }

  .timeline-item-data {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-1, 0.25rem) var(--space-3, 0.75rem);
    font-size: var(--text-xs, 0.75rem);
    color: var(--text-muted, #6b7280);
  }

  .timeline-item-datum-key {
    color: var(--text-subtle, #9ca3af);
  }

  .timeline-item-datum-value {
    font-family: var(--font-mono, monospace);
    word-break: break-all;
  }
</style>
