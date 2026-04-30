/**
 * Type-safe activity mocking with call recording for testing.
 *
 * Provides an `ActivityMockRegistry` to register mock implementations
 * of activity functions, inspect call history, and configure per-call
 * overrides (one-shot return values, one-shot rejections).
 *
 * @module testing/mocks
 */

// ---------------------------------------------------------------------------
// Public interfaces
// ---------------------------------------------------------------------------

/**
 * A single recorded call on a mock activity.
 *
 * @example
 * ```ts
 * import { TestEngine, type MockCall } from 'weft';
 *
 * const engine = new TestEngine();
 * async function sendEmail(input: unknown): Promise<string> { return ''; }
 * const mockHandle = engine.mock(sendEmail, async (input: unknown) => 'sent');
 * await engine.start('notify', { to: 'user@example.com' });
 * const call: MockCall<[unknown], string> = mockHandle.calls[0]!;
 * console.log(call.args[0]); // { to: 'user@example.com' }
 * ```
 */
export interface MockCall<TArgs extends unknown[], TResult> {
  readonly args: TArgs;
  readonly result: TResult | undefined;
  readonly error: Error | undefined;
  readonly timestamp: number;
}

/**
 * Handle returned by {@link ActivityMockRegistry.mock} that lets tests inspect
 * call history and configure one-shot overrides.
 *
 * Call `mockReturnValueOnce` or `mockRejectionOnce` to inject a specific
 * outcome for the next invocation, then check `calls` to assert what arguments
 * were passed.  Use `restore()` to remove the mock and revert to the real
 * implementation.
 *
 * @example
 * ```ts
 * import { TestEngine, type MockHandle } from 'weft';
 *
 * const engine = new TestEngine();
 * async function sendEmail(input: unknown): Promise<string> { return 'real'; }
 *
 * const handle: MockHandle<[unknown], string> =
 *   engine.mock(sendEmail, async (input: unknown) => 'mocked');
 *
 * handle.mockReturnValueOnce('override');
 * console.log(handle.callCount); // 0
 * await engine.start('notify', { to: 'user@example.com' });
 * ```
 */
export interface MockHandle<TArgs extends unknown[], TResult> {
  readonly calls: ReadonlyArray<MockCall<TArgs, TResult>>;
  readonly callCount: number;
  readonly lastCall: MockCall<TArgs, TResult> | undefined;
  /** The current base implementation (excludes one-time overrides). */
  readonly currentImplementation: (...args: TArgs) => TResult | Promise<TResult>;
  mockImplementation(implementation: (...args: TArgs) => TResult | Promise<TResult>): void;
  mockReturnValueOnce(value: TResult): MockHandle<TArgs, TResult>;
  mockRejectionOnce(error: Error): MockHandle<TArgs, TResult>;
  resetCalls(): void;
  restore(): void;
}

// ---------------------------------------------------------------------------
// Internal types
// ---------------------------------------------------------------------------

/**
 * Internal record held by {@link ActivityMockRegistry} for each mocked
 * activity.
 *
 * Contains the current `implementation` function (which records calls and
 * applies one-time overrides) and the typed `handle` through which tests
 * inspect and configure the mock.  Most consumers interact with
 * {@link MockHandle} instead of `MockedActivity` directly.
 *
 * @example
 * ```ts
 * import { ActivityMockRegistry, type MockedActivity } from 'weft';
 *
 * const registry = new ActivityMockRegistry();
 * async function fetchUser(id: unknown): Promise<string> { return String(id); }
 *
 * registry.mock(fetchUser, async (id: unknown) => 'user-mock');
 * const mocked: MockedActivity | undefined = registry.get(fetchUser);
 * console.log(typeof mocked?.implementation); // 'function'
 * ```
 */
export interface MockedActivity {
  implementation: (...args: unknown[]) => unknown;
  handle: MockHandle<unknown[], unknown>;
}

type OneTimeOverride<TResult> =
  | { type: 'return'; value: TResult }
  | { type: 'reject'; error: Error };

// ---------------------------------------------------------------------------
// MockHandle implementation
// ---------------------------------------------------------------------------

class MockHandleImplementation<TArgs extends unknown[], TResult> implements MockHandle<
  TArgs,
  TResult
> {
  #calls: Array<MockCall<TArgs, TResult>> = [];
  #baseImplementation: (...args: TArgs) => TResult | Promise<TResult>;
  #oneTimeOverrides: Array<OneTimeOverride<TResult>> = [];
  readonly #onRestore: () => void;

  constructor(
    baseImplementation: (...args: TArgs) => TResult | Promise<TResult>,
    onRestore: () => void,
  ) {
    this.#baseImplementation = baseImplementation;
    this.#onRestore = onRestore;
  }

  get calls(): ReadonlyArray<MockCall<TArgs, TResult>> {
    return this.#calls;
  }

  get callCount(): number {
    return this.#calls.length;
  }

  get lastCall(): MockCall<TArgs, TResult> | undefined {
    return this.#calls[this.#calls.length - 1];
  }

  get currentImplementation(): (...args: TArgs) => TResult | Promise<TResult> {
    return this.#baseImplementation;
  }

  mockImplementation(implementation: (...args: TArgs) => TResult | Promise<TResult>): void {
    this.#baseImplementation = implementation;
  }

  mockReturnValueOnce(value: TResult): MockHandle<TArgs, TResult> {
    this.#oneTimeOverrides.push({ type: 'return', value });
    return this;
  }

  mockRejectionOnce(error: Error): MockHandle<TArgs, TResult> {
    this.#oneTimeOverrides.push({ type: 'reject', error });
    return this;
  }

  resetCalls(): void {
    this.#calls = [];
  }

  restore(): void {
    this.#onRestore();
  }

  /** Called internally to execute the mock and record the call. */
  async execute(...args: TArgs): Promise<TResult> {
    const override = this.#oneTimeOverrides.shift();

    if (override?.type === 'reject') {
      const call: MockCall<TArgs, TResult> = {
        args,
        result: undefined,
        error: override.error,
        timestamp: Date.now(),
      };
      this.#calls.push(call);
      throw override.error;
    }

    if (override?.type === 'return') {
      const call: MockCall<TArgs, TResult> = {
        args,
        result: override.value,
        error: undefined,
        timestamp: Date.now(),
      };
      this.#calls.push(call);
      return override.value;
    }

    try {
      const result = await this.#baseImplementation(...args);
      const call: MockCall<TArgs, TResult> = {
        args,
        result,
        error: undefined,
        timestamp: Date.now(),
      };
      this.#calls.push(call);
      return result;
    } catch (thrown) {
      const error = thrown instanceof Error ? thrown : new Error(String(thrown));
      const call: MockCall<TArgs, TResult> = {
        args,
        result: undefined,
        error,
        timestamp: Date.now(),
      };
      this.#calls.push(call);
      throw error;
    }
  }
}

// ---------------------------------------------------------------------------
// ActivityMockRegistry
// ---------------------------------------------------------------------------

/**
 * Registry for mocking activity functions in tests.
 *
 * Call `mock(activityFn, implementation)` to replace an activity with a test
 * double and receive a {@link MockHandle} for inspection and configuration.
 * Use `restoreAll()` in `afterEach` to clear all mocks between test cases.
 *
 * @example
 * ```ts
 * import { ActivityMockRegistry } from 'weft';
 *
 * async function sendEmail(input: unknown): Promise<string> { return 'sent'; }
 *
 * const registry = new ActivityMockRegistry();
 * const handle = registry.mock(sendEmail, async (input: unknown) => 'mock-sent');
 *
 * console.log(registry.has(sendEmail)); // true
 * await (registry.get(sendEmail)!.implementation)({ to: 'a@b.com' });
 * console.log(handle.callCount); // 1
 * registry.restoreAll();
 * ```
 */
export class ActivityMockRegistry {
  #mocks: Map<Function, MockedActivity>;

  constructor() {
    this.#mocks = new Map();
  }

  mock<TArgs extends unknown[], TResult>(
    activity: (...args: TArgs) => Promise<TResult> | TResult,
    implementation: (...args: TArgs) => TResult | Promise<TResult>,
  ): MockHandle<TArgs, TResult> {
    const handle = new MockHandleImplementation<TArgs, TResult>(
      implementation,
      this.restore.bind(this, activity),
    );

    const mocked: MockedActivity = {
      implementation: handle.execute.bind(handle) as (...args: unknown[]) => unknown,
      handle: handle as unknown as MockHandle<unknown[], unknown>,
    };

    this.#mocks.set(activity, mocked);
    return handle;
  }

  has(activity: Function): boolean {
    return this.#mocks.has(activity);
  }

  get(activity: Function): MockedActivity | undefined {
    return this.#mocks.get(activity);
  }

  restore(activity: Function): void {
    this.#mocks.delete(activity);
  }

  restoreAll(): void {
    this.#mocks.clear();
  }

  /**
   * Iterate all registered mock entries as `[activityFn, MockedActivity]` pairs.
   * Used internally by `TestEngine.runN` to propagate mocks to per-run engines.
   */
  entries(): IterableIterator<[Function, MockedActivity]> {
    return this.#mocks.entries();
  }
}
