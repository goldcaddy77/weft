import type { Context } from '../core/context.ts';
import { Engine } from '../core/engine.ts';
import type { WorkflowContext } from '../core/types.ts';
import { BunSQLiteStorage } from '../storage/bun-sql.ts';

export type MemoryPerWorkflowMeasurement = {
  totalWorkflows: number;
  heapBefore: number;
  heapAfter: number;
  heapGrowth: number;
  bytesPerWorkflow: number;
};

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

    if (typeof Bun.gc === 'function') {
      Bun.gc(true);
    }
    await Bun.sleep(10);

    for (let index = 0; index < 200; index += 1) {
      await engine.start('idle', index);
    }

    await Bun.sleep(5);
    if (typeof Bun.gc === 'function') {
      Bun.gc(true);
    }
    await Bun.sleep(5);

    const heapBefore = process.memoryUsage().heapUsed;

    for (let index = 200; index < 200 + totalWorkflows; index += 1) {
      await engine.start('idle', index);
    }

    await Bun.sleep(10);
    if (typeof Bun.gc === 'function') {
      Bun.gc(true);
    }
    await Bun.sleep(5);

    const heapAfter = process.memoryUsage().heapUsed;
    const heapGrowth = heapAfter - heapBefore;
    const bytesPerWorkflow = Math.round(heapGrowth / totalWorkflows);

    return {
      totalWorkflows,
      heapBefore,
      heapAfter,
      heapGrowth,
      bytesPerWorkflow,
    };
  } finally {
    engine[Symbol.dispose]();
    storage[Symbol.dispose]();
  }
}

if (import.meta.main) {
  const totalWorkflowsArgument = Bun.argv[2];
  const totalWorkflows =
    totalWorkflowsArgument !== undefined ? Number.parseInt(totalWorkflowsArgument, 10) : 10_000;

  if (!Number.isFinite(totalWorkflows) || totalWorkflows <= 0) {
    console.error('Expected a positive integer total workflow count.');
    process.exit(1);
  }

  const measurement = await measureMemoryPerWorkflow(totalWorkflows);
  console.log(JSON.stringify(measurement));
}
