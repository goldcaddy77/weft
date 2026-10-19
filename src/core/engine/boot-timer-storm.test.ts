/**
 * HAPS-687: a restart with thousands of runs parked on overdue durable sleeps
 * must not turn into a timer storm while boot recovery adopts them.
 *
 * Before the fix, every scheduler tick fired up to 1,000 overdue sleep timers
 * whose runs recovery had not adopted yet; each callback threw "fired before
 * workflow ... ready", was logged with a full stack, and was retried on the
 * next tick. Production logged ~300,000 such stacks over ten minutes after one
 * boot. These tests pin the replacement behavior at both layers.
 */
import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test';

import { MemoryStorage } from '../../storage/memory.ts';
import { Engine } from '../engine.ts';
import { Scheduler } from '../scheduler.ts';
import { TimerDeferredError } from '../scheduler/timer-deferral.ts';
import type { TimerEntry } from '../types.ts';
import { activity, workflow } from '../types.ts';

// Production restarts adopt 2,800 to 4,000 parked runs. The scheduler test uses
// that scale directly; the engine test uses 1,000 runs (one full scheduler scan
// budget) to keep its wall time reasonable while still exceeding one tick.
const RUN_COUNT = 3_000;
const ENGINE_RUN_COUNT = 1_000;
const POLL_INTERVAL_MS = 1_000;

type ConsoleSpy = ReturnType<typeof spyOn>;

function loggedLines(spy: ConsoleSpy): unknown[][] {
  return spy.mock.calls as unknown[][];
}

/** A log call carries a stack when any argument is an Error or a stack-shaped string. */
function carriesStack(call: unknown[]): boolean {
  return call.some(
    (argument) =>
      argument instanceof Error || (typeof argument === 'string' && /\n\s+at /.test(argument)),
  );
}

/** Slows reads of workflow state so recovery adopts the backlog gradually. */
class SlowRecoveryStorage extends MemoryStorage {
  #workflowReads = 0;

  override async get(key: string): Promise<Uint8Array | null> {
    // Yield a macrotask every few workflow-state reads so scheduler ticks
    // interleave with recovery instead of running only before or after it.
    if (key.startsWith('wf:') && (this.#workflowReads += 1) % 8 === 0) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    return super.get(key);
  }
}

async function countSleepTimerRows(storage: MemoryStorage): Promise<number> {
  let count = 0;
  for await (const _entry of storage.scan('timer-idx:sleep:')) count += 1;
  return count;
}

describe('boot timer storm (HAPS-687)', () => {
  let errorSpy: ConsoleSpy;
  let warnSpy: ConsoleSpy;

  beforeEach(() => {
    errorSpy = spyOn(console, 'error').mockImplementation(() => {});
    warnSpy = spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    errorSpy.mockRestore();
    warnSpy.mockRestore();
  });

  it('a restart with thousands of overdue sleepers does not re-fire timers during slow recovery', async () => {
    const storage = new SlowRecoveryStorage();
    let now = 1_000_000;
    const wakes = new Map<string, number>();
    const recordWake = activity({
      name: 'record-wake',
      execute: async (workflowId: string) => {
        wakes.set(workflowId, (wakes.get(workflowId) ?? 0) + 1);
        return workflowId;
      },
    });
    const gate = workflow({ name: 'parked-gate' }).execute(async function* (
      ctx,
      workflowId: string,
    ) {
      yield* ctx.sleep(60_000);
      return yield* ctx.run(recordWake, workflowId);
    });

    const firstEngine = new Engine({ storage, getNow: () => now });
    firstEngine.register(gate);
    const workflowIds = Array.from({ length: ENGINE_RUN_COUNT }, (_, index) => `gate-${index}`);
    for (const id of workflowIds) await firstEngine.start('parked-gate', id, { id });
    // Every run must be parked on its durable sleep before the "crash".
    while ((await countSleepTimerRows(storage)) < ENGINE_RUN_COUNT) await Bun.sleep(5);
    await firstEngine[Symbol.asyncDispose]();

    // Restart well past every deadline, Haps-style: the scheduler is live before
    // recovery runs, and recovery is slow.
    now += 10 * 60_000;
    const engine = new Engine({ storage, getNow: () => now });
    engine.register(gate);
    try {
      // Several ticks before recovery starts at all.
      for (let tick = 0; tick < 5; tick += 1) {
        now += POLL_INTERVAL_MS;
        await engine.scheduler.tick(now);
      }

      // Each overdue timer was handled exactly once and dropped: no row is left
      // to re-fire, and nothing woke before adoption.
      expect(await countSleepTimerRows(storage)).toBe(0);
      expect(wakes.size).toBe(0);

      // Keep ticking while recovery adopts the backlog.
      let recovered = false;
      const recovery = engine.recoverAll().finally(() => {
        recovered = true;
      });
      let ticksDuringRecovery = 0;
      while (!recovered) {
        ticksDuringRecovery += 1;
        now += POLL_INTERVAL_MS;
        await engine.scheduler.tick(now);
        await Bun.sleep(1);
      }
      const handles = await recovery;
      expect(ticksDuringRecovery).toBeGreaterThan(1);
      expect(handles).toHaveLength(ENGINE_RUN_COUNT);
      await Promise.all(handles.map((handle) => handle.result()));

      // Every run woke exactly once, after adoption.
      expect(wakes.size).toBe(ENGINE_RUN_COUNT);
      for (const id of workflowIds) expect(wakes.get(id)).toBe(1);
      expect(await countSleepTimerRows(storage)).toBe(0);

      // No storm: no failed-callback lines, at most one line per timer, no stack.
      const lines = [...loggedLines(errorSpy), ...loggedLines(warnSpy)];
      const timerLines = lines.filter((call) => String(call[0]).includes('sleep:'));
      expect(timerLines.length).toBeLessThanOrEqual(ENGINE_RUN_COUNT);
      expect(lines.filter((call) => String(call[0]).includes('Timer callback failed'))).toEqual([]);
      expect(lines.filter(carriesStack)).toEqual([]);
    } finally {
      await engine[Symbol.asyncDispose]();
    }
  }, 60_000);

  it('the scheduler backs off deferred timers, logs one stackless line each, and fires each once when ready', async () => {
    const storage = new MemoryStorage();
    let now = 1_000_000;
    const adopted = new Set<string>();
    const attempts = new Map<string, number>();
    const fired = new Map<string, number>();
    const scheduler: Scheduler = new Scheduler({
      storage,
      pollIntervalMs: POLL_INTERVAL_MS,
      getNow: () => now,
      onTimerFired: (entry: TimerEntry) => {
        attempts.set(entry.id, (attempts.get(entry.id) ?? 0) + 1);
        if (!adopted.has(entry.workflowId)) {
          throw new TimerDeferredError(`run ${entry.workflowId} not ready`);
        }
        fired.set(entry.id, (fired.get(entry.id) ?? 0) + 1);
      },
    });

    const entries: TimerEntry[] = Array.from({ length: RUN_COUNT }, (_, index) => ({
      id: `sleep:run-${index}:0`,
      workflowId: `run-${index}`,
      fireAt: now - 60_000 + index,
      kind: 'sleep',
    }));
    for (const entry of entries) await scheduler.schedule(entry);

    // Adopt slowly and in reverse key order, so the not-yet-adopted head of
    // the keyspace would starve the adopted tail if deferrals ate the scan budget.
    const adoptionOrder = [...entries].reverse();
    let tick = 0;
    while (fired.size < RUN_COUNT) {
      tick += 1;
      expect(tick).toBeLessThan(200);
      for (const entry of adoptionOrder.splice(0, 100)) {
        adopted.add(entry.workflowId);
        scheduler.releaseDeferredTimer(entry.id);
      }
      now += POLL_INTERVAL_MS;
      await scheduler.tick(now);
    }

    for (const entry of entries) expect(fired.get(entry.id)).toBe(1);
    // Backoff, not a hot retry: with 30 ticks of adoption, an unbacked-off
    // scheduler would have re-fired the last-adopted timers ~30 times each.
    const maxAttempts = Math.max(...attempts.values());
    expect(maxAttempts).toBeLessThanOrEqual(8);
    expect(await storage.get(`timer-idx:${entries[0]!.id}`)).toBeNull();

    const warnLines = loggedLines(warnSpy);
    expect(warnLines.length).toBeLessThanOrEqual(RUN_COUNT);
    const linesPerTimer = new Map<string, number>();
    for (const call of warnLines) {
      const id = /Timer (\S+) deferred/.exec(String(call[0]))?.[1] ?? 'unknown';
      linesPerTimer.set(id, (linesPerTimer.get(id) ?? 0) + 1);
    }
    expect(Math.max(...linesPerTimer.values())).toBe(1);
    expect(warnLines.filter(carriesStack)).toEqual([]);
    expect(warnLines.every((call) => call.length === 1)).toBe(true);
    expect(loggedLines(errorSpy)).toEqual([]);
  });
});
