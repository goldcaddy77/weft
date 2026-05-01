/**
 * Verifies JSON trace fixtures both deserialize and can be regenerated through
 * the workflow write path.
 *
 * Contract: These fixtures freeze observable behavior. Engine PRs must not
 * change them; if a fixture changes, that is a regression.
 */

import { afterEach, describe, expect, it, test } from 'bun:test';

import type { Context } from '../../src/core/context.ts';
import { Engine } from '../../src/core/engine.ts';
import type {
  ActivityDefinition,
  StepWorkflowContext,
  WorkflowContext,
  WorkflowEvent,
  WorkflowState,
  WorkflowTimelineEntry,
} from '../../src/core/types.ts';
import { MemoryStorage } from '../../src/storage/memory.ts';
import { waitForCondition } from '../../src/testing/fake-timers.ts';
import { TestEngine } from '../../src/testing/test-engine.ts';

type TraceFixture = {
  scenario: string;
  description: string;
  events: WorkflowEvent[];
  timeline: WorkflowTimelineEntry[];
  finalState: WorkflowState;
  storage: Record<string, string>;
};

type ScenarioRun = {
  engine: TestEngine;
  workflowId: string;
};

type ScenarioRunner = (fixture: TraceFixture) => Promise<ScenarioRun>;
type ScenarioHandlerRegistrar = (engine: Engine) => void;
type RandomUuid = ReturnType<Crypto['randomUUID']>;

const replayFixtureDirectory = 'tests/replay-fixtures';
const expectedFixtureCount = 10;
const glob = new Bun.Glob('*.json');
const fixtureFiles = [...glob.scanSync(replayFixtureDirectory)]
  .filter((file) => file !== 'replay-fixtures.test.ts' && !file.endsWith('.test.ts'))
  .toSorted();
const replayableScenarioFiles = [
  'child-workflow.json',
  'pipe-three-stages.json',
  'recovery-after-crash.json',
  'saga-with-compensation.json',
  'signal-and-wait.json',
  'simple-sequential.json',
  'sleep-and-resume.json',
  'two-parallel.json',
] as const;

async function loadFixture(file: string): Promise<TraceFixture> {
  const value = await Bun.file(`${replayFixtureDirectory}/${file}`).json();
  return value as TraceFixture;
}

async function storageFromFixture(fixture: TraceFixture): Promise<MemoryStorage> {
  const storage = new MemoryStorage();

  for (const [key, encodedValue] of Object.entries(fixture.storage).toSorted(([left], [right]) =>
    left < right ? -1 : left > right ? 1 : 0,
  )) {
    await storage.put(key, Uint8Array.from(Buffer.from(encodedValue, 'base64')));
  }

  return storage;
}

function sortedStorageEntries(storage: MemoryStorage): Array<readonly [string, Uint8Array]> {
  return [...storage.snapshot().entries()].toSorted(([left], [right]) =>
    left < right ? -1 : left > right ? 1 : 0,
  );
}

function storageAsBase64Record(
  entries: readonly (readonly [string, Uint8Array])[],
): Record<string, string> {
  const storage: Record<string, string> = {};

  for (const [key, value] of entries) {
    storage[key] = Buffer.from(value).toString('base64');
  }

  return storage;
}

function formatDeterministicRandomUuid(counter: number): RandomUuid {
  const suffix = counter.toString(16).padStart(12, '0').slice(-12);

  // crypto.randomUUID() is typed as a UUID template literal, and this
  // constructed value follows that shape for deterministic fixture checks.
  return `00000000-0000-4000-8000-${suffix}` as RandomUuid;
}

async function withDeterministicRuntime<T>(operation: () => Promise<T>): Promise<T> {
  const originalRandomUuid = globalThis.crypto.randomUUID.bind(globalThis.crypto);
  const originalDateNow = Date.now.bind(Date);
  let counter = 0;

  Object.defineProperty(globalThis.crypto, 'randomUUID', {
    configurable: true,
    value: () => {
      counter += 1;
      return formatDeterministicRandomUuid(counter);
    },
  });
  Object.defineProperty(Date, 'now', {
    configurable: true,
    value: () => 0,
  });

  try {
    return await operation();
  } finally {
    Object.defineProperty(globalThis.crypto, 'randomUUID', {
      configurable: true,
      value: originalRandomUuid,
    });
    Object.defineProperty(Date, 'now', {
      configurable: true,
      value: originalDateNow,
    });
  }
}

async function waitForCheckpoint(engine: Engine, workflowId: string): Promise<void> {
  await waitForCondition(
    async () => {
      const checkpoints = await engine.listCheckpoints(workflowId);
      return checkpoints.length > 0;
    },
    { timeoutMs: 500, intervalMs: 1, label: `checkpoint for ${workflowId}` },
  );
}

async function pipeStageOne(_ctx: StepWorkflowContext, input: unknown): Promise<string> {
  return `s1:${String(input)}`;
}

async function pipeStageTwo(_ctx: StepWorkflowContext, input: unknown): Promise<string> {
  return `s2:${String(input)}`;
}

async function pipeStageThree(_ctx: StepWorkflowContext, input: unknown): Promise<string> {
  return `s3:${String(input)}`;
}

function registerSimpleSequential(engine: Engine): void {
  engine.register('simple-sequential', async function* (ctx: WorkflowContext, input: unknown) {
    const result = yield* (ctx as Context).run(
      async (value: unknown) => `processed:${String(value)}`,
      input,
    );
    return result;
  });
}

function registerTwoParallel(engine: Engine): void {
  engine.register('two-parallel', async function* (ctx: WorkflowContext, input: unknown) {
    const context = ctx as Context;
    const [left, right] = yield* context.all([
      context.run(async (value: unknown) => `left:${String(value)}`, input),
      context.run(async (value: unknown) => `right:${String(value)}`, input),
    ]);

    return { a: left, b: right };
  });
}

function registerRaceTakesFirst(engine: Engine): void {
  engine.register('race-takes-first', async function* (ctx: WorkflowContext) {
    const context = ctx as Context;
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
    const payload = yield* (ctx as Context).waitForSignal('go');
    return { received: payload };
  });
}

function registerSleepAndResume(engine: Engine): void {
  engine.register('sleep-and-resume', async function* (ctx: WorkflowContext) {
    yield* (ctx as Context).sleep(100);
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
    const childResult = yield* (ctx as Context).startChild('child-workflow-child', input);
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
      yield* (ctx as Context).saga([
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
  engine.register('pipe-three-stages', async function* (ctx: WorkflowContext, input: unknown) {
    return yield* ctx.pipe([pipeStageOne, pipeStageTwo, pipeStageThree], input);
  });
  engine.register('stage1', pipeStageOne);
  engine.register('stage2', pipeStageTwo);
  engine.register('stage3', pipeStageThree);
}

function registerForkFromCheckpoint(engine: Engine): void {
  engine.register('fork-from-checkpoint', async function* (ctx: WorkflowContext) {
    const context = ctx as Context;
    const phaseOne = yield* context.run(async () => 'phase-one');
    const branch = yield* context.waitForSignal('branch');
    return `${String(phaseOne)}:${String(branch)}`;
  });
}

function registerRecoveryAfterCrash(engine: Engine): void {
  engine.register('recovery-after-crash', async function* (ctx: WorkflowContext) {
    const context = ctx as Context;
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
    throw new Error(`No replay handler registered for "${scenario}"`);
  }

  registrar(engine);
}

async function runFixtureWorkflow(fixture: TraceFixture): Promise<ScenarioRun> {
  const engine = new TestEngine({ startTime: 0 });
  registerScenarioHandlers(engine, fixture.scenario);

  const workflowId = fixture.finalState.id;
  const handle = await engine.start(fixture.scenario, fixture.finalState.input, { id: workflowId });
  await handle.result();

  return { engine, workflowId };
}

async function runSignalAndWaitFixture(fixture: TraceFixture): Promise<ScenarioRun> {
  const engine = new TestEngine({ startTime: 0 });
  registerSignalAndWait(engine);

  const workflowId = fixture.finalState.id;
  const handle = await engine.start(fixture.scenario, fixture.finalState.input, { id: workflowId });
  await waitForCheckpoint(engine, workflowId);
  await engine.signal(workflowId, 'go', 'proceed');
  await handle.result();

  return { engine, workflowId };
}

async function runSleepAndResumeFixture(fixture: TraceFixture): Promise<ScenarioRun> {
  const engine = new TestEngine({ startTime: 0 });
  registerSleepAndResume(engine);

  const workflowId = fixture.finalState.id;
  const handle = await engine.start(fixture.scenario, fixture.finalState.input, { id: workflowId });
  await engine.advanceTime(100);
  await handle.result();

  return { engine, workflowId };
}

async function runRecoveryAfterCrashFixture(fixture: TraceFixture): Promise<ScenarioRun> {
  const engine = new TestEngine({ startTime: 0 });
  registerRecoveryAfterCrash(engine);

  const workflowId = fixture.finalState.id;
  await engine.start(fixture.scenario, fixture.finalState.input, { id: workflowId });
  await waitForCheckpoint(engine, workflowId);

  const recovered = engine.recover();
  engine[Symbol.dispose]();
  registerRecoveryAfterCrash(recovered);

  const recoveredHandles = await recovered.recoverAll();
  for (const recoveredHandle of recoveredHandles) {
    await recoveredHandle.result();
  }

  const recoveredState = await recovered.get(workflowId);
  if (recoveredState?.status !== 'completed') {
    await recovered.getHandle(workflowId).result();
  }

  return { engine: recovered, workflowId };
}

const scenarioRunners: Record<string, ScenarioRunner> = {
  'simple-sequential': runFixtureWorkflow,
  'two-parallel': runFixtureWorkflow,
  'signal-and-wait': runSignalAndWaitFixture,
  'sleep-and-resume': runSleepAndResumeFixture,
  'child-workflow': runFixtureWorkflow,
  'saga-with-compensation': runFixtureWorkflow,
  'pipe-three-stages': runFixtureWorkflow,
  'recovery-after-crash': runRecoveryAfterCrashFixture,
};

async function runScenarioFromFixture(fixture: TraceFixture): Promise<ScenarioRun> {
  const runner = scenarioRunners[fixture.scenario];

  if (runner === undefined) {
    throw new Error(`No replay runner registered for "${fixture.scenario}"`);
  }

  return withDeterministicRuntime(() => runner(fixture));
}

async function expectReplayToMatchFixture(fixtureFile: string): Promise<void> {
  const fixture = await loadFixture(fixtureFile);
  const { engine, workflowId } = await runScenarioFromFixture(fixture);

  try {
    await expect(engine.get(workflowId)).resolves.toEqual(fixture.finalState);
    await expect(engine.getEvents(workflowId)).resolves.toEqual(fixture.events);
    await expect(engine.getTimeline(workflowId)).resolves.toEqual(fixture.timeline);
    expect(storageAsBase64Record(sortedStorageEntries(engine.storage))).toEqual(fixture.storage);
  } finally {
    engine[Symbol.dispose]();
  }
}

describe('storage format compatibility', () => {
  let engine: Engine | undefined;

  afterEach(() => {
    engine?.[Symbol.dispose]();
    engine = undefined;
  });

  it('has the expected fixture count', () => {
    expect(fixtureFiles).toHaveLength(expectedFixtureCount);
  });

  for (const fixtureFile of fixtureFiles) {
    it(`deserializes ${fixtureFile}`, async () => {
      const fixture = await loadFixture(fixtureFile);
      const storage = await storageFromFixture(fixture);
      engine = new Engine({ storage });
      const workflowId = fixture.finalState.id;

      await expect(engine.getEvents(workflowId)).resolves.toEqual(fixture.events);
      await expect(engine.getTimeline(workflowId)).resolves.toEqual(fixture.timeline);
      await expect(engine.get(workflowId)).resolves.toEqual(fixture.finalState);
    });
  }
});

describe('write-path replay', () => {
  for (const fixtureFile of replayableScenarioFiles) {
    it(`replays ${fixtureFile}`, async () => {
      await expectReplayToMatchFixture(fixtureFile);
    });
  }

  test.skip('replays race-takes-first.json', () => {
    // REPLAY-MISSING-METADATA: this fixture depends on host timer scheduling
    // inside a race and does not yet encode enough metadata to make the winner
    // deterministic without reusing the fixture generator runtime exactly.
  });

  test.skip('replays fork-from-checkpoint.json', () => {
    // REPLAY-MISSING-METADATA: this fixture covers two terminal workflows
    // produced by start(), fork(), and separate branch signals. The JSON
    // fixture only names the original workflow as finalState, so the write-path
    // contract needs explicit fork metadata before this can be a focused replay
    // assertion instead of a copy of the generator.
  });
});
