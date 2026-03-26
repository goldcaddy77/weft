<script lang="ts" module>
  export type AgentBudgetGaugeProps = {
    tokensUsed: number;
    tokenBudget: number | undefined;
    costUsed: number;
    maxCost: number | undefined;
  };
</script>

<script lang="ts">
  import { formatTokenCount, formatCost } from '../utilities/format-number.ts';

  let { tokensUsed, tokenBudget, costUsed, maxCost }: AgentBudgetGaugeProps = $props();

  const tokenPercentage = $derived(
    tokenBudget !== undefined && tokenBudget > 0
      ? Math.min((tokensUsed / tokenBudget) * 100, 100)
      : 0,
  );

  const costPercentage = $derived(
    maxCost !== undefined && maxCost > 0 ? Math.min((costUsed / maxCost) * 100, 100) : 0,
  );

  const displayPercentage = $derived(Math.max(tokenPercentage, costPercentage));

  const isWarning = $derived(displayPercentage >= 80 && displayPercentage < 100);
  const isExceeded = $derived(displayPercentage >= 100);
</script>

<div class="agent-budget">
  <div class="agent-budget-header">
    <span class="agent-budget-label">Budget Usage</span>
    <span class="agent-budget-percentage" class:warning={isWarning} class:exceeded={isExceeded}>
      {displayPercentage.toFixed(0)}%
    </span>
  </div>

  <div class="budget-gauge">
    <div
      class="budget-gauge-fill"
      style="width: {displayPercentage}%"
      data-warning={isWarning || undefined}
      data-exceeded={isExceeded || undefined}
    ></div>
  </div>

  <div class="agent-budget-details">
    <div class="agent-budget-detail">
      <span class="agent-budget-detail-label">Tokens</span>
      <span class="agent-budget-detail-value font-mono">
        {formatTokenCount(tokensUsed) ?? '0'}
        {#if tokenBudget !== undefined}
          / {formatTokenCount(tokenBudget)}
        {/if}
      </span>
    </div>
    <div class="agent-budget-detail">
      <span class="agent-budget-detail-label">Cost</span>
      <span class="agent-budget-detail-value font-mono">
        {formatCost(costUsed)}
        {#if maxCost !== undefined}
          / {formatCost(maxCost)}
        {/if}
      </span>
    </div>
  </div>
</div>

<style>
  .agent-budget {
    display: flex;
    flex-direction: column;
    gap: var(--space-2, 0.5rem);
  }

  .agent-budget-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
  }

  .agent-budget-label {
    font-size: var(--text-sm, 0.875rem);
    font-weight: var(--font-medium, 500);
    color: var(--text, #111827);
  }

  .agent-budget-percentage {
    font-size: var(--text-sm, 0.875rem);
    font-weight: var(--font-semibold, 600);
    font-family: var(--font-mono, monospace);
    color: var(--text, #111827);
  }

  .agent-budget-percentage.warning {
    color: var(--warning, #d97706);
  }

  .agent-budget-percentage.exceeded {
    color: var(--danger, #dc2626);
  }

  .agent-budget-details {
    display: flex;
    gap: var(--space-4, 1rem);
  }

  .agent-budget-detail {
    display: flex;
    flex-direction: column;
    gap: var(--space-0-5, 0.125rem);
  }

  .agent-budget-detail-label {
    font-size: var(--text-xs, 0.75rem);
    color: var(--text-muted, #6b7280);
  }

  .agent-budget-detail-value {
    font-size: var(--text-xs, 0.75rem);
  }
</style>
