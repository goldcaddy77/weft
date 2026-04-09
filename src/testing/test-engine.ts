/**
 * Test-oriented Engine subclass with virtual time control and activity mocking.
 *
 * Wraps Engine with a MemoryStorage, TimeControl, and ActivityMockRegistry
 * so tests can advance time deterministically and substitute activity
 * implementations without touching real infrastructure.
 *
 * @module testing/test-engine
 */

import type { AgentDefinition } from '../ai/declaration.ts';
import { Engine } from '../core/engine.ts';
import { parseDuration } from '../core/scheduler.ts';
import type {
  Duration,
  StepWorkflowFunction,
  WorkflowFunction,
  WorkflowRegistration,
} from '../core/types.ts';
import { MemoryStorage } from '../storage/memory.ts';
import type { ChaosScenario, FailureCategory } from './chaos.ts';
import { withChaos } from './chaos.ts';
import type { MockHandle } from './mocks.ts';
import { ActivityMockRegistry } from './mocks.ts';
import { TimeControl } from './time-control.ts';

// ---------------------------------------------------------------------------
// runN types
// ---------------------------------------------------------------------------

/** Options for {@link TestEngine.runN}. */
export interface RunNOptions {
  /** Number of independent runs to execute. */
  runs: number;
  /** Optional chaos scenario to apply across all runs. */
  chaos?: ChaosScenario;
}

/**
 * Aggregate reliability metrics returned by {@link TestEngine.runN}.
 */
export interface RunNResult {
  /** Fraction of runs [0, 1] that completed successfully. */
  passRate: number;
  /**
   * Fraction of successful runs [0, 1] that returned the same output as the
   * first successful run. `1.0` means all successes were identical.
   * `NaN` if there were no successful runs.
   */
  consistency: number;
  /** Count of failures bucketed by failure category. */
  categories: Record<FailureCategory, number>;
}

// ---------------------------------------------------------------------------
// Internal type for captured registration entries
// ---------------------------------------------------------------------------

type CapturedRegistration =
  | { kind: 'handler'; name: string; handler: WorkflowFunction | StepWorkflowFunction }
  | { kind: 'registration'; name: string; registration: WorkflowRegistration };

// ---------------------------------------------------------------------------
// TestEngine
// ---------------------------------------------------------------------------

export class TestEngine extends Engine {
  #timeControl: TimeControl;
  #mocks: ActivityMockRegistry;
  #memoryStorage: MemoryStorage;

  /**
   * Captured workflow registrations so `runN` can re-register them on
   * per-run engine instances. Populated by the overridden `register` method.
   *
   * Agent registrations are intentionally excluded — chaos testing targets
   * activity-level workflows, not multi-turn LLM agents.
   */
  #capturedRegistrations: CapturedRegistration[] = [];

  constructor(options?: { startTime?: number }) {
    const storage = new MemoryStorage();
    const timeControl = new TimeControl(options?.startTime);

    super({
      storage,
      getNow: () => timeControl.now,
    });

    this.#timeControl = timeControl;
    this.#mocks = new ActivityMockRegistry();
    this.#memoryStorage = storage;
  }

  // ---------------------------------------------------------------------------
  // register override — capture for runN re-registration
  // ---------------------------------------------------------------------------

  override register(name: string, handler: WorkflowFunction | StepWorkflowFunction): void;
  override register(name: string, registration: WorkflowRegistration): void;
  override register(agentDef: AgentDefinition, options: object): void;
  override register(
    nameOrAgent: string | AgentDefinition,
    handlerOrRegistrationOrOptions:
      | WorkflowFunction
      | StepWorkflowFunction
      | WorkflowRegistration
      | object,
  ): void {
    // Delegate to the parent implementation first.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (super.register as (...args: any[]) => void)(nameOrAgent, handlerOrRegistrationOrOptions);

    // Capture non-agent registrations for runN.
    if (typeof nameOrAgent === 'string') {
      const name = nameOrAgent;
      const handlerOrRegistration = handlerOrRegistrationOrOptions as
        | WorkflowFunction
        | StepWorkflowFunction
        | WorkflowRegistration;

      const isRegistrationObject =
        typeof handlerOrRegistration === 'object' &&
        handlerOrRegistration !== null &&
        'handler' in handlerOrRegistration;

      if (isRegistrationObject) {
        this.#capturedRegistrations.push({
          kind: 'registration',
          name,
          registration: handlerOrRegistration,
        });
      } else {
        this.#capturedRegistrations.push({
          kind: 'handler',
          name,
          handler: handlerOrRegistration,
        });
      }
    }
    // Agent definitions are not captured — runN does not replay agent workflows.
  }

  // ---------------------------------------------------------------------------
  // Time control
  // ---------------------------------------------------------------------------

  /**
   * Advance virtual time by the given duration. Fires any scheduler
   * timers that fall within the advanced window.
   */
  async advanceTime(duration: Duration): Promise<void> {
    const milliseconds = parseDuration(duration);
    const target = this.#timeControl.now + milliseconds;

    // Advance time control (fires TimeControl timers)
    await this.#timeControl.advance(duration);

    // Tick the scheduler at the new time to fire durable timers
    await this.scheduler.tick(target);

    // Allow microtasks to settle
    await Bun.sleep(1);
  }

  /** Current virtual time in milliseconds since epoch. */
  get now(): number {
    return this.#timeControl.now;
  }

  // ---------------------------------------------------------------------------
  // Mocking
  // ---------------------------------------------------------------------------

  /**
   * Register a mock implementation for an activity function.
   * When the engine encounters this activity, it will call the mock instead.
   */
  mock<TArgs extends unknown[], TResult>(
    activity: (...args: TArgs) => Promise<TResult> | TResult,
    implementation: (...args: TArgs) => TResult | Promise<TResult>,
  ): MockHandle<TArgs, TResult> {
    return this.#mocks.mock(activity, implementation);
  }

  // ---------------------------------------------------------------------------
  // Recovery
  // ---------------------------------------------------------------------------

  /**
   * Create a new TestEngine backed by the same storage, simulating
   * engine recovery (like a process restart). The new engine sees all
   * persisted state but has fresh in-memory structures.
   */
  recover(): TestEngine {
    // We cannot directly share a MemoryStorage instance via the constructor
    // because the constructor always creates a new one. Instead we return
    // a plain Engine configured with the same storage and timeControl.
    // This is a simplified recovery for the testing layer.
    const recovered = new TestEngine({ startTime: this.#timeControl.now });
    // Copy storage contents from the current engine to the recovered one
    const snapshot = this.#memoryStorage.snapshot();
    for (const [key, value] of snapshot) {
      // We need to write synchronously-ish. Since MemoryStorage is sync
      // under the hood, we just fire-and-forget the put calls.
      void recovered.#memoryStorage.put(key, value);
    }
    return recovered;
  }

  // ---------------------------------------------------------------------------
  // Storage / mock accessors
  // ---------------------------------------------------------------------------

  /** Direct access to the underlying MemoryStorage for assertions. */
  override get storage(): MemoryStorage {
    return this.#memoryStorage;
  }

  /** Direct access to mock registry. */
  get mocks(): ActivityMockRegistry {
    return this.#mocks;
  }

  // ---------------------------------------------------------------------------
  // runN
  // ---------------------------------------------------------------------------

  /**
   * Run the named workflow N times and return aggregate reliability metrics.
   *
   * Runs are serial and independent. If a `chaos` scenario is provided, each
   * registered activity mock is temporarily wrapped with `withChaos` for the
   * duration of that run, then restored. This ensures that the workflow
   * functions — which close over `this` engine's mock registry — observe the
   * chaos-injected implementations during each run.
   *
   * Workflow state isolation is achieved by using unique per-run workflow IDs,
   * so previous results do not influence subsequent runs.
   *
   * @param type    The registered workflow type name.
   * @param input   Input passed to each run.
   * @param options `{ runs, chaos? }` — number of runs and optional scenario.
   * @returns       `{ passRate, consistency, categories }` aggregate metrics.
   */
  async runN(type: string, input: unknown, options: RunNOptions): Promise<RunNResult> {
    const { runs, chaos } = options;

    let passes = 0;
    const successOutputs: unknown[] = [];
    const categories: Record<FailureCategory, number> = {
      memory: 0,
      reflection: 0,
      planning: 0,
      action: 0,
      system: 0,
    };

    for (let i = 0; i < runs; i++) {
      // Temporarily wrap all mocks with chaos for this run.
      // Save original base implementations so they can be restored afterward.
      const savedImplementations = new Map<Function, (...args: unknown[]) => unknown>();

      if (chaos) {
        for (const [activity, mocked] of this.#mocks.entries()) {
          // Capture the current base implementation (not the bound execute wrapper).
          const original = mocked.handle.currentImplementation;
          savedImplementations.set(activity, original);

          // Build a chaos-wrapped version of the variadic original.
          const chaosWrapped = withChaos((args: unknown[]) => original(...args), chaos);

          // Replace the handle's base implementation for this run.
          mocked.handle.mockImplementation((...args: unknown[]) => chaosWrapped(args));
        }
      }

      try {
        // Use a unique ID per run to keep workflow state isolated.
        const runId = `runN-${type}-${i}-${Date.now()}`;
        const handle = await this.start(type, input, { id: runId });
        const output = await handle.result();
        passes++;
        successOutputs.push(output);
      } catch {
        // Stub: all failures categorized as 'system' until failureCategory
        // population is implemented (architecture item 5788).
        categories.system++;
      } finally {
        // Restore original mock base implementations.
        if (chaos) {
          for (const [activity, mocked] of this.#mocks.entries()) {
            const original = savedImplementations.get(activity);
            if (original !== undefined) {
              mocked.handle.mockImplementation(original as (...args: unknown[]) => unknown);
            }
          }
        }
      }
    }

    const passRate = runs > 0 ? passes / runs : 0;

    let consistency: number;
    if (successOutputs.length === 0) {
      consistency = NaN;
    } else {
      const firstOutput = JSON.stringify(successOutputs[0]);
      const identicalCount = successOutputs.filter(
        (out) => JSON.stringify(out) === firstOutput,
      ).length;
      consistency = identicalCount / successOutputs.length;
    }

    return { passRate, consistency, categories };
  }
}
