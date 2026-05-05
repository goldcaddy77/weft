<script lang="ts" module>
  import type { AgentTurnData } from './agent-turn-types.ts';
  export type { AgentTurnData } from './agent-turn-types.ts';

  export type AgentTurnProps = {
    turn: AgentTurnData;
  };
</script>

<script lang="ts">
  import { formatTokenCount } from '../utilities/format-number.ts';
  import { bot, chevronRight } from '../icons.ts';
  import Badge from '../components/badge.svelte';
  import JsonViewer from './json-viewer.svelte';

  let { turn }: AgentTurnProps = $props();

  let toolCallsExpanded = $state(false);

  function toggleToolCalls(): void {
    toolCallsExpanded = !toolCallsExpanded;
  }
</script>

<div class="agent-turn">
  <div class="agent-turn-header">
    <div class="agent-turn-header-left">
      <span class="agent-turn-icon" aria-hidden="true">{@html bot(16)}</span>
      <span class="agent-turn-index">Turn {turn.turnIndex + 1}</span>
      <Badge variant="accent" label={turn.model} size="xs" />
    </div>
    <div class="agent-turn-header-right">
      <span class="agent-turn-tokens">
        {formatTokenCount(turn.inputTokens) ?? '0'} in /
        {formatTokenCount(turn.outputTokens) ?? '0'} out
      </span>
    </div>
  </div>

  {#if turn.response}
    <div class="agent-turn-response">
      <p>{turn.response}</p>
    </div>
  {/if}

  {#if turn.toolCalls.length > 0}
    <div class="agent-turn-tool-calls">
      <button class="agent-turn-tool-calls-toggle" onclick={toggleToolCalls} type="button">
        <span class="agent-turn-tool-calls-chevron" data-expanded={toolCallsExpanded}>
          {@html chevronRight(14)}
        </span>
        <span>
          {turn.toolCalls.length} tool call{turn.toolCalls.length !== 1 ? 's' : ''}
        </span>
      </button>
      {#if toolCallsExpanded}
        <div class="agent-turn-tool-calls-list">
          {#each turn.toolCalls as toolCall, index (index)}
            <div class="agent-turn-tool-call">
              <div class="agent-turn-tool-call-name font-mono">{toolCall.name}</div>
              <JsonViewer data={toolCall.input} label="Input" collapsed />
              <JsonViewer data={toolCall.output} label="Output" collapsed />
            </div>
            {#if index < turn.toolCalls.length - 1}
              <hr />
            {/if}
          {/each}
        </div>
      {/if}
    </div>
  {/if}
</div>

<style>
  .agent-turn {
    border: 1px solid var(--border-muted, #e5e7eb);
    border-radius: var(--radius-md, 0.375rem);
    overflow: hidden;
  }

  .agent-turn-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--space-3, 0.75rem);
    padding: var(--space-2, 0.5rem) var(--space-3, 0.75rem);
    background: var(--surface-inset, #f3f4f6);
    border-bottom: 1px solid var(--border-muted, #e5e7eb);
    flex-wrap: wrap;
  }

  .agent-turn-header-left {
    display: flex;
    align-items: center;
    gap: var(--space-2, 0.5rem);
  }

  .agent-turn-icon {
    display: inline-flex;
    color: var(--text-muted, #6b7280);
  }

  .agent-turn-index {
    font-size: var(--text-sm, 0.875rem);
    font-weight: var(--font-medium, 500);
  }

  .agent-turn-header-right {
    display: flex;
    align-items: center;
    gap: var(--space-3, 0.75rem);
    font-size: var(--text-xs, 0.75rem);
    color: var(--text-muted, #6b7280);
  }

  .agent-turn-tokens {
    font-family: var(--font-mono, monospace);
  }

  .agent-turn-cost {
    font-family: var(--font-mono, monospace);
    font-weight: var(--font-medium, 500);
  }

  .agent-turn-response {
    padding: var(--space-3, 0.75rem);
    font-size: var(--text-sm, 0.875rem);
    line-height: var(--leading-relaxed, 1.625);
    white-space: pre-wrap;
    word-break: break-word;
  }

  .agent-turn-tool-calls {
    border-top: 1px solid var(--border-muted, #e5e7eb);
  }

  .agent-turn-tool-calls-toggle {
    display: flex;
    align-items: center;
    gap: var(--space-1, 0.25rem);
    width: 100%;
    padding: var(--space-2, 0.5rem) var(--space-3, 0.75rem);
    font-size: var(--text-xs, 0.75rem);
    color: var(--text-muted, #6b7280);
    cursor: pointer;
  }

  .agent-turn-tool-calls-toggle:hover {
    background: var(--surface-hover, #f9fafb);
    color: var(--text, #111827);
  }

  .agent-turn-tool-calls-chevron {
    display: inline-flex;
    transition: transform var(--duration-fast, 150ms) var(--ease-standard, ease);
  }

  .agent-turn-tool-calls-chevron[data-expanded='true'] {
    transform: rotate(90deg);
  }

  .agent-turn-tool-calls-list {
    padding: var(--space-2, 0.5rem) var(--space-3, 0.75rem);
    display: flex;
    flex-direction: column;
    gap: var(--space-2, 0.5rem);
  }

  .agent-turn-tool-call {
    display: flex;
    flex-direction: column;
    gap: var(--space-1, 0.25rem);
  }

  .agent-turn-tool-call-name {
    font-size: var(--text-xs, 0.75rem);
    font-weight: var(--font-medium, 500);
    color: var(--text, #111827);
  }

  .agent-turn-tool-calls-list hr {
    border: none;
    border-top: 1px solid var(--divider, #e5e7eb);
    margin: var(--space-1, 0.25rem) 0;
  }
</style>
