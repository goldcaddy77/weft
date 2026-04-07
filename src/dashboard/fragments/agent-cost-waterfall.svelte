<script lang="ts" module>
  import type { AgentTurnData } from './agent-turn-types.ts';

  export type AgentCostWaterfallProps = {
    turns: readonly AgentTurnData[];
  };
</script>

<script lang="ts">
  import { formatCost } from '../utilities/format-number.ts';
  import { computeWaterfallBars } from './agent-cost-waterfall.ts';

  let { turns }: AgentCostWaterfallProps = $props();

  const bars = $derived(computeWaterfallBars(turns));
  const rowHeight = 24;
  const viewBoxHeight = $derived(Math.max(rowHeight, bars.length * rowHeight));
</script>

{#if bars.length === 0}
  <p class="empty">No turn cost data yet.</p>
{:else}
  <svg
    class="waterfall"
    role="img"
    aria-label="Per-turn cost waterfall"
    viewBox={`0 0 100 ${viewBoxHeight}`}
    preserveAspectRatio="xMinYMin meet"
  >
    {#each bars as bar, index (bar.turnIndex)}
      <g transform={`translate(0, ${index * rowHeight})`}>
        <title>{bar.ariaLabel}</title>
        <rect
          class="waterfall-bar"
          x="0"
          y="4"
          width={bar.widthPercentage}
          height={rowHeight - 8}
          rx="1"
        ></rect>
        <text class="waterfall-label" x="1" y={rowHeight / 2 + 3}>
          Turn {bar.turnIndex + 1} · {bar.model} · {formatCost(bar.cost)}
        </text>
      </g>
    {/each}
  </svg>
{/if}

<style>
  .empty {
    margin: 0;
    padding: var(--space-2, 0.5rem) 0;
    color: var(--text-muted, #6b7280);
    font-size: var(--text-sm, 0.875rem);
  }

  .waterfall {
    display: block;
    width: 100%;
    height: auto;
  }

  .waterfall-bar {
    fill: var(--accent, #6366f1);
    opacity: 0.85;
  }

  .waterfall-label {
    /* SVG user units, not CSS pixels — the viewBox is 100 units wide so 5
       gives roughly the same apparent size as 0.875rem on a typical display. */
    font-size: 5;
    font-family: var(--font-mono, monospace);
    fill: var(--text, #111827);
    dominant-baseline: middle;
  }
</style>
