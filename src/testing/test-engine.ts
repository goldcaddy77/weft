/**
 * Test-oriented Engine subclass with virtual time control and activity mocking.
 *
 * Wraps Engine with a MemoryStorage, TimeControl, and ActivityMockRegistry
 * so tests can advance time deterministically and substitute activity
 * implementations without touching real infrastructure.
 *
 * @module testing/test-engine
 */

import { Engine } from '../core/engine.ts';
import { parseDuration } from '../core/scheduler.ts';
import type { Duration } from '../core/types.ts';
import { MemoryStorage } from '../storage/memory.ts';
import type { MockHandle } from './mocks.ts';
import { ActivityMockRegistry } from './mocks.ts';
import { TimeControl } from './time-control.ts';

export class TestEngine extends Engine {
  #timeControl: TimeControl;
  #mocks: ActivityMockRegistry;
  #memoryStorage: MemoryStorage;

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

  /** Direct access to the underlying MemoryStorage for assertions. */
  override get storage(): MemoryStorage {
    return this.#memoryStorage;
  }

  /** Direct access to mock registry. */
  get mocks(): ActivityMockRegistry {
    return this.#mocks;
  }
}
