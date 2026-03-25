<script lang="ts" module>
  import type { WorkflowEvent } from '../api-client.ts';

  export type EventTimelineProps = {
    events: WorkflowEvent[];
  };
</script>

<script lang="ts">
  import EventTimelineItem from './event-timeline-item.svelte';

  let { events }: EventTimelineProps = $props();
</script>

{#if events.length > 0}
  <div class="timeline">
    {#each events as event (event.timestamp + event.type)}
      <EventTimelineItem {event} />
    {/each}
  </div>
{:else}
  <p class="text-muted" style="font-size: var(--text-sm, 0.875rem);">No events recorded.</p>
{/if}
