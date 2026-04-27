import type { Context } from '../core/context.ts';
import { Engine } from '../core/engine.ts';
import type { WorkflowContext } from '../core/types.ts';
import { BunSQLiteStorage } from '../storage/bun-sql.ts';

export type ActivityCompletionMeasurement = {
  completionsPerSecond: number;
};

function echo(value: unknown): unknown {
  return value;
}

export async function measureActivityCompletions(
  totalWorkflows: number,
  activitiesPerWorkflow: number,
  startBatchSize: number,
): Promise<ActivityCompletionMeasurement> {
  const storage = new BunSQLiteStorage(':memory:');
  const engine = new Engine({ storage });

  try {
    engine.registerActivity('echo', echo);

    engine.register('with-activity', async function* (ctx: WorkflowContext) {
      let result: unknown = 0;
      for (let index = 0; index < activitiesPerWorkflow; index += 1) {
        result = yield* (ctx as Context).run(echo, index);
      }
      return result;
    });

    for (let index = 0; index < 25; index += 1) {
      const handle = await engine.start('with-activity', index);
      await handle.result();
    }

    const handles: Array<{ result: () => Promise<unknown> }> = [];
    const start = performance.now();

    for (let index = 0; index < totalWorkflows; index += startBatchSize) {
      const starters: Promise<{ result: () => Promise<unknown> }>[] = [];
      for (
        let offset = 0;
        offset < startBatchSize && index + offset < totalWorkflows;
        offset += 1
      ) {
        starters.push(engine.start('with-activity', index + offset));
      }
      handles.push(...(await Promise.all(starters)));
    }

    await Promise.all(handles.map((handle) => handle.result()));

    const elapsed = performance.now() - start;
    return {
      completionsPerSecond: Math.round(((totalWorkflows * activitiesPerWorkflow) / elapsed) * 1000),
    };
  } finally {
    engine[Symbol.dispose]();
    storage[Symbol.dispose]();
  }
}

if (import.meta.main) {
  const totalWorkflows = Number(Bun.argv[2] ?? '250');
  const activitiesPerWorkflow = Number(Bun.argv[3] ?? '40');
  const startBatchSize = Number(Bun.argv[4] ?? '250');

  if (
    !Number.isInteger(totalWorkflows) ||
    totalWorkflows <= 0 ||
    !Number.isInteger(activitiesPerWorkflow) ||
    activitiesPerWorkflow <= 0 ||
    !Number.isInteger(startBatchSize) ||
    startBatchSize <= 0
  ) {
    console.error('Expected positive integer values for workflows, activities, and batch size.');
    process.exit(1);
  }

  const measurement = await measureActivityCompletions(
    totalWorkflows,
    activitiesPerWorkflow,
    startBatchSize,
  );
  console.log(JSON.stringify(measurement));
}
