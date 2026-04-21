import { afterEach, describe, expect, it } from 'bun:test';

import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import type { Component } from 'svelte';
import { compile } from 'svelte/compiler';
import { render } from 'svelte/server';

import type { ScheduleSummary } from '../api-client.ts';
import { formatTimestamp } from '../utilities/format-date.ts';

const COMPONENT_PATH = new URL('./schedule-list.svelte', import.meta.url).pathname;
const generatedFiles: string[] = [];

afterEach(() => {
  for (const generatedFile of generatedFiles.splice(0)) {
    rmSync(generatedFile, { force: true });
  }
});

async function loadScheduleListComponent(): Promise<Component<{ schedules: ScheduleSummary[] }>> {
  const source = await Bun.file(COMPONENT_PATH).text();
  const compiled = compile(source, {
    filename: COMPONENT_PATH,
    generate: 'server',
  });
  const outputPath = join(import.meta.dir, `.schedule-list.${crypto.randomUUID()}.compiled.mjs`);
  generatedFiles.push(outputPath);
  await Bun.write(outputPath, compiled.js.code);

  const module = (await import(pathToFileURL(outputPath).href)) as {
    default: Component<{ schedules: ScheduleSummary[] }>;
  };
  return module.default;
}

describe('schedule-list fragment', () => {
  it('renders schedule state, cron, fire times, and queued or current run details', async () => {
    const component = await loadScheduleListComponent();
    const schedules: ScheduleSummary[] = [
      {
        id: 'nightly-maintenance',
        workflowType: 'echo',
        cronExpression: '0 * * * *',
        status: 'active',
        overlap: 'queue',
        backfill: true,
        createdAt: Date.UTC(2026, 0, 1, 0, 0, 0),
        updatedAt: Date.UTC(2026, 0, 1, 0, 5, 0),
        lastFireAt: Date.UTC(2026, 0, 1, 0, 0, 0),
        nextFireAt: Date.UTC(2026, 0, 1, 1, 0, 0),
        currentWorkflowId: 'workflow-123',
        queuedRuns: 2,
      },
    ];

    const { body } = render(component, { props: { schedules } });

    expect(body).toContain('nightly-maintenance');
    expect(body).toContain('echo');
    expect(body).toContain('active');
    expect(body).toContain('Cron 0 * * * *');
    expect(body).toContain(`Last fired ${formatTimestamp(schedules[0]!.lastFireAt)}`);
    expect(body).toContain(`Next fire ${formatTimestamp(schedules[0]!.nextFireAt)}`);
    expect(body).toContain('Current run workflow-123');
    expect(body).toContain('Queued runs 2');
  });
});
