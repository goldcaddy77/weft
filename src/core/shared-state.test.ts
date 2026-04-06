import { describe, expect, it } from 'bun:test';

import { KEYS } from '../storage/interface.ts';
import { MemoryStorage } from '../storage/memory.ts';
import { decode, encode } from './codec.ts';
import { SharedState, SharedStateConflictError } from './shared-state.ts';

function createStorage() {
  return new MemoryStorage();
}

describe('SharedState', () => {
  describe('get', () => {
    it('returns initial value when no state exists', async () => {
      const storage = createStorage();
      const state = new SharedState<number>(storage, 'wf-1', 'counter');

      const result = await state.get(0);

      expect(result.value).toBe(0);
    });

    it('returns written value after update', async () => {
      const storage = createStorage();
      const state = new SharedState<number>(storage, 'wf-1', 'counter');

      const { operations } = await state.update((current) => current + 10, 0);
      await storage.batch(operations);

      const result = await state.get(0);

      expect(result.value).toBe(10);
    });

    it('returns version number', async () => {
      const storage = createStorage();
      const state = new SharedState<number>(storage, 'wf-1', 'counter');

      const initial = await state.get(0);
      expect(initial.version).toBe(0);

      const { operations } = await state.update((current) => current + 1, 0);
      await storage.batch(operations);

      const afterUpdate = await state.get(0);
      expect(afterUpdate.version).toBe(1);
    });
  });

  describe('update', () => {
    it('modifies state', async () => {
      const storage = createStorage();
      const state = new SharedState<string>(storage, 'wf-1', 'name');

      const result = await state.update(() => 'Alice', '');

      expect(result.value).toBe('Alice');
    });

    it('returns batch operations (PUT data + PUT version)', async () => {
      const storage = createStorage();
      const state = new SharedState<number>(storage, 'wf-1', 'counter');

      const result = await state.update((current) => current + 1, 0);

      expect(result.operations).toHaveLength(2);

      const dataOperation = result.operations.find(
        (operation) =>
          operation.type === 'put' && operation.key === KEYS.sharedState('wf-1', 'counter'),
      );
      expect(dataOperation).toBeDefined();
      expect(dataOperation!.type).toBe('put');

      const versionOperation = result.operations.find(
        (operation) =>
          operation.type === 'put' && operation.key === KEYS.sharedStateVersion('wf-1', 'counter'),
      );
      expect(versionOperation).toBeDefined();
      expect(versionOperation!.type).toBe('put');
    });

    it('increments version', async () => {
      const storage = createStorage();
      const state = new SharedState<number>(storage, 'wf-1', 'counter');

      const result = await state.update((current) => current + 1, 0);

      expect(result.version).toBe(1);
    });

    it('receives current value in the update function', async () => {
      const storage = createStorage();
      const state = new SharedState<number>(storage, 'wf-1', 'counter');

      // Write an initial value
      const first = await state.update(() => 42, 0);
      await storage.batch(first.operations);

      // The update function should receive the current value (42)
      const second = await state.update((current) => current + 8, 0);

      expect(second.value).toBe(50);
    });
  });

  describe('sequential updates', () => {
    it('increments version correctly (0 -> 1 -> 2)', async () => {
      const storage = createStorage();
      const state = new SharedState<number>(storage, 'wf-1', 'counter');

      const first = await state.update((current) => current + 1, 0);
      expect(first.version).toBe(1);
      await storage.batch(first.operations);

      const second = await state.update((current) => current + 1, 0);
      expect(second.version).toBe(2);
      await storage.batch(second.operations);

      const result = await state.get(0);
      expect(result.value).toBe(2);
      expect(result.version).toBe(2);
    });
  });

  describe('initial version', () => {
    it('is 0', async () => {
      const storage = createStorage();
      const state = new SharedState<number>(storage, 'wf-1', 'counter');

      const result = await state.get(0);

      expect(result.version).toBe(0);
    });
  });

  describe('SharedStateConflictError', () => {
    it('is thrown after max retries', async () => {
      const storage = createStorage();
      const state = new SharedState<number>(storage, 'wf-1', 'counter', {
        maxRetries: 2,
      });

      // Write initial state so version starts at 1
      const initial = await state.update(() => 0, 0);
      await storage.batch(initial.operations);

      // Intercept storage.get so that every time the version key is read
      // during step 1, we bump the stored version afterward. This means
      // the verification read in step 3 always sees a newer version,
      // simulating a concurrent writer.
      const versionKey = KEYS.sharedStateVersion('wf-1', 'counter');
      const originalGet = storage.get.bind(storage);
      const originalPut = storage.put.bind(storage);
      let versionReadCount = 0;
      storage.get = async (key: string) => {
        const result = await originalGet(key);
        if (key === versionKey) {
          versionReadCount++;
          // On every first read of a pair (the initial read in step 1),
          // bump the version so the verification read (step 3) sees a mismatch.
          if (versionReadCount % 2 === 1) {
            const currentVersion = result ? (decode(result) as number) : 0;
            await originalPut(versionKey, encode(currentVersion + 1));
          }
        }
        return result;
      };

      await expect(state.update((current) => current + 1, 0)).rejects.toThrow(
        SharedStateConflictError,
      );
    });

    it('includes stateKey and attempts', () => {
      const error = new SharedStateConflictError('counter', 10);

      expect(error.stateKey).toBe('counter');
      expect(error.attempts).toBe(10);
      expect(error).toBeInstanceOf(Error);
      expect(error.message).toContain('counter');
      expect(error.message).toContain('10');
    });
  });

  describe('retry backoff', () => {
    function createConflictingStorage() {
      const storage = createStorage();
      const versionKey = KEYS.sharedStateVersion('wf-1', 'counter');
      const originalGet = storage.get.bind(storage);
      const originalPut = storage.put.bind(storage);
      let versionReadCount = 0;
      storage.get = async (key: string) => {
        const result = await originalGet(key);
        if (key === versionKey) {
          versionReadCount++;
          // On every first read of a pair (initial read in step 1), bump
          // the stored version so the verification read in step 3 sees a
          // mismatch, forcing a retry.
          if (versionReadCount % 2 === 1) {
            const currentVersion = result ? (decode(result) as number) : 0;
            await originalPut(versionKey, encode(currentVersion + 1));
          }
        }
        return result;
      };
      return storage;
    }

    it('sleeps between failed CAS attempts but not after the last one', async () => {
      const storage = createConflictingStorage();
      const sleepCalls: number[] = [];
      const sleep = (milliseconds: number): Promise<void> => {
        sleepCalls.push(milliseconds);
        return Promise.resolve();
      };

      const state = new SharedState<number>(storage, 'wf-1', 'counter', {
        maxRetries: 3,
        baseDelayMs: 10,
        maxDelayMs: 100,
        sleep,
      });

      await expect(state.update((current) => current + 1, 0)).rejects.toThrow(
        SharedStateConflictError,
      );

      // 3 retries = 3 failed attempts. We sleep between attempts, so we
      // expect exactly 2 sleeps: between attempt 0/1 and 1/2. No sleep
      // after the final failed attempt.
      expect(sleepCalls).toHaveLength(2);
    });

    it('uses exponential backoff bounded by maxDelayMs', async () => {
      const storage = createConflictingStorage();
      const sleepCalls: number[] = [];
      const sleep = (milliseconds: number): Promise<void> => {
        sleepCalls.push(milliseconds);
        return Promise.resolve();
      };

      const state = new SharedState<number>(storage, 'wf-1', 'counter', {
        maxRetries: 6,
        baseDelayMs: 10,
        maxDelayMs: 50,
        sleep,
      });

      await expect(state.update((current) => current + 1, 0)).rejects.toThrow(
        SharedStateConflictError,
      );

      // 6 attempts -> 5 sleeps between them.
      expect(sleepCalls).toHaveLength(5);

      // Jittered delay is floor(random * exponential) where exponential =
      // min(maxDelayMs, baseDelayMs * 2^attempt). Each sleep duration
      // must fall within [0, exponential).
      const exponentials = [10, 20, 40, 50, 50];
      sleepCalls.forEach((duration, index) => {
        expect(duration).toBeGreaterThanOrEqual(0);
        expect(duration).toBeLessThan(exponentials[index]!);
      });
    });

    it('does not sleep on a successful first attempt', async () => {
      const storage = createStorage();
      const sleepCalls: number[] = [];
      const sleep = (milliseconds: number): Promise<void> => {
        sleepCalls.push(milliseconds);
        return Promise.resolve();
      };

      const state = new SharedState<number>(storage, 'wf-1', 'counter', {
        sleep,
      });

      const result = await state.update((current) => current + 1, 0);

      expect(result.value).toBe(1);
      expect(sleepCalls).toHaveLength(0);
    });
  });
});
