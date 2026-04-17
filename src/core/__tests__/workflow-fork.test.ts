import { describe, expect, it } from 'bun:test';

import { TestEngine } from '../../testing/test-engine.ts';
import type { Context } from '../context.ts';
import { activity, type WorkflowContext } from '../types.ts';

async function waitForCheckpointStep(
  engine: TestEngine,
  workflowId: string,
  step: number,
): Promise<void> {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const checkpoints = await engine.listCheckpoints(workflowId);
    if (checkpoints.some((checkpoint) => checkpoint.step === step)) {
      return;
    }
    await Bun.sleep(10);
  }

  throw new Error(`Checkpoint step ${step} was not recorded for workflow "${workflowId}"`);
}

describe('workflow forking', () => {
  it('forks a running workflow and lets the two workflows diverge independently', async () => {
    const engine = new TestEngine();

    engine.register('choose-branch', async function* (ctx: WorkflowContext, input: unknown) {
      const durableContext = ctx as Context;
      const branch = yield* durableContext.waitForSignal('branch');
      const typedInput = input as { label: string };
      return `${typedInput.label}:${String(branch)}`;
    });

    const original = await engine.start('choose-branch', { label: 'base' }, { id: 'wf-original' });
    const forked = await engine.fork(original.id);

    await engine.signal(original.id, 'branch', 'left');
    await engine.signal(forked.id, 'branch', 'right');

    await expect(original.result()).resolves.toBe('base:left');
    await expect(forked.result()).resolves.toBe('base:right');

    const forkedState = await engine.get(forked.id);
    expect(forkedState).not.toBeNull();
    expect(forkedState).toMatchObject({
      forkedFrom: {
        workflowId: original.id,
      },
    });
    expect(typeof forkedState?.forkedFrom?.step).toBe('number');

    const descendants = await engine.list({
      attributes: [{ key: 'weft:forkedFrom', value: original.id }],
    });
    expect(descendants.items.map((item) => item.id)).toContain(forked.id);

    engine[Symbol.dispose]();
  });

  it('forks from a historical checkpoint without rerunning already completed work', async () => {
    const engine = new TestEngine();
    const executedStages: string[] = [];

    const recordStage = activity({
      name: 'recordStage',
      execute: async (stage: unknown) => {
        const typedStage = String(stage);
        executedStages.push(typedStage);
        return typedStage;
      },
    });

    engine.register('historical-fork', async function* (ctx: WorkflowContext) {
      const durableContext = ctx as Context;
      const first = yield* durableContext.run(recordStage, 'first');
      const second = yield* durableContext.run(recordStage, 'second');
      yield* durableContext.waitForSignal('hold');
      yield* durableContext.waitForSignal('continue');
      return `${String(first)}:${String(second)}`;
    });

    const original = await engine.start('historical-fork', null, { id: 'wf-historical' });
    await engine.signal(original.id, 'hold');
    await waitForCheckpointStep(engine, original.id, 4);

    const forked = await engine.fork(original.id, { fromStep: 3 });
    await engine.signal(forked.id, 'hold');
    await engine.signal(forked.id, 'continue');

    await expect(forked.result()).resolves.toBe('first:second');
    expect(executedStages).toEqual(['first', 'second']);

    const forkedState = await engine.get(forked.id);
    expect(forkedState).not.toBeNull();
    expect(forkedState).toMatchObject({
      forkedFrom: {
        workflowId: original.id,
        step: 3,
      },
    });

    await engine.signal(original.id, 'continue');
    await expect(original.result()).resolves.toBe('first:second');

    engine[Symbol.dispose]();
  });

  it('forks a completed workflow from its latest checkpoint and reruns only the terminal step', async () => {
    const engine = new TestEngine();
    const executedStages: string[] = [];
    const terminalSummaries: string[] = [];

    const recordStage = activity({
      name: 'recordTerminalStage',
      execute: async (stage: unknown) => {
        const typedStage = String(stage);
        executedStages.push(typedStage);
        return `${typedStage}-done`;
      },
    });

    engine.register('completed-fork', async function* (ctx: WorkflowContext, input: unknown) {
      const durableContext = ctx as Context;
      const stage = yield* durableContext.run(recordStage, 'prepare');
      const typedInput = String(input);
      return yield* durableContext.memo('terminal-summary', () => {
        terminalSummaries.push(typedInput);
        return `${typedInput}:${String(stage)}`;
      });
    });

    const original = await engine.start('completed-fork', 'original', { id: 'wf-completed' });
    await expect(original.result()).resolves.toBe('original:prepare-done');
    expect(executedStages).toEqual(['prepare']);
    expect(terminalSummaries).toEqual(['original']);

    const forked = await engine.fork(original.id);
    await expect(forked.result()).resolves.toBe('original:prepare-done');
    expect(executedStages).toEqual(['prepare']);
    expect(terminalSummaries).toEqual(['original', 'original']);

    engine[Symbol.dispose]();
  });

  it('records lineage chains across multiple forks', async () => {
    const engine = new TestEngine();

    engine.register('lineage-fork', async function* (_ctx: WorkflowContext, input: unknown) {
      return String(input);
    });

    const original = await engine.start('lineage-fork', 'root', { id: 'wf-root' });
    await original.result();

    const firstFork = await engine.fork(original.id);
    await firstFork.result();

    const secondFork = await engine.fork(firstFork.id);
    await secondFork.result();

    const firstForkState = await engine.get(firstFork.id);
    const secondForkState = await engine.get(secondFork.id);

    expect(firstForkState).toMatchObject({
      forkedFrom: {
        workflowId: original.id,
      },
    });
    expect(secondForkState).toMatchObject({
      forkedFrom: {
        workflowId: firstFork.id,
      },
    });

    const firstGeneration = await engine.list({
      attributes: [{ key: 'weft:forkedFrom', value: original.id }],
    });
    expect(firstGeneration.items.map((item) => item.id)).toContain(firstFork.id);

    const secondGeneration = await engine.list({
      attributes: [{ key: 'weft:forkedFrom', value: firstFork.id }],
    });
    expect(secondGeneration.items.map((item) => item.id)).toContain(secondFork.id);

    engine[Symbol.dispose]();
  });
});
