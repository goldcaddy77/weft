import { describe, expect, it } from 'bun:test';

import { MemoryStorage } from '../storage/memory';
import type { Context } from './context';
import { Engine } from './engine';
import {
  compileStepWorkflow,
  isAsyncGeneratorFunction,
  isGeneratorFunction,
  isGeneratorResult,
} from './step-context';
import type { StepWorkflowContext, WorkflowContext } from './types';

describe('step-context', () => {
  it('runs a simple step workflow', async () => {
    const engine = new Engine({ storage: new MemoryStorage() });

    engine.register('greeting', async (ctx: StepWorkflowContext, input: unknown) => {
      const { name } = input as { name: string };
      const greeting = await ctx.step('greet', () => `Hello, ${name}!`);
      const notification = await ctx.step('notify', () => `Notified: ${greeting}`);
      return { greeting, notification };
    });

    const handle = await engine.start('greeting', { name: 'World' });
    const result = await handle.result();

    expect(result).toEqual({
      greeting: 'Hello, World!',
      notification: 'Notified: Hello, World!',
    });
  });

  it('executes multiple steps in sequence', async () => {
    const engine = new Engine({ storage: new MemoryStorage() });
    const callOrder: string[] = [];

    engine.register('sequential', async (ctx: StepWorkflowContext, _input: unknown) => {
      await ctx.step('first', () => {
        callOrder.push('first');
        return 1;
      });
      await ctx.step('second', () => {
        callOrder.push('second');
        return 2;
      });
      await ctx.step('third', () => {
        callOrder.push('third');
        return 3;
      });
      return callOrder;
    });

    const handle = await engine.start('sequential', {});
    await handle.result();

    expect(callOrder).toEqual(['first', 'second', 'third']);
  });

  it('handles async step functions', async () => {
    const engine = new Engine({ storage: new MemoryStorage() });

    engine.register('async-steps', async (ctx: StepWorkflowContext, _input: unknown) => {
      const value = await ctx.step('fetch', async () => {
        await Bun.sleep(1);
        return 42;
      });
      const doubled = await ctx.step('double', async () => {
        await Bun.sleep(1);
        return value * 2;
      });
      return { value, doubled };
    });

    const handle = await engine.start('async-steps', {});
    const result = await handle.result();

    expect(result).toEqual({ value: 42, doubled: 84 });
  });

  it('propagates step errors to the workflow', async () => {
    const engine = new Engine({ storage: new MemoryStorage() });

    engine.register('error-step', async (ctx: StepWorkflowContext, _input: unknown) => {
      await ctx.step('will-fail', () => {
        throw new Error('Step failed intentionally');
      });
      return 'should not reach here';
    });

    const handle = await engine.start('error-step', {});
    await expect(handle.result()).rejects.toThrow('Step failed intentionally');
  });

  it('auto-detects step functions in register()', async () => {
    const engine = new Engine({ storage: new MemoryStorage() });

    // Register a step-based workflow (plain async function)
    engine.register('step-based', async (ctx: StepWorkflowContext, input: unknown) => {
      const { value } = input as { value: number };
      const result = await ctx.step('compute', () => value * 10);
      return result;
    });

    const handle = await engine.start('step-based', { value: 5 });
    const result = await handle.result();

    expect(result).toBe(50);
  });

  it('coexists with generator-based workflows on the same engine', async () => {
    const engine = new Engine({ storage: new MemoryStorage() });

    // Register a step-based workflow
    engine.register('step-workflow', async (ctx: StepWorkflowContext, input: unknown) => {
      const { name } = input as { name: string };
      const greeting = await ctx.step('greet', () => `Hi, ${name}!`);
      return greeting;
    });

    // Register a generator-based workflow
    engine.register('generator-workflow', async function* (ctx: WorkflowContext, input: unknown) {
      const context = ctx as Context;
      const { name } = input as { name: string };
      const greeting = yield* context.run(async () => `Hello, ${name}!`);
      return greeting;
    });

    const stepHandle = await engine.start('step-workflow', { name: 'Alice' });
    const generatorHandle = await engine.start('generator-workflow', { name: 'Bob' });

    const stepResult = await stepHandle.result();
    const generatorResult = await generatorHandle.result();

    expect(stepResult).toBe('Hi, Alice!');
    expect(generatorResult).toBe('Hello, Bob!');
  });

  it('compileStepWorkflow produces a valid generator function', async () => {
    const stepFunction = async (ctx: StepWorkflowContext, input: unknown) => {
      const { x } = input as { x: number };
      const result = await ctx.step('multiply', () => x * 3);
      return result;
    };

    const compiled = compileStepWorkflow(stepFunction);

    // The compiled function should be an async generator function
    expect(typeof compiled).toBe('function');

    // Use it through the engine to verify it works as a WorkflowFunction
    const engine = new Engine({ storage: new MemoryStorage() });
    engine.register('compiled', compiled);

    const handle = await engine.start('compiled', { x: 7 });
    const result = await handle.result();

    expect(result).toBe(21);
  });

  it('isAsyncGeneratorFunction correctly identifies function types', () => {
    const asyncGenerator = async function* () {
      yield 1;
    };
    const plainAsync = async () => 42;
    const syncFunction = () => 42;
    const syncGenerator = function* () {
      yield 1;
    };

    expect(isAsyncGeneratorFunction(asyncGenerator)).toBe(true);
    expect(isAsyncGeneratorFunction(plainAsync)).toBe(false);
    expect(isAsyncGeneratorFunction(syncFunction)).toBe(false);
    expect(isAsyncGeneratorFunction(syncGenerator)).toBe(false);
  });

  it('isGeneratorFunction correctly identifies sync generator functions', () => {
    const syncGenerator = function* () {
      yield 1;
    };
    const plainFunction = () => 42;

    expect(isGeneratorFunction(syncGenerator)).toBe(true);
    expect(isGeneratorFunction(plainFunction)).toBe(false);
  });

  it('isGeneratorResult correctly identifies generator and async generator objects', async () => {
    const syncGeneratorResult = (function* () {
      yield 1;
    })();
    const asyncGeneratorResult = (async function* () {
      yield 1;
    })();

    expect(isGeneratorResult(syncGeneratorResult)).toBe(true);
    expect(isGeneratorResult(asyncGeneratorResult)).toBe(true);
    expect(isGeneratorResult([])).toBe(false);

    await asyncGeneratorResult.return(undefined);
  });
});
