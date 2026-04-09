/**
 * Chaos testing primitives for weft workflows.
 *
 * Provides `ChaosScenario` — a type describing fault probability distributions
 * per fault class — and `withChaos(mock, scenario)` — a combinator that wraps
 * any activity mock function with fault injection controlled by the scenario.
 *
 * @module testing/chaos
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** The five agent-debug failure categories used for run bucketing. */
export type FailureCategory = 'memory' | 'reflection' | 'planning' | 'action' | 'system';

/** Fault classes that chaos injection can produce. */
export type FaultClass = 'transient' | 'timeout' | 'error' | 'delay';

/**
 * Describes fault probability distributions for a chaos test run.
 *
 * Attach a `ChaosScenario` to `TestEngine.runN` options or pass it directly
 * to `withChaos` to control how and how often faults are injected.
 */
export interface ChaosScenario {
  /**
   * Probability [0, 1] that any given activity call will have a fault injected.
   * `0` means never inject; `1` means always inject.
   */
  faultRate: number;

  /**
   * Which fault classes to enable. If omitted, defaults to all classes.
   * When a fault fires, one class is chosen uniformly at random from this list.
   */
  faults?: FaultClass[];

  /**
   * Optional integer seed for a deterministic pseudo-random number generator.
   * When provided, two `withChaos` wrappers created from the same scenario
   * will produce identical fault patterns over the same number of calls.
   */
  seed?: number;
}

// ---------------------------------------------------------------------------
// Seeded PRNG (mulberry32 — simple, fast, seedable)
// ---------------------------------------------------------------------------

function makePrng(seed: number): () => number {
  let s = seed >>> 0;
  return function next(): number {
    s += 0x6d2b79f5;
    let z = s;
    z = Math.imul(z ^ (z >>> 15), z | 1);
    z ^= z + Math.imul(z ^ (z >>> 7), z | 61);
    return ((z ^ (z >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------------------------------------------------------------------------
// withChaos combinator
// ---------------------------------------------------------------------------

/** Delay added when a 'delay' fault fires (milliseconds). */
const DELAY_FAULT_MS = 50;

/**
 * Wraps an activity mock function with fault injection driven by `scenario`.
 *
 * On each call the combinator consults the PRNG (seeded or `Math.random`) to
 * decide whether to inject a fault. If yes, it picks a fault class and either
 * throws an error, introduces a short delay, or both, depending on the class.
 * If no fault fires the underlying `mock` is called normally.
 *
 * @param mock     The activity mock implementation to wrap.
 * @param scenario The `ChaosScenario` controlling fault injection.
 * @returns        A new function with the same signature that may throw.
 */
export function withChaos<TInput, TOutput>(
  mock: (input: TInput) => Promise<TOutput> | TOutput,
  scenario: ChaosScenario,
): (input: TInput) => Promise<TOutput> {
  const random = scenario.seed !== undefined ? makePrng(scenario.seed) : () => Math.random();

  const enabledFaults: FaultClass[] =
    scenario.faults && scenario.faults.length > 0
      ? scenario.faults
      : ['transient', 'timeout', 'error', 'delay'];

  return async function chaosWrapped(input: TInput): Promise<TOutput> {
    const roll = random();

    if (roll < scenario.faultRate) {
      const faultClass = enabledFaults[Math.floor(random() * enabledFaults.length)]!;

      switch (faultClass) {
        case 'transient':
          throw new Error('[chaos] transient fault injected');

        case 'timeout':
          throw new Error('[chaos] timeout fault injected');

        case 'error':
          throw new Error('[chaos] error fault injected');

        case 'delay':
          await Bun.sleep(DELAY_FAULT_MS);
          return mock(input) as Promise<TOutput>;
      }
    }

    return mock(input) as Promise<TOutput>;
  };
}
