import { afterEach, describe, expect, it } from 'bun:test';

import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import type { BunPlugin } from 'bun';
import type { Component } from 'svelte';
import { render } from 'svelte/server';

import type { WorkflowReplay, WorkflowTimelineEntry } from '../../core/types.ts';
import type { WorkflowTimelineDiffRow } from './workflow-execution-timeline';

const COMPONENT_PATH = new URL('./workflow-execution-timeline.svelte', import.meta.url).pathname;
const generatedFiles: string[] = [];
const generatedDirectories: string[] = [];

afterEach(() => {
  for (const generatedFile of generatedFiles.splice(0)) {
    rmSync(generatedFile, { force: true });
  }
  for (const generatedDirectory of generatedDirectories.splice(0)) {
    rmSync(generatedDirectory, { force: true, recursive: true });
  }
});

async function loadWorkflowExecutionTimelineComponent(): Promise<
  Component<{
    timeline: WorkflowTimelineEntry[];
    selectedStep: number;
    selectedReplay: WorkflowReplay;
    diffRows: WorkflowTimelineDiffRow[];
    fromStep: string;
    toStep: string;
  }>
> {
  const sveltePluginSpecifier = 'bun-plugin-svelte';
  const sveltePluginModule = (await import(sveltePluginSpecifier)) as {
    SveltePlugin: (options: { forceSide: 'server'; development: boolean }) => BunPlugin;
  };
  const outputDirectory = join(
    import.meta.dir,
    `.workflow-execution-timeline.${crypto.randomUUID()}.compiled`,
  );
  generatedDirectories.push(outputDirectory);

  const result = await Bun.build({
    entrypoints: [COMPONENT_PATH],
    target: 'bun',
    format: 'esm',
    outdir: outputDirectory,
    plugins: [sveltePluginModule.SveltePlugin({ forceSide: 'server', development: false })],
  });

  expect(result.success).toBe(true);
  const outputPath = result.outputs[0]?.path;
  expect(outputPath).toBeString();
  if (outputPath === undefined) {
    throw new Error('Svelte component build did not produce an output file');
  }

  const module = (await import(pathToFileURL(outputPath).href)) as {
    default: Component<{
      timeline: WorkflowTimelineEntry[];
      selectedStep: number;
      selectedReplay: WorkflowReplay;
      diffRows: WorkflowTimelineDiffRow[];
      fromStep: string;
      toStep: string;
    }>;
  };
  return module.default;
}

describe('WorkflowExecutionTimeline fragment', () => {
  it('renders timeline nodes, selected checkpoint state, and diff rows', async () => {
    const component = await loadWorkflowExecutionTimelineComponent();
    const timeline: WorkflowTimelineEntry[] = [
      {
        step: 1,
        operationType: 'activity',
        operationLabel: 'loadOrder',
        inputSummary: '{"orderId":"order-1"}',
        outputSummary: '{"total":42}',
        duration: 8,
        timestamp: 1_000,
        status: 'completed',
      },
      {
        step: 2,
        operationType: 'activity',
        operationLabel: 'chargeCard',
        inputSummary: '{"total":42}',
        outputSummary: '{"transactionId":"txn-1"}',
        duration: 12,
        timestamp: 2_000,
        status: 'completed',
      },
    ];
    const selectedReplay: WorkflowReplay = {
      checkpoint: {
        step: 2,
        locals: { plan: 'ship' },
        searchAttributes: { status: 'approved' },
        version: '1.0.0',
        createdAt: 2_000,
      },
      accumulatedResults: [[1, { total: 42 }]],
      events: [{ type: 'workflow:checkpoint', timestamp: 2_000, data: { step: 2 } }],
    };
    const diffRows: WorkflowTimelineDiffRow[] = [
      {
        section: 'budget',
        label: 'budget.weft:tokenCost',
        change: 'delta',
        before: 0.12,
        after: 0.28,
      },
      {
        section: 'conversation',
        label: 'conversation.messages',
        change: 'delta',
        before: 1,
        after: 2,
      },
    ];

    const { body } = render(component, {
      props: {
        timeline,
        selectedStep: 2,
        selectedReplay,
        diffRows,
        fromStep: '1',
        toStep: '2',
      },
    });

    expect(body).toContain('Step 1');
    expect(body).toContain('loadOrder');
    expect(body).toContain('chargeCard');
    expect(body).toContain('Checkpoint State');
    expect(body).toContain('"plan": "ship"');
    expect(body).toContain('budget.weft:tokenCost');
    expect(body).toContain('conversation.messages');
  });
});
