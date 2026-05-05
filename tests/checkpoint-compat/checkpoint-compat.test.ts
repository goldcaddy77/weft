/**
 * Verifies binary storage snapshots remain readable by the engine.
 *
 * Contract: These fixtures freeze observable behavior. Engine PRs must not
 * change them; if a fixture changes, that is a regression.
 */

import 'fake-indexeddb/auto';

import { afterEach, describe, expect, it } from 'bun:test';

import { Engine } from '../../src/core/engine.ts';
import type {
  ActivityDefinition,
  StepWorkflowContext,
  WorkflowContext,
  WorkflowEvent,
  WorkflowState,
  WorkflowTimelineEntry,
} from '../../src/core/types.ts';
import type { Storage } from '../../src/storage/interface.ts';
import { storageBackends, teardown } from '../../src/testing/storage-backends.ts';

type TraceFixture = {
  scenario: string;
  description: string;
  events: WorkflowEvent[];
  timeline: WorkflowTimelineEntry[];
  finalState: WorkflowState;
  storage: Record<string, string>;
};

type ScenarioHandlerRegistrar = (engine: Engine) => void;

const checkpointFixtureDirectory = 'tests/checkpoint-compat';
const replayFixtureDirectory = 'tests/replay-fixtures';
const expectedFixtureCount = 10;
const textDecoder = new TextDecoder();
const binaryFixtureGlob = new Bun.Glob('*.bin');
const fixtureFiles = [...binaryFixtureGlob.scanSync(checkpointFixtureDirectory)].toSorted();

function deserializeSnapshot(bytes: Uint8Array): Map<string, Uint8Array> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = 0;

  const readUint32 = (): number => {
    if (offset + 4 > bytes.byteLength) {
      throw new Error('Snapshot ended while reading a uint32 field');
    }

    const value = view.getUint32(offset, true);
    offset += 4;
    return value;
  };

  const readBytes = (length: number): Uint8Array => {
    if (offset + length > bytes.byteLength) {
      throw new Error('Snapshot ended while reading an entry field');
    }

    const value = bytes.slice(offset, offset + length);
    offset += length;
    return value;
  };

  const count = readUint32();
  const map = new Map<string, Uint8Array>();

  for (let index = 0; index < count; index += 1) {
    const keyLength = readUint32();
    const keyBytes = readBytes(keyLength);
    const key = textDecoder.decode(keyBytes);
    const valueLength = readUint32();
    const value = readBytes(valueLength);
    map.set(key, value);
  }

  if (offset !== bytes.byteLength) {
    throw new Error('Snapshot contains trailing bytes');
  }

  return map;
}

async function populateStorage(storage: Storage, snapshot: Map<string, Uint8Array>): Promise<void> {
  for (const [key, value] of snapshot) {
    await storage.put(key, value);
  }
}

async function loadJsonFixture(scenario: string): Promise<TraceFixture> {
  const value = await Bun.file(`${replayFixtureDirectory}/${scenario}.json`).json();
  return value as TraceFixture;
}

function registerSimpleSequential(engine: Engine): void {
  engine.register('simple-sequential', async function* (ctx: WorkflowContext, input: unknown) {
    const result = yield* ctx.run(async (value: unknown) => `processed:${String(value)}`, input);
    return result;
  });
}

function registerTwoParallel(engine: Engine): void {
  engine.register('two-parallel', async function* (ctx: WorkflowContext, input: unknown) {
    const context = ctx;
    const [left, right] = yield* context.all([
      context.run(async (value: unknown) => `left:${String(value)}`, input),
      context.run(async (value: unknown) => `right:${String(value)}`, input),
    ]);

    return { a: left, b: right };
  });
}

function registerRaceTakesFirst(engine: Engine): void {
  engine.register('race-takes-first', async function* (ctx: WorkflowContext) {
    const context = ctx;
    const result = yield* context.race([
      context.run(async () => 'fast'),
      context.run(async () => {
        await Bun.sleep(50);
        return 'slow';
      }),
    ]);

    return result;
  });
}

function registerSignalAndWait(engine: Engine): void {
  engine.register('signal-and-wait', async function* (ctx: WorkflowContext) {
    const payload = yield* ctx.waitForSignal('go');
    return { received: payload };
  });
}

function registerSleepAndResume(engine: Engine): void {
  engine.register('sleep-and-resume', async function* (ctx: WorkflowContext) {
    yield* ctx.sleep(100);
    return 'awake';
  });
}

function registerChildWorkflow(engine: Engine): void {
  engine.register(
    'child-workflow-child',
    async function childWorkflowChild(_ctx: StepWorkflowContext, input: unknown) {
      return `child-result:${String(input)}`;
    },
  );

  engine.register('child-workflow', async function* (ctx: WorkflowContext, input: unknown) {
    const childResult = yield* ctx.startChild('child-workflow-child', input);
    return { parent: String(input), child: childResult };
  });
}

function registerSagaWithCompensation(engine: Engine): void {
  const compensated: string[] = [];

  engine.register('saga-with-compensation', async function* (ctx: WorkflowContext) {
    const stepOne: ActivityDefinition<unknown, string> = {
      name: 'step-one',
      execute: async () => 'output-one',
      compensate: async (_input: unknown, output: string) => {
        compensated.push(output);
      },
    };
    const stepTwo: ActivityDefinition<unknown, string> = {
      name: 'step-two',
      execute: async () => {
        throw new Error('step-two-failed');
      },
    };

    try {
      yield* ctx.saga([
        { definition: stepOne, input: 'a' },
        { definition: stepTwo, input: 'b' },
      ]);
      return 'no-error';
    } catch {
      return `compensated:${compensated.join(',')}`;
    }
  });
}

function registerPipeThreeStages(engine: Engine): void {
  async function stageOne(_ctx: StepWorkflowContext, input: unknown): Promise<string> {
    return `s1:${String(input)}`;
  }

  async function stageTwo(_ctx: StepWorkflowContext, input: unknown): Promise<string> {
    return `s2:${String(input)}`;
  }

  async function stageThree(_ctx: StepWorkflowContext, input: unknown): Promise<string> {
    return `s3:${String(input)}`;
  }

  engine.register('pipe-three-stages', async function* (ctx: WorkflowContext, input: unknown) {
    return yield* ctx.pipe([stageOne, stageTwo, stageThree], input);
  });
  engine.register('stage1', stageOne);
  engine.register('stage2', stageTwo);
  engine.register('stage3', stageThree);
}

function registerForkFromCheckpoint(engine: Engine): void {
  engine.register('fork-from-checkpoint', async function* (ctx: WorkflowContext) {
    const context = ctx;
    const phaseOne = yield* context.run(async () => 'phase-one');
    const branch = yield* context.waitForSignal('branch');
    return `${String(phaseOne)}:${String(branch)}`;
  });
}

function registerRecoveryAfterCrash(engine: Engine): void {
  engine.register('recovery-after-crash', async function* (ctx: WorkflowContext) {
    const context = ctx;
    const stepOne = yield* context.run(async () => 'checkpoint-me');
    const stepTwo = yield* context.run(async () => `resumed:${String(stepOne)}`);
    return stepTwo;
  });
}

const scenarioRegistrars: Record<string, ScenarioHandlerRegistrar> = {
  'simple-sequential': registerSimpleSequential,
  'two-parallel': registerTwoParallel,
  'race-takes-first': registerRaceTakesFirst,
  'signal-and-wait': registerSignalAndWait,
  'sleep-and-resume': registerSleepAndResume,
  'child-workflow': registerChildWorkflow,
  'saga-with-compensation': registerSagaWithCompensation,
  'pipe-three-stages': registerPipeThreeStages,
  'fork-from-checkpoint': registerForkFromCheckpoint,
  'recovery-after-crash': registerRecoveryAfterCrash,
};

function registerScenarioHandlers(engine: Engine, scenario: string): void {
  const registrar = scenarioRegistrars[scenario];

  if (registrar === undefined) {
    throw new Error(`No checkpoint compatibility handler registered for "${scenario}"`);
  }

  registrar(engine);
}

for (const backend of storageBackends) {
  describe(`checkpoint compatibility fixtures [${backend.name}]`, () => {
    let engine: Engine | undefined;
    let cleanup: (() => void | Promise<void>) | undefined;

    afterEach(async () => {
      await teardown(engine, cleanup);
      engine = undefined;
      cleanup = undefined;
    });

    it('has the expected fixture count', () => {
      expect(fixtureFiles).toHaveLength(expectedFixtureCount);
    });

    for (const fixtureFile of fixtureFiles) {
      it(`reads ${fixtureFile}`, async () => {
        const scenario = fixtureFile.replace(/\.bin$/, '');
        const fixture = await loadJsonFixture(scenario);
        const bytes = await Bun.file(`${checkpointFixtureDirectory}/${fixtureFile}`).bytes();
        const snapshot = deserializeSnapshot(bytes);
        const result = backend.factory();
        cleanup = result.cleanup;
        await populateStorage(result.storage, snapshot);
        engine = new Engine({ storage: result.storage });
        registerScenarioHandlers(engine, scenario);

        const workflowId = fixture.finalState.id;
        await expect(engine.get(workflowId)).resolves.toEqual(fixture.finalState);
        await expect(engine.getTimeline(workflowId)).resolves.toEqual(fixture.timeline);
        await expect(engine.getEvents(workflowId)).resolves.toEqual(fixture.events);

        const recoveredHandles = await engine.recoverAll();
        expect(recoveredHandles).toHaveLength(0);

        if (scenario === 'fork-from-checkpoint') {
          const forkedWorkflows = await engine.list({ type: 'fork-from-checkpoint' });
          expect(forkedWorkflows.total).toBe(2);
          expect(forkedWorkflows.items.map((item) => item.status).toSorted()).toEqual([
            'completed',
            'completed',
          ]);
        }
      });
    }
  });
}
