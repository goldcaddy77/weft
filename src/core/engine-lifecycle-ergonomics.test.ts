import { afterEach, describe, expect, it } from 'bun:test';

import { MemoryStorage } from '../storage/memory.ts';
import { sleepForTesting } from '../testing/fake-timers.ts';
import { flush } from '../testing/storage-backends.ts';
import {
  Engine,
  setEngineLeakWarningOverrideForTesting,
  shouldEmitEngineLeakWarningForTesting,
} from './engine.ts';
import { activity, workflow, type WorkflowContext } from './types.ts';

async function forceFinalizers(
  weakReference: WeakRef<object>,
  stopWhen?: () => boolean,
  options?: { requireCollection?: boolean },
): Promise<void> {
  let postCollectionCycles = 0;

  for (let attempt = 0; attempt < 100; attempt++) {
    Bun.gc(true);
    await flush();
    await sleepForTesting(5);

    if (weakReference.deref() !== undefined) continue;

    if (stopWhen?.() === true) return;

    postCollectionCycles++;
    if (stopWhen === undefined && postCollectionCycles >= 5) return;
  }

  if (options?.requireCollection !== false) {
    throw new Error('Expected leaked Engine to be garbage-collected during the warning test.');
  }
}

async function captureWarnings(
  run: () => WeakRef<object>,
  stopWhen?: (warnings: Error[]) => boolean,
  options?: { requireCollection?: boolean },
): Promise<Error[]> {
  const warnings: Error[] = [];
  const onWarning = (warning: Error) => {
    warnings.push(warning);
  };
  process.on('warning', onWarning);
  try {
    const weakReference = run();
    await flush();
    await forceFinalizers(weakReference, () => stopWhen?.(warnings) === true, options);
    await flush();
  } finally {
    process.off('warning', onWarning);
  }
  return warnings;
}

function createLeakedEngine(): WeakRef<object> {
  const engine = new Engine();
  return new WeakRef(engine);
}

describe('Engine lifecycle ergonomics', () => {
  afterEach(() => {
    setEngineLeakWarningOverrideForTesting(undefined);
  });

  it('emits one development warning when an engine is garbage-collected without disposal', async () => {
    setEngineLeakWarningOverrideForTesting(true);

    const warnings = await captureWarnings(createLeakedEngine, (capturedWarnings) =>
      capturedWarnings.some((warning) => warning.message.includes('WeftEngineLeakWarning')),
    );

    const disposalWarnings = warnings.filter((warning) =>
      warning.message.includes('WeftEngineLeakWarning'),
    );
    expect(disposalWarnings).toHaveLength(1);
    expect(disposalWarnings[0]!.message).toContain('[Symbol.dispose]');
  });

  it('does not emit disposal warnings when the leak-warning gate is disabled', async () => {
    setEngineLeakWarningOverrideForTesting(false);
    expect(shouldEmitEngineLeakWarningForTesting()).toBe(false);

    const warnings = await captureWarnings(createLeakedEngine, undefined, {
      requireCollection: false,
    });

    expect(
      warnings.filter((warning) => warning.message.includes('WeftEngineLeakWarning')),
    ).toHaveLength(0);

    setEngineLeakWarningOverrideForTesting(true);
    expect(shouldEmitEngineLeakWarningForTesting()).toBe(true);
  });

  it('requires explicit recovery for both new Engine and Engine.create', async () => {
    const storage = new MemoryStorage();
    const resumable = workflow({
      name: 'resumable',
      handler: async function* (ctx: WorkflowContext) {
        yield* ctx.sleep('1h');
        return 'done';
      },
    });

    const original = new Engine({ storage });
    original.register(resumable);
    const handle = await original.start('resumable', undefined, { id: 'recoverable-workflow' });
    handle.result().catch(() => {});
    await flush();
    original[Symbol.dispose]();

    const createdWithoutRecovery = await Engine.create({ storage });
    expect(await createdWithoutRecovery.get('recoverable-workflow')).not.toBeNull();
    createdWithoutRecovery[Symbol.dispose]();

    const recovered = await Engine.create({
      storage,
      workflows: { resumable },
      recover: true,
    });
    expect(await recovered.get('recoverable-workflow')).not.toBeNull();
    recovered[Symbol.dispose]();
  });

  it('registers activity definitions through register()', async () => {
    const greet = activity({
      name: 'greet',
      execute: async (input: { name: string }) => `Hello, ${input.name}`,
    });
    const welcome = workflow({
      name: 'welcome',
      handler: async function* (ctx: WorkflowContext, input: { name: string }) {
        return yield* ctx.run(greet, input);
      },
    });

    const engine = new Engine();
    engine.register(greet).register(welcome);

    const handle = await engine.start('welcome', { name: 'Ada' });
    await expect(handle.result()).resolves.toBe('Hello, Ada');
    engine[Symbol.dispose]();
  });
});
