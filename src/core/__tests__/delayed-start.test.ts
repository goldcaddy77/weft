import { describe, expect, it } from 'bun:test';

import { KEYS } from '../../storage/interface.ts';
import { MemoryStorage } from '../../storage/memory.ts';
import { TestEngine } from '../../testing/test-engine.ts';
import { decode } from '../codec.ts';
import { Engine } from '../engine.ts';
import type { TimerEntry, WorkflowContext, WorkflowState } from '../types.ts';

async function flush(): Promise<void> {
  await Bun.sleep(10);
}

async function collectDelayedEntries(
  storage: MemoryStorage,
): Promise<Array<{ key: string; entry: TimerEntry }>> {
  const entries: Array<{ key: string; entry: TimerEntry }> = [];

  for await (const [key, value] of storage.scan('wf-delayed:')) {
    entries.push({
      key,
      entry: decode(value) as TimerEntry,
    });
  }

  return entries;
}

describe('delayed workflow start', () => {
  it('keeps a workflow pending until startAt and then runs it', async () => {
    const engine = new TestEngine({ startTime: 1_000 });
    let executions = 0;

    engine.register('delayed', async function* (_ctx: WorkflowContext, input: unknown) {
      executions += 1;
      return input;
    });

    const handle = await engine.start('delayed', 'hello', {
      id: 'wf-delayed-start-at',
      startAt: engine.now + 5_000,
    });

    expect(await engine.get(handle.id)).toMatchObject({
      id: handle.id,
      status: 'pending',
      type: 'delayed',
    });
    expect(executions).toBe(0);

    await engine.advanceTime('4s');

    expect(await engine.get(handle.id)).toMatchObject({ status: 'pending' });
    expect(executions).toBe(0);

    await engine.advanceTime('1s');

    expect(await handle.result()).toBe('hello');
    expect(executions).toBe(1);
    expect(await engine.get(handle.id)).toMatchObject({
      status: 'completed',
      result: 'hello',
    });

    engine[Symbol.dispose]();
  });

  it('persists startAfter as a wf-delayed timer entry', async () => {
    const engine = new TestEngine({ startTime: 10_000 });

    engine.register('delayed', async function* () {
      return 'done';
    });

    await engine.start('delayed', null, {
      id: 'wf-start-after',
      startAfter: '5s',
    });

    const entries = await collectDelayedEntries(engine.storage);

    expect(entries).toEqual([
      {
        key: KEYS.delayedStart(15_000, 'wf-start-after'),
        entry: {
          id: 'delayed-start:wf-start-after',
          workflowId: 'wf-start-after',
          fireAt: 15_000,
          kind: 'delayed-start',
        },
      },
    ]);

    engine[Symbol.dispose]();
  });

  it('rejects start() when both startAt and startAfter are provided', async () => {
    const engine = new TestEngine({ startTime: 1_000 });

    engine.register('delayed', async function* () {
      return 'done';
    });

    await expect(
      engine.start('delayed', null, {
        startAt: 2_000,
        startAfter: '1s',
      }),
    ).rejects.toThrow('Provide only one of startAt or startAfter');

    engine[Symbol.dispose]();
  });

  it('rejects startAt values that are negative or non-finite', async () => {
    const engine = new TestEngine({ startTime: 1_000 });

    engine.register('delayed', async function* () {
      return 'done';
    });

    await expect(
      engine.start('delayed', null, {
        startAt: -1,
      }),
    ).rejects.toThrow('options.startAt must be a finite, non-negative timestamp');

    await expect(
      engine.start('delayed', null, {
        startAt: Number.POSITIVE_INFINITY,
      }),
    ).rejects.toThrow('options.startAt must be a finite, non-negative timestamp');

    engine[Symbol.dispose]();
  });

  it('rejects startAfter values that are not finite, non-negative durations', async () => {
    const engine = new TestEngine({ startTime: 1_000 });

    engine.register('delayed', async function* () {
      return 'done';
    });

    await expect(
      engine.start('delayed', null, {
        startAfter: -1,
      }),
    ).rejects.toThrow(
      'options.startAfter must be a finite, non-negative number or a valid duration string',
    );

    engine[Symbol.dispose]();
  });

  it('rejects delayed executionTimeout values that are not finite, non-negative durations', async () => {
    const engine = new TestEngine({ startTime: 1_000 });

    engine.register('delayed', async function* () {
      return 'done';
    });

    await expect(
      engine.start('delayed', null, {
        startAfter: '5s',
        executionTimeout: -1,
      }),
    ).rejects.toThrow(
      'options.executionTimeout must be a finite, non-negative number or a valid duration string',
    );

    engine[Symbol.dispose]();
  });

  it('survives restart and fires from persisted wf-delayed storage', async () => {
    let now = 1_000;
    const storage = new MemoryStorage();
    let executions = 0;

    const registerDelayedWorkflow = (engine: Engine) => {
      engine.register('delayed', async function* (_ctx: WorkflowContext, input: unknown) {
        executions += 1;
        return `done:${input as string}`;
      });
    };

    const firstEngine = new Engine({
      storage,
      getNow: () => now,
    });
    registerDelayedWorkflow(firstEngine);

    await firstEngine.start('delayed', 'work', {
      id: 'wf-restart',
      startAt: now + 5_000,
    });

    expect(await firstEngine.get('wf-restart')).toMatchObject({ status: 'pending' });

    firstEngine[Symbol.dispose]();

    const secondEngine = new Engine({
      storage,
      getNow: () => now,
    });
    registerDelayedWorkflow(secondEngine);

    now += 5_000;
    await secondEngine.scheduler.tick(now);
    await flush();

    expect(await secondEngine.get('wf-restart')).toMatchObject({
      status: 'completed',
      result: 'done:work',
    });
    expect(executions).toBe(1);

    secondEngine[Symbol.dispose]();
  });

  it('cancels a pending delayed workflow before it starts', async () => {
    const engine = new TestEngine({ startTime: 1_000 });
    let executions = 0;

    engine.register('delayed', async function* () {
      executions += 1;
      return 'done';
    });

    const handle = await engine.start('delayed', null, {
      id: 'wf-cancel-before-start',
      startAfter: '5s',
    });

    await engine.cancel(handle.id);

    await expect(handle.result()).rejects.toThrow('Workflow cancelled');
    expect(await engine.get(handle.id)).toMatchObject({ status: 'cancelled' });
    expect(await collectDelayedEntries(engine.storage)).toEqual([]);

    await engine.advanceTime('5s');
    expect(executions).toBe(0);

    engine[Symbol.dispose]();
  });

  it('starts execution timeouts when the delayed workflow begins running', async () => {
    const engine = new TestEngine({ startTime: 1_000 });

    engine.register('timeout-delayed', async function* (ctx: WorkflowContext) {
      while (!ctx.signal.aborted) {
        await Bun.sleep(0);
      }
      return 'never';
    });

    const handle = await engine.start('timeout-delayed', null, {
      id: 'wf-delayed-timeout',
      startAfter: '5s',
      executionTimeout: '3s',
    });

    await engine.advanceTime('5s');
    expect(await engine.get(handle.id)).toMatchObject({ status: 'running' });

    await engine.advanceTime('2s');
    expect(await engine.get(handle.id)).toMatchObject({ status: 'running' });

    const resultPromise = handle.result();
    void resultPromise.catch(() => {});
    await engine.advanceTime('1s');
    await expect(resultPromise).rejects.toThrow('execution timeout');
    expect(await engine.get(handle.id)).toMatchObject({ status: 'timed-out' });

    engine[Symbol.dispose]();
  });

  it('persists the pending workflow state before the delayed start fires', async () => {
    const engine = new TestEngine({ startTime: 1_000 });

    engine.register('delayed', async function* () {
      return 'done';
    });

    const handle = await engine.start('delayed', null, {
      id: 'wf-persisted-pending',
      startAfter: '5s',
    });

    const stateBytes = await engine.storage.get(KEYS.workflow(handle.id));
    expect(stateBytes).not.toBeNull();

    const state = decode(stateBytes!) as WorkflowState;
    expect(state.status).toBe('pending');

    engine[Symbol.dispose]();
  });
});
