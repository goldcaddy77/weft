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

export interface MockCall<TArgs extends unknown[], TResult> {
  readonly args: TArgs;
  readonly result: TResult | undefined;
  readonly error: Error | undefined;
  readonly timestamp: number;
}

export interface MockHandle<TArgs extends unknown[], TResult> {
  readonly calls: ReadonlyArray<MockCall<TArgs, TResult>>;
  readonly callCount: number;
  readonly lastCall: MockCall<TArgs, TResult> | undefined;
  mockImplementation(implementation: (...args: TArgs) => TResult | Promise<TResult>): void;
  mockReturnValueOnce(value: TResult): MockHandle<TArgs, TResult>;
  mockRejectionOnce(error: Error): MockHandle<TArgs, TResult>;
  resetCalls(): void;
  restore(): void;
}

// ---------------------------------------------------------------------------
// Internal types
// ---------------------------------------------------------------------------

interface MockedActivity {
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
}
