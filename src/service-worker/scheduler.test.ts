import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';

import type { TimerEntry } from '../core/types';
import type { Storage } from '../storage/interface';
import { MemoryStorage } from '../storage/memory';
import { ServiceWorkerScheduler } from './scheduler';

describe('ServiceWorkerScheduler', () => {
  let storage: MemoryStorage;
  let firedEntries: TimerEntry[];
  let scheduler: ServiceWorkerScheduler;
  let currentTime: number;

  beforeEach(() => {
    storage = new MemoryStorage();
    firedEntries = [];
    currentTime = 1000000;

    scheduler = new ServiceWorkerScheduler({
      storage,
      onTimerFired: (entry) => {
        firedEntries.push(entry);
      },
      getNow: () => currentTime,
    });
  });

  afterEach(() => {
    scheduler[Symbol.dispose]();
  });

  function makeTimer(overrides: Partial<TimerEntry> = {}): TimerEntry {
    return {
      id: 'timer-1',
      workflowId: 'workflow-1',
      fireAt: currentTime + 5000,
      kind: 'sleep',
      ...overrides,
    };
  }

  async function collectStorageKeys(): Promise<string[]> {
    const keys: string[] = [];
    for await (const key of storage.keys('')) {
      keys.push(key);
    }
    return keys;
  }

  // -------------------------------------------------------------------------
  // schedule()
  // -------------------------------------------------------------------------

  it('writes a timer entry to storage on schedule', async () => {
    const entry = makeTimer();
    await scheduler.schedule(entry);

    const keys = await collectStorageKeys();
    expect(keys.some((key) => key.startsWith('wf-deadline:'))).toBe(true);
    expect(keys.some((key) => key.startsWith('timer-idx:'))).toBe(true);
  });

  it('writes the correct deadline key format', async () => {
    const entry = makeTimer({ fireAt: 1005000 });
    await scheduler.schedule(entry);

    const keys = await collectStorageKeys();
    const deadlineKey = keys.find((key) => key.startsWith('wf-deadline:'));
    expect(deadlineKey).toBe('wf-deadline:0000000001005000:timer-1');
  });

  // -------------------------------------------------------------------------
  // cancel()
  // -------------------------------------------------------------------------

  it('cancel removes both deadline and index keys', async () => {
    const entry = makeTimer({ fireAt: currentTime - 1000 });
    await scheduler.schedule(entry);

    await scheduler.cancel(entry.id);

    const keys = await collectStorageKeys();
    expect(keys.some((key) => key.startsWith('wf-deadline:'))).toBe(false);
    expect(keys.some((key) => key.startsWith('timer-idx:'))).toBe(false);
  });

  it('cancel is a no-op for a timer that was never scheduled', async () => {
    await scheduler.cancel('nonexistent-timer');
    await scheduler.tick(currentTime);
    expect(firedEntries).toHaveLength(0);
  });

  it('cancel prevents a timer from firing', async () => {
    const entry = makeTimer({ fireAt: currentTime - 1000 });
    await scheduler.schedule(entry);
    await scheduler.cancel(entry.id);

    await scheduler.tick(currentTime);

    expect(firedEntries).toHaveLength(0);
  });

  // -------------------------------------------------------------------------
  // tick()
  // -------------------------------------------------------------------------

  it('fires callback for expired timers when tick is called', async () => {
    const entry = makeTimer({ fireAt: currentTime - 1000 });
    await scheduler.schedule(entry);

    await scheduler.tick(currentTime);

    expect(firedEntries).toHaveLength(1);
    expect(firedEntries[0]!.id).toBe('timer-1');
  });

  it('does NOT fire callback for future timers', async () => {
    const entry = makeTimer({ fireAt: currentTime + 5000 });
    await scheduler.schedule(entry);

    await scheduler.tick(currentTime);

    expect(firedEntries).toHaveLength(0);
  });

  it('fires all expired timers in chronological order', async () => {
    const entry1 = makeTimer({ id: 'timer-1', fireAt: currentTime - 3000 });
    const entry2 = makeTimer({ id: 'timer-2', fireAt: currentTime - 1000 });
    const entry3 = makeTimer({ id: 'timer-3', fireAt: currentTime - 2000 });

    await scheduler.schedule(entry1);
    await scheduler.schedule(entry2);
    await scheduler.schedule(entry3);

    await scheduler.tick(currentTime);

    expect(firedEntries).toHaveLength(3);
    expect(firedEntries[0]!.id).toBe('timer-1');
    expect(firedEntries[1]!.id).toBe('timer-3');
    expect(firedEntries[2]!.id).toBe('timer-2');
  });

  it('tick cleans up deadline and index keys after firing', async () => {
    const entry = makeTimer({ fireAt: currentTime - 1000 });
    await scheduler.schedule(entry);

    await scheduler.tick(currentTime);

    const keys = await collectStorageKeys();
    const deadlineKeys = keys.filter((key) => key.startsWith('wf-deadline:'));
    const indexKeys = keys.filter((key) => key.startsWith('timer-idx:'));
    expect(deadlineKeys).toHaveLength(0);
    expect(indexKeys).toHaveLength(0);
  });

  it('tick uses getNow when no argument is provided', async () => {
    const entry = makeTimer({ fireAt: currentTime - 1000 });
    await scheduler.schedule(entry);

    await scheduler.tick();

    expect(firedEntries).toHaveLength(1);
    expect(firedEntries[0]!.id).toBe('timer-1');
  });

  // -------------------------------------------------------------------------
  // flush()
  // -------------------------------------------------------------------------

  it('flush processes expired timers then stops', async () => {
    const entry = makeTimer({ fireAt: currentTime - 1000 });
    await scheduler.schedule(entry);

    scheduler.start();
    await scheduler.flush(currentTime);

    expect(firedEntries).toHaveLength(1);
    expect(firedEntries[0]!.id).toBe('timer-1');

    // After flush, adding another expired timer and waiting should not fire it
    // because the scheduler has been stopped.
    const entry2 = makeTimer({ id: 'timer-2', fireAt: currentTime - 500 });
    await scheduler.schedule(entry2);
    await Bun.sleep(200);
    expect(firedEntries).toHaveLength(1);
  });

  // -------------------------------------------------------------------------
  // start() with periodic sync
  // -------------------------------------------------------------------------

  it('start registers periodic sync when registration.periodicSync is available', async () => {
    const registerMock = mock(() => Promise.resolve());
    const registration = {
      periodicSync: {
        register: registerMock,
      },
    } as unknown as ServiceWorkerRegistration;

    scheduler[Symbol.dispose]();
    scheduler = new ServiceWorkerScheduler({
      storage,
      onTimerFired: (entry) => {
        firedEntries.push(entry);
      },
      registration,
      periodicSyncTag: 'custom-tag',
      getNow: () => currentTime,
    });

    scheduler.start();

    expect(registerMock).toHaveBeenCalledTimes(1);
    expect(registerMock).toHaveBeenCalledWith('custom-tag', { minInterval: 60000 });
  });

  it('start falls back to polling when periodic sync registration fails', async () => {
    const registerMock = mock(() => Promise.reject(new Error('Not allowed')));
    const registration = {
      periodicSync: {
        register: registerMock,
      },
    } as unknown as ServiceWorkerRegistration;

    scheduler[Symbol.dispose]();
    scheduler = new ServiceWorkerScheduler({
      storage,
      onTimerFired: (entry) => {
        firedEntries.push(entry);
      },
      registration,
      fallbackIntervalMilliseconds: 50,
      getNow: () => currentTime,
    });

    const entry = makeTimer({ fireAt: currentTime - 1000 });
    await scheduler.schedule(entry);

    scheduler.start();

    // Allow microtask for the .catch() to run plus setTimeout polling
    await Bun.sleep(300);

    expect(registerMock).toHaveBeenCalledTimes(1);
    expect(firedEntries.length).toBeGreaterThanOrEqual(1);
    expect(firedEntries[0]!.id).toBe('timer-1');

    scheduler.stop();
  });

  it('start uses default periodic sync tag when none is provided', async () => {
    const registerMock = mock(() => Promise.resolve());
    const registration = {
      periodicSync: {
        register: registerMock,
      },
    } as unknown as ServiceWorkerRegistration;

    scheduler[Symbol.dispose]();
    scheduler = new ServiceWorkerScheduler({
      storage,
      onTimerFired: (entry) => {
        firedEntries.push(entry);
      },
      registration,
      getNow: () => currentTime,
    });

    scheduler.start();

    expect(registerMock).toHaveBeenCalledWith('weft-timers', { minInterval: 60000 });
  });

  // -------------------------------------------------------------------------
  // start() fallback to setTimeout
  // -------------------------------------------------------------------------

  it('start falls back to setTimeout when periodicSync is not available', async () => {
    scheduler[Symbol.dispose]();
    scheduler = new ServiceWorkerScheduler({
      storage,
      onTimerFired: (entry) => {
        firedEntries.push(entry);
      },
      fallbackIntervalMilliseconds: 50,
      getNow: () => currentTime,
    });

    const entry = makeTimer({ fireAt: currentTime - 1000 });
    await scheduler.schedule(entry);

    scheduler.start();

    await Bun.sleep(200);

    expect(firedEntries.length).toBeGreaterThanOrEqual(1);
    expect(firedEntries[0]!.id).toBe('timer-1');

    scheduler.stop();
  });

  it('polling loop continues after a tick error', async () => {
    let tickCount = 0;

    scheduler[Symbol.dispose]();
    scheduler = new ServiceWorkerScheduler({
      storage,
      onTimerFired: () => {
        tickCount++;
        if (tickCount === 1) {
          throw new Error('Simulated tick failure');
        }
      },
      fallbackIntervalMilliseconds: 50,
      getNow: () => currentTime,
    });

    // Schedule two timers that are already expired
    const entry1 = makeTimer({ id: 'timer-a', fireAt: currentTime - 2000 });
    const entry2 = makeTimer({ id: 'timer-b', fireAt: currentTime - 1000 });
    await scheduler.schedule(entry1);
    await scheduler.schedule(entry2);

    scheduler.start();

    // Wait long enough for multiple poll cycles
    await Bun.sleep(400);

    // The first tick processes timer-a (callback throws, caught by try/catch
    // in tick) then continues to timer-b. The .finally() in #schedulePoll
    // ensures subsequent poll cycles also run. tickCount >= 2 confirms both
    // timers were processed despite the error.
    expect(tickCount).toBeGreaterThanOrEqual(2);

    scheduler.stop();
  });

  it('start is idempotent (calling start twice does not create duplicate polling)', () => {
    scheduler.start();
    scheduler.start(); // second call should be a no-op
    scheduler.stop();
    // No assertion needed -- just verifying it does not throw or create duplicate polling
  });

  // -------------------------------------------------------------------------
  // stop()
  // -------------------------------------------------------------------------

  it('stop clears timeout handles', async () => {
    scheduler[Symbol.dispose]();
    scheduler = new ServiceWorkerScheduler({
      storage,
      onTimerFired: (entry) => {
        firedEntries.push(entry);
      },
      fallbackIntervalMilliseconds: 50,
      getNow: () => currentTime,
    });

    scheduler.start();
    scheduler.stop();

    const entry = makeTimer({ fireAt: currentTime - 1000 });
    await scheduler.schedule(entry);

    await Bun.sleep(200);

    expect(firedEntries).toHaveLength(0);
  });

  it('stop is idempotent', () => {
    scheduler.stop();
    scheduler.stop();
    // Should not throw
  });

  // -------------------------------------------------------------------------
  // Symbol.dispose
  // -------------------------------------------------------------------------

  it('[Symbol.dispose]() calls stop', async () => {
    scheduler[Symbol.dispose]();
    scheduler = new ServiceWorkerScheduler({
      storage,
      onTimerFired: (entry) => {
        firedEntries.push(entry);
      },
      fallbackIntervalMilliseconds: 50,
      getNow: () => currentTime,
    });

    scheduler.start();
    scheduler[Symbol.dispose]();

    const entry = makeTimer({ fireAt: currentTime - 1000 });
    await scheduler.schedule(entry);

    await Bun.sleep(200);

    expect(firedEntries).toHaveLength(0);
  });

  // -------------------------------------------------------------------------
  // Integration
  // -------------------------------------------------------------------------

  it('full integration: schedule, advance time via tick, verify fired', async () => {
    const entry = makeTimer({ fireAt: currentTime + 5000 });
    await scheduler.schedule(entry);

    await scheduler.tick(currentTime);
    expect(firedEntries).toHaveLength(0);

    currentTime += 6000;
    await scheduler.tick(currentTime);

    expect(firedEntries).toHaveLength(1);
    expect(firedEntries[0]!.id).toBe('timer-1');
    expect(firedEntries[0]!.workflowId).toBe('workflow-1');

    const keys = await collectStorageKeys();
    const deadlineKeys = keys.filter((key) => key.startsWith('wf-deadline:'));
    expect(deadlineKeys).toHaveLength(0);
  });

  it('start with registration but no periodicSync falls back to setTimeout', async () => {
    const registration = {} as unknown as ServiceWorkerRegistration;

    scheduler[Symbol.dispose]();
    scheduler = new ServiceWorkerScheduler({
      storage,
      onTimerFired: (entry) => {
        firedEntries.push(entry);
      },
      registration,
      fallbackIntervalMilliseconds: 50,
      getNow: () => currentTime,
    });

    const entry = makeTimer({ fireAt: currentTime - 1000 });
    await scheduler.schedule(entry);

    scheduler.start();

    await Bun.sleep(200);

    expect(firedEntries.length).toBeGreaterThanOrEqual(1);

    scheduler.stop();
  });

  it('uses default fallback interval when not specified', async () => {
    scheduler[Symbol.dispose]();
    scheduler = new ServiceWorkerScheduler({
      storage,
      onTimerFired: (entry) => {
        firedEntries.push(entry);
      },
      getNow: () => currentTime,
    });

    // Just verify it does not throw when starting without fallbackIntervalMilliseconds
    scheduler.start();
    scheduler.stop();
  });

  it('handles async onTimerFired callbacks', async () => {
    const asyncFired: TimerEntry[] = [];
    scheduler[Symbol.dispose]();
    scheduler = new ServiceWorkerScheduler({
      storage,
      onTimerFired: async (entry) => {
        await Bun.sleep(1);
        asyncFired.push(entry);
      },
      getNow: () => currentTime,
    });

    const entry = makeTimer({ fireAt: currentTime - 1000 });
    await scheduler.schedule(entry);

    await scheduler.tick(currentTime);

    expect(asyncFired).toHaveLength(1);
    expect(asyncFired[0]!.id).toBe('timer-1');
  });

  it('logs polling errors when the scheduled tick throws', async () => {
    const errorSpy = mock((_message?: unknown, ..._args: unknown[]) => {});
    const originalError = console.error;
    console.error = errorSpy as typeof console.error;

    scheduler[Symbol.dispose]();
    scheduler = new ServiceWorkerScheduler({
      storage,
      onTimerFired: () => {
        throw new Error('tick failed');
      },
      fallbackIntervalMilliseconds: 20,
      getNow: () => currentTime,
    });

    try {
      await scheduler.schedule(makeTimer({ fireAt: currentTime - 1000 }));
      scheduler.start();
      await Bun.sleep(80);

      expect(errorSpy).toHaveBeenCalled();
    } finally {
      console.error = originalError;
      scheduler.stop();
    }
  });

  it('logs polling errors when storage scanning rejects during the timer loop', async () => {
    const realStorage = new MemoryStorage();
    const errorSpy = mock((_message?: unknown, ..._args: unknown[]) => {});
    const originalError = console.error;
    console.error = errorSpy as typeof console.error;

    const failingStorage: Storage = {
      get: realStorage.get.bind(realStorage),
      put: realStorage.put.bind(realStorage),
      delete: realStorage.delete.bind(realStorage),
      batch: realStorage.batch.bind(realStorage),
      async *scan() {
        throw new Error('scan failed');
      },
      [Symbol.dispose]() {
        realStorage[Symbol.dispose]();
      },
    };

    scheduler[Symbol.dispose]();
    scheduler = new ServiceWorkerScheduler({
      storage: failingStorage,
      onTimerFired: () => undefined,
      fallbackIntervalMilliseconds: 20,
      getNow: () => currentTime,
    });

    try {
      scheduler.start();
      await Bun.sleep(80);

      expect(errorSpy).toHaveBeenCalledWith(
        '[weft] ServiceWorkerScheduler tick failed:',
        expect.any(Error),
      );
    } finally {
      console.error = originalError;
      scheduler.stop();
    }
  });
});
