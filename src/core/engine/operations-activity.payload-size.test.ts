import { describe, expect, it } from 'bun:test';

import { MemoryStorage } from '../../storage/memory.ts';
import { Engine } from '../engine.ts';
import { activity, workflow, type WorkflowContext } from '../types.ts';

const bigResult = 'x'.repeat(1024);

const oversizeActivity = activity({
  name: 'oversize',
  execute: async () => bigResult,
});

const runOversize = workflow({ name: 'run-oversize' }).execute(async function* (
  ctx: WorkflowContext,
) {
  return yield* ctx.run(oversizeActivity);
});

describe('payload-size cap — activity result', () => {
  it('fails the operation with PayloadSizeExceededError and appends no completed event with the oversize result', async () => {
    const storage = new MemoryStorage();
    const engine = new Engine({ storage, payloadSize: { maxBytes: 64 } });
    engine.register(oversizeActivity);
    engine.register(runOversize);

    const handle = await engine.start('run-oversize', null, { id: 'wf-activity' });

    let thrown: unknown;
    try {
      await handle.result();
    } catch (error) {
      thrown = error;
    }

    // The workflow surfaces the activity failure as its terminal error.
    expect(thrown).toBeDefined();

    // No event in the durable log carries the oversize result value.
    const events = await engine.getEvents('wf-activity');
    const carriesOversize = events.some((event) => JSON.stringify(event).includes(bigResult));
    expect(carriesOversize).toBe(false);

    engine[Symbol.dispose]();
  });

  it('admits an activity result at or below the limit', async () => {
    const storage = new MemoryStorage();
    const engine = new Engine({ storage, payloadSize: { maxBytes: 1024 } });
    const smallActivity = activity({ name: 'small', execute: async () => 'ok' });
    const runSmall = workflow({ name: 'run-small' }).execute(async function* (
      ctx: WorkflowContext,
    ) {
      return yield* ctx.run(smallActivity);
    });
    engine.register(smallActivity);
    engine.register(runSmall);

    const handle = await engine.start('run-small', null, { id: 'wf-activity-ok' });
    expect(await handle.result()).toBe('ok');

    engine[Symbol.dispose]();
  });

  it('surfaces PayloadSizeExceededError as the activity failure cause', async () => {
    const storage = new MemoryStorage();
    const engine = new Engine({ storage, payloadSize: { maxBytes: 64 } });
    engine.register(oversizeActivity);
    engine.register(runOversize);

    const handle = await engine.start('run-oversize', null, { id: 'wf-activity-cause' });
    const error = await handle.result().then(
      () => null,
      (caught: unknown) => caught,
    );

    // The failure chain mentions the payload-size rejection.
    const serialized = JSON.stringify(error, Object.getOwnPropertyNames(error ?? {}));
    expect(serialized).toContain('PayloadSizeExceededError');

    engine[Symbol.dispose]();
  });
});
