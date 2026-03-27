import { afterEach, beforeEach, describe, expect, it } from 'bun:test';

import { MemoryStorage } from '../storage/memory';
import { calculateBackoff, parseDuration, Scheduler } from './scheduler';
import type { TimerEntry } from './types';

// ---------------------------------------------------------------------------
// parseDuration
// ---------------------------------------------------------------------------

describe('parseDuration', () => {
  it('passes through a numeric value as milliseconds', () => {
    expect(parseDuration(5000)).toBe(5000);
  });

  it('parses "30 seconds" to 30000', () => {
    expect(parseDuration('30 seconds')).toBe(30000);
  });

  it('parses "30s" to 30000', () => {
    expect(parseDuration('30s')).toBe(30000);
  });

  it('parses "1 hour" to 3600000', () => {
    expect(parseDuration('1 hour')).toBe(3600000);
  });

  it('parses "24 hours" to 86400000', () => {
    expect(parseDuration('24 hours')).toBe(86400000);
  });

  it('parses "7 days" to 604800000', () => {
    expect(parseDuration('7 days')).toBe(604800000);
  });

  it('parses "500ms" to 500', () => {
    expect(parseDuration('500ms')).toBe(500);
  });

  it('parses "500 milliseconds" to 500', () => {
    expect(parseDuration('500 milliseconds')).toBe(500);
  });

  it('parses "2.5 minutes" to 150000', () => {
    expect(parseDuration('2.5 minutes')).toBe(150000);
  });

  it('parses singular "1 second" to 1000', () => {
    expect(parseDuration('1 second')).toBe(1000);
  });

  it('parses singular "1 minute" to 60000', () => {
    expect(parseDuration('1 minute')).toBe(60000);
  });

  it('parses singular "1 day" to 86400000', () => {
    expect(parseDuration('1 day')).toBe(86400000);
  });

  it('returns 0 for numeric 0', () => {
    expect(parseDuration(0)).toBe(0);
  });

  it('throws for an unparseable string', () => {
    expect(() => parseDuration('invalid')).toThrow();
  });
});

// ---------------------------------------------------------------------------
// calculateBackoff
// ---------------------------------------------------------------------------

describe('calculateBackoff', () => {
  it('returns initialBackoff for attempt 1', () => {
    const result = calculateBackoff(1, {
      maxAttempts: 5,
      initialBackoff: 1000,
      backoffMultiplier: 2,
      maxBackoff: 30000,
    });
    expect(result).toBe(1000);
  });

  it('returns initialBackoff * multiplier for attempt 2', () => {
    const result = calculateBackoff(2, {
      maxAttempts: 5,
      initialBackoff: 1000,
      backoffMultiplier: 2,
      maxBackoff: 30000,
    });
    expect(result).toBe(2000);
  });

  it('returns initialBackoff * multiplier^2 for attempt 3', () => {
    const result = calculateBackoff(3, {
      maxAttempts: 5,
      initialBackoff: 1000,
      backoffMultiplier: 2,
      maxBackoff: 30000,
    });
    expect(result).toBe(4000);
  });

  it('caps the result at maxBackoff', () => {
    const result = calculateBackoff(10, {
      maxAttempts: 15,
      initialBackoff: 1000,
      backoffMultiplier: 2,
      maxBackoff: 30000,
    });
    expect(result).toBe(30000);
  });

  it('works with string durations in the policy', () => {
    const result = calculateBackoff(1, {
      maxAttempts: 5,
      initialBackoff: '2 seconds',
      backoffMultiplier: 2,
      maxBackoff: '1 minute',
    });
    expect(result).toBe(2000);
  });
});

// ---------------------------------------------------------------------------
// Scheduler
// ---------------------------------------------------------------------------

describe('Scheduler', () => {
  let storage: MemoryStorage;
  let firedEntries: TimerEntry[];
  let scheduler: Scheduler;
  let currentTime: number;

  beforeEach(() => {
    storage = new MemoryStorage();
    firedEntries = [];
    currentTime = 1000000;

    scheduler = new Scheduler({
      storage,
      onTimerFired: (entry) => {
        firedEntries.push(entry);
      },
      pollIntervalMs: 100,
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

  it('writes a timer entry to storage on schedule', async () => {
    const entry = makeTimer();
    await scheduler.schedule(entry);

    // Verify something was written to storage
    const keys = storage.keys();
    expect(keys.some((key) => key.startsWith('wf-deadline:'))).toBe(true);

    // Verify the index key was also written
    expect(keys.some((key) => key.startsWith('timer-idx:'))).toBe(true);
  });

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
    // Chronological order: entry1 (-3000), entry3 (-2000), entry2 (-1000)
    expect(firedEntries[0]!.id).toBe('timer-1');
    expect(firedEntries[1]!.id).toBe('timer-3');
    expect(firedEntries[2]!.id).toBe('timer-2');
  });

  it('cancel is a no-op for a timer that was never scheduled', async () => {
    await scheduler.cancel('nonexistent-timer', 'some-workflow');
    // Should not throw and no entries should fire
    await scheduler.tick(currentTime);
    expect(firedEntries).toHaveLength(0);
  });

  it('start is idempotent (calling start twice does not create duplicate intervals)', async () => {
    scheduler.start();
    scheduler.start(); // second call should be a no-op
    scheduler.stop();
    // No assertion needed -- just verifying it doesn't throw or create duplicate intervals
  });

  it('cancel prevents a timer from firing', async () => {
    const entry = makeTimer({ fireAt: currentTime - 1000 });
    await scheduler.schedule(entry);
    await scheduler.cancel(entry.id, entry.workflowId);

    await scheduler.tick(currentTime);

    expect(firedEntries).toHaveLength(0);
  });

  it('Symbol.dispose stops the polling interval', async () => {
    scheduler.start();
    scheduler[Symbol.dispose]();

    // Schedule a timer that would fire
    const entry = makeTimer({ fireAt: currentTime - 1000 });
    await scheduler.schedule(entry);

    // Wait for what would be a poll cycle
    await Bun.sleep(200);

    expect(firedEntries).toHaveLength(0);
  });

  it('flush processes expired timers then stops', async () => {
    const entry = makeTimer({ fireAt: currentTime - 1000 });
    await scheduler.schedule(entry);

    await scheduler.flush(currentTime);

    expect(firedEntries).toHaveLength(1);
    expect(firedEntries[0]!.id).toBe('timer-1');
  });

  it('does not fire after dispose', async () => {
    scheduler.start();

    const entry = makeTimer({ fireAt: currentTime - 1000 });
    await scheduler.schedule(entry);

    scheduler[Symbol.dispose]();

    // Wait for what would be a poll cycle
    await Bun.sleep(200);

    expect(firedEntries).toHaveLength(0);
  });

  it('tick uses getNow when no argument is provided', async () => {
    const entry = makeTimer({ fireAt: currentTime - 1000 });
    await scheduler.schedule(entry);

    // Call tick() without an argument; should use getNow()
    await scheduler.tick();

    expect(firedEntries).toHaveLength(1);
    expect(firedEntries[0]!.id).toBe('timer-1');
  });

  it('polling loop fires expired timers automatically', async () => {
    // Use a very short poll interval so the interval actually fires
    scheduler[Symbol.dispose]();
    scheduler = new Scheduler({
      storage,
      onTimerFired: (entry) => {
        firedEntries.push(entry);
      },
      pollIntervalMs: 20,
      getNow: () => currentTime,
    });

    const entry = makeTimer({ fireAt: currentTime - 1000 });
    await scheduler.schedule(entry);

    scheduler.start();

    // Wait for the poll cycle to fire
    await Bun.sleep(100);

    expect(firedEntries).toHaveLength(1);
    expect(firedEntries[0]!.id).toBe('timer-1');

    scheduler.stop();
  });

  it('continues processing remaining timers when a callback throws on one', async () => {
    let callCount = 0;
    scheduler[Symbol.dispose]();
    scheduler = new Scheduler({
      storage,
      onTimerFired: (entry) => {
        callCount++;
        firedEntries.push(entry);
        if (callCount === 1) {
          throw new Error('callback error on first timer');
        }
      },
      pollIntervalMs: 100,
      getNow: () => currentTime,
    });

    const entry1 = makeTimer({ id: 'timer-throw', fireAt: currentTime - 2000 });
    const entry2 = makeTimer({ id: 'timer-ok', fireAt: currentTime - 1000 });

    await scheduler.schedule(entry1);
    await scheduler.schedule(entry2);

    await scheduler.tick(currentTime);

    // Both callbacks were invoked despite the first one throwing
    expect(firedEntries).toHaveLength(2);
    expect(firedEntries[0]!.id).toBe('timer-throw');
    expect(firedEntries[1]!.id).toBe('timer-ok');

    // Both deadline keys and index keys were cleaned up
    const remainingKeys = storage.keys();
    expect(remainingKeys.some((key) => key.startsWith('wf-deadline:'))).toBe(false);
    expect(remainingKeys.some((key) => key.startsWith('timer-idx:'))).toBe(false);
  });

  it('tick is a no-op after stop, preventing callbacks on disposed scheduler', async () => {
    const entry = makeTimer({ fireAt: currentTime - 1000 });
    await scheduler.schedule(entry);

    scheduler.stop();

    // Calling tick after stop should not fire any callbacks
    await scheduler.tick(currentTime);

    expect(firedEntries).toHaveLength(0);
  });

  it('start resets the stopped flag so tick works again', async () => {
    const entry = makeTimer({ fireAt: currentTime - 1000 });
    await scheduler.schedule(entry);

    scheduler.stop();
    await scheduler.tick(currentTime);
    expect(firedEntries).toHaveLength(0);

    // Restart and verify tick works again
    scheduler.start();
    await scheduler.tick(currentTime);
    expect(firedEntries).toHaveLength(1);
    expect(firedEntries[0]!.id).toBe('timer-1');

    scheduler.stop();
  });

  it('flush works after stop (drains remaining timers)', async () => {
    const entry = makeTimer({ fireAt: currentTime - 1000 });
    await scheduler.schedule(entry);

    // Stop the scheduler (halts the polling loop)
    scheduler.stop();

    // flush() should still process expired timers despite stop() having been called
    await scheduler.flush(currentTime);

    expect(firedEntries).toHaveLength(1);
    expect(firedEntries[0]!.id).toBe('timer-1');
  });

  it('tick terminates early when stop is called during callback processing', async () => {
    // Create a scheduler where the first callback calls stop()
    scheduler[Symbol.dispose]();

    const fired: string[] = [];
    scheduler = new Scheduler({
      storage,
      onTimerFired: (entry) => {
        fired.push(entry.id);
        if (entry.id === 'timer-a') {
          // Calling stop() mid-tick should prevent subsequent callbacks
          scheduler.stop();
        }
      },
      pollIntervalMs: 100,
      getNow: () => currentTime,
    });

    const entryA = makeTimer({ id: 'timer-a', fireAt: currentTime - 2000 });
    const entryB = makeTimer({ id: 'timer-b', fireAt: currentTime - 1000 });

    await scheduler.schedule(entryA);
    await scheduler.schedule(entryB);

    await scheduler.tick(currentTime);

    // Only timer-a should have fired; timer-b should be skipped because
    // stop() was called during the first callback
    expect(fired).toEqual(['timer-a']);
  });

  it('full integration: schedule, advance time via tick, verify fired', async () => {
    const entry = makeTimer({ fireAt: currentTime + 5000 });
    await scheduler.schedule(entry);

    // Timer should not fire yet
    await scheduler.tick(currentTime);
    expect(firedEntries).toHaveLength(0);

    // Advance time past the timer's fireAt
    currentTime += 6000;
    await scheduler.tick(currentTime);

    expect(firedEntries).toHaveLength(1);
    expect(firedEntries[0]!.id).toBe('timer-1');
    expect(firedEntries[0]!.workflowId).toBe('workflow-1');

    // Verify the timer was cleaned up from storage (deadline key removed)
    const deadlineKeys = storage.keys().filter((key) => key.startsWith('wf-deadline:'));
    expect(deadlineKeys).toHaveLength(0);
  });
});
