import type { BatchOperation, Storage } from '../storage/interface.ts';
import { KEYS } from '../storage/interface.ts';
import { decode, encode } from './codec.ts';

/**
 * Sleep function signature. Accepts a duration in milliseconds and returns
 * a promise that resolves after the delay. Injectable for tests.
 */
export type SleepFunction = (milliseconds: number) => Promise<void>;

export interface SharedStateOptions {
  /** Maximum number of CAS attempts before giving up. Defaults to 10. */
  maxRetries?: number;
  /** Base delay in milliseconds for exponential backoff between retries. Defaults to 5. */
  baseDelayMs?: number;
  /** Maximum delay in milliseconds for exponential backoff between retries. Defaults to 100. */
  maxDelayMs?: number;
  /**
   * Sleep function used between retry attempts. Defaults to `Bun.sleep`.
   * Exposed primarily for testing.
   */
  sleep?: SleepFunction;
}

export class SharedStateConflictError extends Error {
  readonly stateKey: string;
  readonly attempts: number;

  constructor(stateKey: string, attempts: number) {
    super(
      `SharedState conflict: failed to update "${stateKey}" after ${String(attempts)} attempts`,
    );
    this.name = 'SharedStateConflictError';
    this.stateKey = stateKey;
    this.attempts = attempts;
  }
}

export class SharedState<T> {
  #storage: Storage;
  #workflowId: string;
  #stateKey: string;
  #maxRetries: number;
  #baseDelayMs: number;
  #maxDelayMs: number;
  #sleep: SleepFunction;

  constructor(
    storage: Storage,
    workflowId: string,
    stateKey: string,
    options?: SharedStateOptions,
  ) {
    this.#storage = storage;
    this.#workflowId = workflowId;
    this.#stateKey = stateKey;
    this.#maxRetries = options?.maxRetries ?? 10;
    this.#baseDelayMs = options?.baseDelayMs ?? 5;
    this.#maxDelayMs = options?.maxDelayMs ?? 100;
    this.#sleep = options?.sleep ?? ((milliseconds) => Bun.sleep(milliseconds));
  }

  /** Read the current value. Returns initial value if no state written yet. */
  async get(initial: T): Promise<{ value: T; version: number }> {
    const dataKey = KEYS.sharedState(this.#workflowId, this.#stateKey);
    const versionKey = KEYS.sharedStateVersion(this.#workflowId, this.#stateKey);

    const [rawValue, rawVersion] = await Promise.all([
      this.#storage.get(dataKey),
      this.#storage.get(versionKey),
    ]);

    const value = rawValue ? (decode(rawValue) as T) : initial;
    const version = rawVersion ? (decode(rawVersion) as number) : 0;

    return { value, version };
  }

  /**
   * Update the state with optimistic concurrency. Retries on conflict.
   * Returns batch operations for atomic commit with checkpoint.
   */
  async update(
    fn: (current: T) => T,
    initial: T,
  ): Promise<{ value: T; version: number; operations: BatchOperation[] }> {
    const dataKey = KEYS.sharedState(this.#workflowId, this.#stateKey);
    const versionKey = KEYS.sharedStateVersion(this.#workflowId, this.#stateKey);

    for (let attempt = 0; attempt < this.#maxRetries; attempt++) {
      // Step 1: Read current value and version
      const [rawValue, rawVersion] = await Promise.all([
        this.#storage.get(dataKey),
        this.#storage.get(versionKey),
      ]);

      const currentValue = rawValue ? (decode(rawValue) as T) : initial;
      const currentVersion = rawVersion ? (decode(rawVersion) as number) : 0;

      // Step 2: Apply the update function
      const newValue = fn(currentValue);

      // Step 3: Read version again to check for concurrent writes
      const rawVersionCheck = await this.#storage.get(versionKey);
      const versionCheck = rawVersionCheck ? (decode(rawVersionCheck) as number) : 0;

      // Step 4: If version unchanged, prepare batch operations
      if (versionCheck === currentVersion) {
        const newVersion = currentVersion + 1;
        const operations: BatchOperation[] = [
          { type: 'put', key: dataKey, value: encode(newValue) },
          { type: 'put', key: versionKey, value: encode(newVersion) },
        ];

        return { value: newValue, version: newVersion, operations };
      }

      // Step 5: Version changed. Back off with exponential delay plus jitter
      // before the next attempt, but skip the delay after the final failed
      // attempt since we're about to throw.
      if (attempt < this.#maxRetries - 1) {
        const exponential = Math.min(this.#maxDelayMs, this.#baseDelayMs * Math.pow(2, attempt));
        const jittered = Math.floor(Math.random() * exponential);
        await this.#sleep(jittered);
      }
    }

    // Step 6: Max retries exceeded
    throw new SharedStateConflictError(this.#stateKey, this.#maxRetries);
  }
}
