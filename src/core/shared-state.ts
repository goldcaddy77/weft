import type { BatchOperation, Storage } from '../storage/interface.ts';
import { KEYS } from '../storage/interface.ts';
import { decode, encode } from './codec.ts';

export interface SharedStateOptions {
  maxRetries?: number;
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

      // Step 5: Version changed — back off before retrying to reduce contention.
      // Exponential backoff with jitter: baseDelay * 2^attempt + random jitter.
      if (attempt < this.#maxRetries - 1) {
        const baseDelay = 10;
        const delay = baseDelay * Math.pow(2, attempt) + Math.random() * baseDelay;
        await Bun.sleep(delay);
      }
    }

    // Step 6: Max retries exceeded
    throw new SharedStateConflictError(this.#stateKey, this.#maxRetries);
  }
}
