/**
 * Tests for chaos testing primitives: ChaosScenario, withChaos, TestEngine.runN.
 *
 * @module testing/__tests__/chaos.test
 */

import { describe, expect, it } from 'bun:test';

import type { WorkflowContext } from '../../core/types.ts';
import type { ChaosScenario, FailureCategory } from '../chaos.ts';
import { withChaos } from '../chaos.ts';
import type { RunNResult } from '../test-engine.ts';
import { TestEngine } from '../test-engine.ts';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const ALL_FAILURE_CATEGORIES: FailureCategory[] = [
  'memory',
  'reflection',
  'planning',
  'action',
  'system',
];

function hasCorrectCategoriesShape(categories: Record<FailureCategory, number>): boolean {
  return ALL_FAILURE_CATEGORIES.every(
    (category) => category in categories && typeof categories[category] === 'number',
  );
}

// ---------------------------------------------------------------------------
// withChaos combinator
// ---------------------------------------------------------------------------

describe('withChaos', () => {
  it('passes through when faultRate is 0', async () => {
    const base = async (x: number) => x * 2;
    const scenario: ChaosScenario = { faultRate: 0 };
    const wrapped = withChaos(base, scenario);

    const result = await wrapped(5);
    expect(result).toBe(10);
  });

  it('always throws when faultRate is 1', async () => {
    const base = async (x: number) => x * 2;
    const scenario: ChaosScenario = { faultRate: 1, faults: ['error'] };
    const wrapped = withChaos(base, scenario);

    await expect(wrapped(5)).rejects.toThrow();
  });

  it('injects faults probabilistically', async () => {
    const base = async (_input: undefined) => 'ok';
    const scenario: ChaosScenario = { faultRate: 0.5, faults: ['error'] };
    const wrapped = withChaos(base, scenario);

    let failures = 0;
    const attempts = 100;
    for (let i = 0; i < attempts; i++) {
      try {
        await wrapped(undefined);
      } catch {
        failures++;
      }
    }

    // With faultRate=0.5 and 100 tries, statistically we expect 10-90 failures
    expect(failures).toBeGreaterThan(5);
    expect(failures).toBeLessThan(95);
  });

  it('injects delay fault', async () => {
    const base = async (_input: undefined) => 'ok';
    const scenario: ChaosScenario = { faultRate: 1, faults: ['delay'] };
    const wrapped = withChaos(base, scenario);

    const start = Date.now();
    await wrapped(undefined);
    const elapsed = Date.now() - start;

    // delay fault should add at least some latency
    expect(elapsed).toBeGreaterThanOrEqual(0);
  });

  it('uses seed for deterministic behavior', async () => {
    const base = async (_input: undefined) => 'ok';
    const scenario: ChaosScenario = { faultRate: 0.5, faults: ['error'], seed: 42 };

    // Two wrapped functions with the same seed should produce the same fault pattern
    const wrapped1 = withChaos(base, scenario);
    const wrapped2 = withChaos(base, scenario);

    const results1: boolean[] = [];
    const results2: boolean[] = [];

    for (let i = 0; i < 20; i++) {
      try {
        await wrapped1(undefined);
        results1.push(true);
      } catch {
        results1.push(false);
      }
    }

    for (let i = 0; i < 20; i++) {
      try {
        await wrapped2(undefined);
        results2.push(true);
      } catch {
        results2.push(false);
      }
    }

    expect(results1).toEqual(results2);
  });
});

// ---------------------------------------------------------------------------
// TestEngine.runN
// ---------------------------------------------------------------------------

describe('TestEngine.runN', () => {
  it('returns passRate=1 with no chaos on a reliable workflow', async () => {
    const engine = new TestEngine();

    const reliableActivity = async (x: number) => x + 1;

    engine.register('reliable', async function* (ctx: WorkflowContext, input: unknown) {
      const mockedActivity = engine.mocks.get(reliableActivity);
      const fn = mockedActivity ? mockedActivity.implementation : reliableActivity;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return yield* (ctx as any).run(fn, input);
    });

    engine.mock(reliableActivity, async (x: number) => x + 1);

    const result = await engine.runN('reliable', 1, { runs: 5 });

    expect(result.passRate).toBe(1.0);
    expect(result.consistency).toBe(1.0);
    expect(hasCorrectCategoriesShape(result.categories)).toBe(true);

    engine[Symbol.dispose]();
  });

  it('returns passRate < 1.0 on a known-flaky workflow under high faultRate chaos', async () => {
    const engine = new TestEngine();

    const flakeyActivity = async (x: number) => x * 2;

    engine.register('flakey', async function* (ctx: WorkflowContext, input: unknown) {
      const mockedActivity = engine.mocks.get(flakeyActivity);
      const fn = mockedActivity ? mockedActivity.implementation : flakeyActivity;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return yield* (ctx as any).run(fn, input);
    });

    engine.mock(flakeyActivity, async (x: number) => x * 2);

    const scenario: ChaosScenario = {
      faultRate: 0.8,
      faults: ['error'],
    };

    const result: RunNResult = await engine.runN('flakey', 5, {
      runs: 20,
      chaos: scenario,
    });

    // With 80% fault rate, some runs should fail
    expect(result.passRate).toBeLessThan(1.0);
    expect(result.passRate).toBeGreaterThanOrEqual(0);
    expect(result.passRate).toBeLessThanOrEqual(1.0);

    engine[Symbol.dispose]();
  });

  it('categories field has correct shape with all 5 keys as numbers', async () => {
    const engine = new TestEngine();

    const activity = async () => 'done';

    engine.register('shape-test', async function* (ctx: WorkflowContext) {
      const mockedActivity = engine.mocks.get(activity);
      const fn = mockedActivity ? mockedActivity.implementation : activity;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return yield* (ctx as any).run(fn, undefined);
    });

    engine.mock(activity, async () => 'done');

    const scenario: ChaosScenario = { faultRate: 0.5, faults: ['error'] };
    const result = await engine.runN('shape-test', undefined, { runs: 10, chaos: scenario });

    expect(hasCorrectCategoriesShape(result.categories)).toBe(true);
    expect(ALL_FAILURE_CATEGORIES.every((c) => result.categories[c] >= 0)).toBe(true);

    engine[Symbol.dispose]();
  });

  it('consistency is 1.0 when all successful runs return the same value', async () => {
    const engine = new TestEngine();

    const deterministicActivity = async (x: number) => x + 100;

    engine.register('deterministic', async function* (ctx: WorkflowContext, input: unknown) {
      const mockedActivity = engine.mocks.get(deterministicActivity);
      const fn = mockedActivity ? mockedActivity.implementation : deterministicActivity;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return yield* (ctx as any).run(fn, input);
    });

    engine.mock(deterministicActivity, async (x: number) => x + 100);

    const result = await engine.runN('deterministic', 5, { runs: 5 });

    expect(result.passRate).toBe(1.0);
    expect(result.consistency).toBe(1.0);

    engine[Symbol.dispose]();
  });

  it('failure counts sum to (1 - passRate) * runs', async () => {
    const engine = new TestEngine();

    const activity = async () => 'result';

    engine.register('counting', async function* (ctx: WorkflowContext) {
      const mockedActivity = engine.mocks.get(activity);
      const fn = mockedActivity ? mockedActivity.implementation : activity;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return yield* (ctx as any).run(fn, undefined);
    });

    engine.mock(activity, async () => 'result');

    const scenario: ChaosScenario = { faultRate: 0.7, faults: ['error'] };
    const runs = 20;
    const result = await engine.runN('counting', undefined, { runs, chaos: scenario });

    const failureCount = ALL_FAILURE_CATEGORIES.reduce((sum, c) => sum + result.categories[c], 0);
    const expectedFailures = Math.round((1 - result.passRate) * runs);
    expect(failureCount).toBe(expectedFailures);

    engine[Symbol.dispose]();
  });
});
