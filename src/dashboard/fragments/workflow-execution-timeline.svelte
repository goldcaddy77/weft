<script lang="ts" module>
  import type {
    WorkflowReplay,
    WorkflowTimelineEntry,
    WorkflowTimelineStatus,
  } from '../../core/types.ts';
  import type { BadgeVariant } from '../components/badge.svelte';
  import type { WorkflowTimelineDiffRow } from './workflow-execution-timeline.ts';

  export type WorkflowExecutionTimelineProps = {
    timeline: WorkflowTimelineEntry[];
    selectedStep?: number | null;
    selectedReplay?: WorkflowReplay | null;
    selectedReplayLoading?: boolean;
    selectedReplayError?: string | null;
    diffRows?: WorkflowTimelineDiffRow[];
    diffLoading?: boolean;
    diffError?: string | null;
    fromStep?: string;
    toStep?: string;
    onSelectStep?: (step: number) => void | Promise<void>;
    onCompareSteps?: () => void | Promise<void>;
  };

  const STATUS_VARIANTS: Record<WorkflowTimelineStatus, BadgeVariant> = {
    running: 'accent',
    completed: 'success',
    failed: 'danger',
    cancelled: 'warning',
    'timed-out': 'danger',
  };

  const SECTION_LABELS: Record<WorkflowTimelineDiffRow['section'], string> = {
    locals: 'Locals',
    searchAttributes: 'Search attributes',
    budget: 'Budget',
    conversation: 'Conversation',
  };

  function getStatusVariant(status: WorkflowTimelineStatus): BadgeVariant {
    return STATUS_VARIANTS[status];
  }

  function getSectionLabel(section: WorkflowTimelineDiffRow['section']): string {
    return SECTION_LABELS[section];
  }

  function formatStepDuration(duration: number | undefined): string {
    return duration === undefined ? 'pending' : `${duration}ms`;
  }
</script>

<script lang="ts">
  import Alert from '../components/alert.svelte';
  import Badge from '../components/badge.svelte';
  import Button from '../components/button.svelte';
  import Select from '../components/select.svelte';
  import { formatTimestamp } from '../utilities/format-date.ts';
  import JsonViewer from './json-viewer.svelte';
  import { formatTimelineDiffValue } from './workflow-execution-timeline.ts';

  let {
    timeline,
    selectedStep = null,
    selectedReplay = null,
    selectedReplayLoading = false,
    selectedReplayError = null,
    diffRows = [],
    diffLoading = false,
    diffError = null,
    fromStep = $bindable(''),
    toStep = $bindable(''),
    onSelectStep,
    onCompareSteps,
  }: WorkflowExecutionTimelineProps = $props();

  const canCompare = $derived(
    timeline.length >= 2 && fromStep !== '' && toStep !== '' && fromStep !== toStep && !diffLoading,
  );

  function selectStep(step: number): void {
    void onSelectStep?.(step);
  }

  function compareSteps(): void {
    void onCompareSteps?.();
  }
</script>

<div class="workflow-execution-timeline">
  <div class="timeline-header">
    <div>
      <h3 id="workflow-execution-timeline-title">Structured Timeline</h3>
      <p>
        Durable checkpoint steps with operation summaries and replay state.
      </p>
    </div>
    <span class="timeline-count">{timeline.length} steps</span>
  </div>

  {#if timeline.length === 0}
    <p class="empty">No structured timeline entries recorded.</p>
  {:else}
    <ol class="timeline-nodes" aria-labelledby="workflow-execution-timeline-title">
      {#each timeline as entry (entry.step)}
        <li class="timeline-node">
          <button
            type="button"
            class="timeline-node-button"
            data-selected={entry.step === selectedStep}
            aria-pressed={entry.step === selectedStep}
            onclick={() => selectStep(entry.step)}
          >
            <span class="timeline-node-marker">Step {entry.step}</span>
            <span class="timeline-node-main">
              <span class="timeline-node-title">{entry.operationLabel}</span>
              <span class="timeline-node-meta">
                {entry.operationType} / {formatStepDuration(entry.duration)} / {formatTimestamp(entry.timestamp)}
              </span>
              <span class="timeline-node-summary">{entry.outputSummary ?? entry.inputSummary}</span>
            </span>
            <Badge variant={getStatusVariant(entry.status)} label={entry.status} size="xs" />
          </button>
        </li>
      {/each}
    </ol>

    <section class="checkpoint-panel">
      <div class="sr-only" aria-live="polite" aria-atomic="true">
        {#if selectedReplayLoading}
          Loading checkpoint state for step {selectedStep}.
        {:else if selectedReplayError}
          Failed to load checkpoint state.
        {:else if selectedReplay}
          Checkpoint state loaded for step {selectedReplay.checkpoint.step}.
        {:else}
          No checkpoint step selected.
        {/if}
      </div>

      <div class="section-heading">
        <h4>Checkpoint State</h4>
        {#if selectedStep !== null}
          <span>Step {selectedStep}</span>
        {/if}
      </div>

      {#if selectedReplayLoading}
        <p class="empty">Loading checkpoint state...</p>
      {:else if selectedReplayError}
        <Alert variant="danger" title="Failed to load checkpoint" description={selectedReplayError} />
      {:else if selectedReplay}
        <div class="checkpoint-grid">
          <div class="checkpoint-card">
            <h5>Locals</h5>
            <JsonViewer data={selectedReplay.checkpoint.locals} />
          </div>
          <div class="checkpoint-card">
            <h5>Search Attributes</h5>
            <JsonViewer data={selectedReplay.checkpoint.searchAttributes} />
          </div>
          <div class="checkpoint-card">
            <h5>Accumulated Results</h5>
            <JsonViewer data={selectedReplay.accumulatedResults} />
          </div>
          <div class="checkpoint-card">
            <h5>Events</h5>
            <JsonViewer data={selectedReplay.events} collapsed />
          </div>
        </div>
      {:else}
        <p class="empty">Select a timeline step to inspect its checkpoint.</p>
      {/if}
    </section>

    <section class="diff-panel">
      <div class="sr-only" aria-live="polite" aria-atomic="true">
        {#if diffLoading}
          Comparing checkpoint state.
        {:else if diffError}
          Failed to compare checkpoint state.
        {:else if diffRows.length > 0}
          Checkpoint diff loaded with {diffRows.length} changes.
        {:else}
          No checkpoint diff loaded.
        {/if}
      </div>

      <div class="section-heading">
        <h4>Step Diff</h4>
        <span>Compare retained checkpoints</span>
      </div>

      <div class="diff-controls">
        <Select id="workflow-timeline-diff-from" label="From step" bind:value={fromStep}>
          <option value="">Choose a step</option>
          {#each timeline as entry (entry.step)}
            <option value={String(entry.step)}>Step {entry.step}</option>
          {/each}
        </Select>

        <Select id="workflow-timeline-diff-to" label="To step" bind:value={toStep}>
          <option value="">Choose a step</option>
          {#each timeline as entry (entry.step)}
            <option value={String(entry.step)}>Step {entry.step}</option>
          {/each}
        </Select>

        <Button
          variant="secondary"
          size="md"
          label="Compare"
          disabled={!canCompare}
          loading={diffLoading}
          onclick={compareSteps}
        />
      </div>

      {#if diffError}
        <Alert variant="danger" title="Failed to compare steps" description={diffError} />
      {:else if diffLoading}
        <p class="empty">Comparing checkpoint state...</p>
      {:else if diffRows.length > 0}
        <table class="diff-table">
          <thead>
            <tr>
              <th scope="col">Section</th>
              <th scope="col">Path</th>
              <th scope="col">Change</th>
              <th scope="col">Before</th>
              <th scope="col">After</th>
            </tr>
          </thead>
          <tbody>
            {#each diffRows as row (`${row.section}:${row.label}:${row.change}`)}
              <tr>
                <td>{getSectionLabel(row.section)}</td>
                <td class="font-mono">{row.label}</td>
                <td><span class="change-pill" data-change={row.change}>{row.change}</span></td>
                <td class="font-mono">{formatTimelineDiffValue(row.before)}</td>
                <td class="font-mono">{formatTimelineDiffValue(row.after)}</td>
              </tr>
            {/each}
          </tbody>
        </table>
      {:else}
        <p class="empty">Choose two different steps to see what changed.</p>
      {/if}
    </section>
  {/if}
</div>

<style>
  .workflow-execution-timeline {
    display: flex;
    flex-direction: column;
    gap: var(--space-4, 1rem);
  }

  .timeline-header,
  .section-heading {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: var(--space-3, 0.75rem);
  }

  .timeline-header h3,
  .section-heading h4,
  .checkpoint-card h5 {
    margin: 0;
    color: var(--text, #111827);
  }

  .timeline-header h3 {
    font-size: var(--text-base, 1rem);
    font-weight: var(--font-semibold, 600);
  }

  .timeline-header p,
  .section-heading span,
  .empty {
    margin: 0;
    color: var(--text-muted, #6b7280);
    font-size: var(--text-sm, 0.875rem);
  }

  .timeline-count {
    display: inline-flex;
    align-items: center;
    padding: var(--space-0-5, 0.125rem) var(--space-2, 0.5rem);
    border-radius: 999px;
    background: var(--surface-inset, #f3f4f6);
    color: var(--text-muted, #6b7280);
    font-size: var(--text-xs, 0.75rem);
    white-space: nowrap;
  }

  .timeline-nodes {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(14rem, 1fr));
    gap: var(--space-3, 0.75rem);
    margin: 0;
    padding: 0;
    list-style: none;
  }

  .timeline-node-button {
    display: flex;
    align-items: flex-start;
    gap: var(--space-3, 0.75rem);
    width: 100%;
    min-height: 5.5rem;
    padding: var(--space-3, 0.75rem);
    text-align: left;
    border: 1px solid var(--border-muted, #e5e7eb);
    border-radius: var(--radius-lg, 0.75rem);
    background: var(--surface, #fff);
    cursor: pointer;
    transition:
      border-color var(--duration-fast, 150ms) var(--ease-standard, ease),
      box-shadow var(--duration-fast, 150ms) var(--ease-standard, ease),
      transform var(--duration-fast, 150ms) var(--ease-standard, ease);
  }

  .timeline-node-button:hover {
    border-color: var(--accent, #2563eb);
    transform: translateY(-1px);
  }

  .timeline-node-button:focus-visible {
    outline: 2px solid transparent;
    box-shadow:
      0 0 0 var(--ring-offset, 2px) var(--ring-offset-color, var(--surface, #fff)),
      0 0 0 calc(var(--ring-offset, 2px) + var(--ring-width, 2px))
        var(--control-ring-color, #6366f1);
  }

  .timeline-node-button[data-selected='true'] {
    border-color: var(--accent, #2563eb);
    box-shadow: 0 0 0 1px var(--accent, #2563eb);
  }

  .timeline-node-marker {
    flex-shrink: 0;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 3rem;
    height: 3rem;
    border-radius: 999px;
    background: var(--surface-accent, #eef2ff);
    color: var(--accent, #2563eb);
    font-size: var(--text-xs, 0.75rem);
    font-weight: var(--font-semibold, 600);
  }

  .timeline-node-main {
    display: flex;
    flex: 1;
    min-width: 0;
    flex-direction: column;
    gap: var(--space-1, 0.25rem);
  }

  .timeline-node-title {
    font-size: var(--text-sm, 0.875rem);
    font-weight: var(--font-semibold, 600);
    color: var(--text, #111827);
  }

  .timeline-node-meta,
  .timeline-node-summary {
    overflow: hidden;
    color: var(--text-muted, #6b7280);
    font-size: var(--text-xs, 0.75rem);
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .checkpoint-panel,
  .diff-panel {
    display: flex;
    flex-direction: column;
    gap: var(--space-3, 0.75rem);
    padding: var(--space-3, 0.75rem);
    border: 1px solid var(--border-muted, #e5e7eb);
    border-radius: var(--radius-lg, 0.75rem);
    background: color-mix(in oklch, var(--surface-inset, #f3f4f6), transparent 45%);
  }

  .checkpoint-grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(14rem, 1fr));
    gap: var(--space-3, 0.75rem);
  }

  .checkpoint-card {
    display: flex;
    min-width: 0;
    flex-direction: column;
    gap: var(--space-2, 0.5rem);
    padding: var(--space-3, 0.75rem);
    border-radius: var(--radius-md, 0.375rem);
    background: var(--surface-raised, #fff);
    border: 1px solid var(--border-muted, #e5e7eb);
  }

  .checkpoint-card h5 {
    font-size: var(--text-xs, 0.75rem);
    text-transform: uppercase;
    letter-spacing: 0.05em;
  }

  .diff-controls {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(12rem, 1fr));
    align-items: end;
    gap: var(--space-3, 0.75rem);
  }

  .diff-table {
    width: 100%;
    border-collapse: collapse;
    overflow-wrap: anywhere;
  }

  .diff-table th,
  .diff-table td {
    padding: var(--space-2, 0.5rem);
    border-bottom: 1px solid var(--divider, #e5e7eb);
    vertical-align: top;
    font-size: var(--text-xs, 0.75rem);
  }

  .diff-table th {
    color: var(--text-muted, #6b7280);
    font-weight: var(--font-medium, 500);
    text-align: left;
  }

  .change-pill {
    display: inline-flex;
    align-items: center;
    padding: var(--space-0-5, 0.125rem) var(--space-1-5, 0.375rem);
    border-radius: 999px;
    background: var(--surface-inset, #f3f4f6);
    color: var(--text-muted, #6b7280);
    font-size: var(--text-xs, 0.75rem);
    font-weight: var(--font-medium, 500);
  }

  .change-pill[data-change='added'],
  .change-pill[data-change='delta'] {
    background: color-mix(in oklch, var(--success, #16a34a), transparent 84%);
    color: var(--success, #16a34a);
  }

  .change-pill[data-change='removed'] {
    background: color-mix(in oklch, var(--warning, #d97706), transparent 84%);
    color: var(--warning, #d97706);
  }

  .change-pill[data-change='changed'] {
    background: color-mix(in oklch, var(--accent, #2563eb), transparent 84%);
    color: var(--accent, #2563eb);
  }
</style>
