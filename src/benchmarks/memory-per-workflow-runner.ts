import type { Context } from '../core/context.ts';
import { Engine, ENGINE_PARKED_WORKFLOW_COUNT_FOR_TESTING } from '../core/engine.ts';
import type { WorkflowContext } from '../core/types.ts';
import { BunSQLiteStorage } from '../storage/bun-sql.ts';

export type MemoryPerWorkflowMeasurement = {
  totalWorkflows: number;
  warmupWorkflows: number;
  heapBefore: number;
  heapAfter: number;
  heapGrowth: number;
  heapBytesPerWorkflow: number;
  rssBefore: number;
  rssAfter: number;
  rssGrowth: number;
  rssBytesPerWorkflow: number;
};

export async function measureMemoryPerWorkflow(
  totalWorkflows: number,
): Promise<MemoryPerWorkflowMeasurement> {
  const storage = new BunSQLiteStorage(':memory:');
  const engine = new Engine({ storage });
  const warmupWorkflowCount = 5_000;

  try {
    engine.register('idle', async function* (ctx: WorkflowContext) {
      yield* (ctx as Context).waitForSignal('wake');
      return 'done';
    });

    if (typeof Bun.gc === 'function') {
      Bun.gc(true);
    }
    await Bun.sleep(10);

    for (let index = 0; index < warmupWorkflowCount; index += 1) {
      await engine.start('idle', index);
    }

    await waitForParkedWorkflows(engine, warmupWorkflowCount);
    await collectGarbage();

    const memoryBefore = process.memoryUsage();

    for (
      let index = warmupWorkflowCount;
      index < warmupWorkflowCount + totalWorkflows;
      index += 1
    ) {
      await engine.start('idle', index);
    }

    await waitForParkedWorkflows(engine, warmupWorkflowCount + totalWorkflows);
    await collectGarbage();

    const memoryAfter = process.memoryUsage();
    const heapBefore = memoryBefore.heapUsed;
    const heapAfter = memoryAfter.heapUsed;
    const heapGrowth = heapAfter - heapBefore;
    const heapBytesPerWorkflow = Math.round(heapGrowth / totalWorkflows);
    const rssBefore = memoryBefore.rss;
    const rssAfter = memoryAfter.rss;
    const rssGrowth = rssAfter - rssBefore;
    const rssBytesPerWorkflow = Math.round(rssGrowth / totalWorkflows);

    return {
      totalWorkflows,
      warmupWorkflows: warmupWorkflowCount,
      heapBefore,
      heapAfter,
      heapGrowth,
      heapBytesPerWorkflow,
      rssBefore,
      rssAfter,
      rssGrowth,
      rssBytesPerWorkflow,
    };
  } finally {
    engine[Symbol.dispose]();
    storage[Symbol.dispose]();
  }
}

if (import.meta.main) {
  const totalWorkflowsArgument = Bun.argv[2];
  const totalWorkflows =
    totalWorkflowsArgument !== undefined ? Number(totalWorkflowsArgument) : 10_000;

  if (!Number.isInteger(totalWorkflows) || totalWorkflows <= 0) {
    console.error('Expected a positive integer total workflow count.');
    process.exit(1);
  }

  const measurement = await measureMemoryPerWorkflow(totalWorkflows);
  console.log(JSON.stringify(measurement));
}

async function collectGarbage(): Promise<void> {
  await Bun.sleep(5);
  if (typeof Bun.gc === 'function') {
    Bun.gc(true);
  }
  await Bun.sleep(5);
}

async function waitForParkedWorkflows(engine: Engine, expectedCount: number): Promise<void> {
  const timeoutMilliseconds = 15_000;
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
