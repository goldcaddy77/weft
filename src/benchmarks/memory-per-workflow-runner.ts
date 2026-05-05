import type { Context } from '../core/context.ts';
import { Engine, ENGINE_PARKED_WORKFLOW_COUNT_FOR_TESTING } from '../core/engine.ts';
import type { WorkflowContext } from '../core/types.ts';
import { BunSQLiteStorage } from '../storage/bun-sql.ts';
import { isConstrainedCodexRunner } from './benchmark-environment.ts';

const WORKFLOW_ID_PREFIX = 'memory-benchmark-';
const WORKFLOW_ID_PATTERN = /memory-benchmark-\d+/;

type WorkflowFootprint = {
  checkpointBytes: number;
  durableBytes: number;
};

export type MemoryPerWorkflowMeasurement = {
  totalWorkflows: number;
  countedWorkflows: number;
  checkpointBytesTotal: number;
  averageCheckpointBytesPerWorkflow: number;
  maxCheckpointBytesPerWorkflow: number;
  durableBytesTotal: number;
  averageDurableBytesPerWorkflow: number;
  maxDurableBytesPerWorkflow: number;
  workflowStateBytesTotal: number;
  checkpointHistoryBytesTotal: number;
  timelineBytesTotal: number;
  eventBytesTotal: number;
  otherBytesTotal: number;
};

function roundBytesPerWorkflow(totalBytes: number, workflowCount: number): number {
  if (workflowCount === 0) {
    return 0;
  }

  return Math.round(totalBytes / workflowCount);
}

function extractBenchmarkWorkflowId(storageKey: string): string | null {
  return storageKey.match(WORKFLOW_ID_PATTERN)?.[0] ?? null;
}

function classifyStorageKey(
  storageKey: string,
): keyof Pick<
  MemoryPerWorkflowMeasurement,
  | 'workflowStateBytesTotal'
  | 'checkpointHistoryBytesTotal'
  | 'timelineBytesTotal'
  | 'eventBytesTotal'
  | 'otherBytesTotal'
> {
  if (storageKey.startsWith('ev:')) {
    return 'eventBytesTotal';
  }

  if (!storageKey.startsWith('wf:')) {
    return 'otherBytesTotal';
  }

  if (storageKey.includes(':timeline:')) {
    return 'timelineBytesTotal';
  }

  if (storageKey.includes(':ckpt:')) {
    return 'checkpointHistoryBytesTotal';
  }

  return 'workflowStateBytesTotal';
}

// oxlint-disable-next-line complexity -- ID:benchmarks-memory-per-workflow-runner-measure-memory-per-workflow-complexity
export async function measureMemoryPerWorkflow(
  totalWorkflows: number,
): Promise<MemoryPerWorkflowMeasurement> {
  const storage = new BunSQLiteStorage(':memory:');
  const engine = new Engine({ storage });

  try {
    engine.register('idle', async function* (ctx: WorkflowContext) {
      yield* (ctx as Context).waitForSignal('wake');
      return 'done';
    });

    for (let index = 0; index < totalWorkflows; index += 1) {
      await engine.start('idle', null, { id: `${WORKFLOW_ID_PREFIX}${index}` });
    }

    await waitForParkedWorkflows(engine, totalWorkflows);

    const footprints = new Map<string, WorkflowFootprint>();
    let checkpointBytesTotal = 0;
    let durableBytesTotal = 0;
    let workflowStateBytesTotal = 0;
    let checkpointHistoryBytesTotal = 0;
    let timelineBytesTotal = 0;
    let eventBytesTotal = 0;
    let otherBytesTotal = 0;

    for await (const [storageKey, value] of storage.scan('')) {
      const workflowId = extractBenchmarkWorkflowId(storageKey);
      if (workflowId === null) {
        continue;
      }

      const bytes = value.byteLength;
      durableBytesTotal += bytes;

      const footprint = footprints.get(workflowId) ?? { checkpointBytes: 0, durableBytes: 0 };
      footprint.durableBytes += bytes;
      footprints.set(workflowId, footprint);

      if (storageKey.startsWith(`wf:${workflowId}:ckpt`) && !storageKey.includes(':ckpt:')) {
        checkpointBytesTotal += bytes;
        footprint.checkpointBytes += bytes;
      }

      const category = classifyStorageKey(storageKey);
      if (category === 'workflowStateBytesTotal') {
        if (storageKey.startsWith(`wf:${workflowId}:ckpt`) && !storageKey.includes(':ckpt:')) {
          continue;
        }
        workflowStateBytesTotal += bytes;
        continue;
      }

      if (category === 'checkpointHistoryBytesTotal') {
        checkpointHistoryBytesTotal += bytes;
        continue;
      }

      if (category === 'timelineBytesTotal') {
        timelineBytesTotal += bytes;
        continue;
      }

      if (category === 'eventBytesTotal') {
        eventBytesTotal += bytes;
        continue;
      }

      otherBytesTotal += bytes;
    }

    let maxCheckpointBytesPerWorkflow = 0;
    let maxDurableBytesPerWorkflow = 0;
    for (const footprint of footprints.values()) {
      maxCheckpointBytesPerWorkflow = Math.max(
        maxCheckpointBytesPerWorkflow,
        footprint.checkpointBytes,
      );
      maxDurableBytesPerWorkflow = Math.max(maxDurableBytesPerWorkflow, footprint.durableBytes);
    }

    const countedWorkflows = footprints.size;

    return {
      totalWorkflows,
      countedWorkflows,
      checkpointBytesTotal,
      averageCheckpointBytesPerWorkflow: roundBytesPerWorkflow(
        checkpointBytesTotal,
        countedWorkflows,
      ),
      maxCheckpointBytesPerWorkflow,
      durableBytesTotal,
      averageDurableBytesPerWorkflow: roundBytesPerWorkflow(durableBytesTotal, countedWorkflows),
      maxDurableBytesPerWorkflow,
      workflowStateBytesTotal,
      checkpointHistoryBytesTotal,
      timelineBytesTotal,
      eventBytesTotal,
      otherBytesTotal,
    };
  } finally {
    engine[Symbol.dispose]();
    storage[Symbol.dispose]();
  }
}

if (import.meta.main) {
  const totalWorkflowsArgument = Bun.argv[2];
  const totalWorkflows =
    totalWorkflowsArgument !== undefined ? Number(totalWorkflowsArgument) : 100_000;

  if (!Number.isInteger(totalWorkflows) || totalWorkflows <= 0) {
    console.error('Expected a positive integer total workflow count.');
    process.exit(1);
  }

  const measurement = await measureMemoryPerWorkflow(totalWorkflows);
  console.log(JSON.stringify(measurement));
}

async function waitForParkedWorkflows(engine: Engine, expectedCount: number): Promise<void> {
  const timeoutMilliseconds = isConstrainedCodexRunner() ? 180_000 : 60_000;
  const deadline = Date.now() + timeoutMilliseconds;

  while (Date.now() < deadline) {
    if (engine[ENGINE_PARKED_WORKFLOW_COUNT_FOR_TESTING]() === expectedCount) {
      return;
    }

    await Bun.sleep(5);
  }

  throw new Error(
    `Timed out waiting for ${expectedCount.toLocaleString()} parked workflows in the memory benchmark runner.`,
  );
}
