/**
 * Timer/retry scheduling logic with durable persistence.
 *
 * Provides duration parsing, exponential backoff calculation,
 * and a Scheduler class that manages durable timers backed by storage.
 *
 * @module scheduler
 */

import type { BatchOperation, Storage } from '../storage/interface';
import { KEYS, resolvePrefixRangeEnd, tryDecodeStorageKeyComponent } from '../storage/interface';
import { decode, encode } from './codec';
import type { Duration, RetryPolicy, TimerEntry } from './types';

function isTimerEntryKind(value: unknown): value is TimerEntry['kind'] {
  return (
    value === 'sleep' ||
    value === 'visibility-timeout' ||
    value === 'execution-deadline' ||
    value === 'delayed-start' ||
    value === 'schedule' ||
    value === 'terminal-cleanup'
  );
}

/** Runtime type guard for decoded timer entries. */
export function isTimerEntry(value: unknown): value is TimerEntry {
  return (
    typeof value === 'object' &&
    value !== null &&
    'id' in value &&
    typeof value.id === 'string' &&
    'workflowId' in value &&
    typeof value.workflowId === 'string' &&
    'fireAt' in value &&
    typeof value.fireAt === 'number' &&
    Number.isFinite(value.fireAt) &&
    'kind' in value &&
    isTimerEntryKind(value.kind)
  );
}

/**
 * Build the batch operations needed to persist a durable timer entry.
 * Shared between `Scheduler.schedule()` and `Engine.#buildStartBatchOperations()`
 * so the key format stays in one place.
 */
export function buildTimerBatchOperations(entry: TimerEntry): BatchOperation[] {
  const normalizedEntry: TimerEntry = {
    ...entry,
    fireAt: normalizeStorageTimestamp(entry.fireAt, 'Timer fireAt'),
  };
  if (normalizedEntry.kind === 'terminal-cleanup') {
    return [
      {
        type: 'put',
        key: KEYS.terminalCleanup(normalizedEntry.fireAt, normalizedEntry.id),
        value: encode(normalizedEntry.workflowId),
      },
    ];
  }

  const deadlineKey =
    normalizedEntry.kind === 'delayed-start'
      ? KEYS.delayedStart(normalizedEntry.fireAt, normalizedEntry.workflowId)
      : normalizedEntry.kind === 'schedule'
        ? KEYS.scheduleTick(normalizedEntry.fireAt, normalizedEntry.workflowId)
        : KEYS.deadline(normalizedEntry.fireAt, normalizedEntry.id);
  const operations: BatchOperation[] = [
    { type: 'put', key: deadlineKey, value: encode(normalizedEntry) },
  ];
  operations.push({
    type: 'put',
    key: `timer-idx:${normalizedEntry.id}`,
    value: encode(deadlineKey),
  });

  return operations;
}

// ---------------------------------------------------------------------------
// Duration parsing
// ---------------------------------------------------------------------------

const DURATION_PATTERN =
  /^(\d+(?:\.\d+)?)\s*(ms|milliseconds?|s|seconds?|m|minutes?|h|hours?|d|days?)$/i;

const UNIT_TO_MILLISECONDS: Record<string, number> = {
  ms: 1,
  millisecond: 1,
  milliseconds: 1,
  s: 1000,
  second: 1000,
  seconds: 1000,
  m: 60_000,
  minute: 60_000,
  minutes: 60_000,
  h: 3_600_000,
  hour: 3_600_000,
  hours: 3_600_000,
  d: 86_400_000,
  day: 86_400_000,
  days: 86_400_000,
};

function assertValidDurationMilliseconds(milliseconds: number, source: Duration): void {
  if (!Number.isFinite(milliseconds) || milliseconds < 0) {
    throw new RangeError(
      `Duration must resolve to a finite, non-negative number of milliseconds, got: ${String(source)}`,
    );
  }
}

export function normalizeStorageTimestamp(timestamp: number, fieldName: string): number {
  if (!Number.isFinite(timestamp) || timestamp < 0) {
    throw new RangeError(
      `${fieldName} must resolve to a finite, non-negative millisecond timestamp, got: ${String(timestamp)}`,
    );
  }

  const normalizedTimestamp = Math.ceil(timestamp);

  if (!Number.isSafeInteger(normalizedTimestamp)) {
    throw new RangeError(
      `${fieldName} must resolve to a safe integer millisecond timestamp, got: ${String(timestamp)}`,
    );
  }

  return normalizedTimestamp;
}

/** Parse a human-readable duration string or number to milliseconds. */
export function parseDuration(duration: Duration): number {
  if (typeof duration === 'number') {
    assertValidDurationMilliseconds(duration, duration);
    return duration;
  }

  const match = DURATION_PATTERN.exec(duration.trim());

  if (!match) {
    throw new Error(
      `Invalid duration string: "${duration}". Expected a number or a string like "30s", "5 minutes", "1 hour", etc.`,
    );
  }

  const value = Number.parseFloat(match[1]!);
  const unit = match[2]!.toLowerCase();
  const multiplier = UNIT_TO_MILLISECONDS[unit];

  if (multiplier === undefined) {
    throw new Error(`Unknown duration unit: "${unit}"`);
  }

  const milliseconds = value * multiplier;
  assertValidDurationMilliseconds(milliseconds, duration);
  return milliseconds;
}

// ---------------------------------------------------------------------------
// Backoff calculation
// ---------------------------------------------------------------------------

/** Calculate exponential backoff delay for a given retry attempt. */
export function calculateBackoff(attempt: number, policy: RetryPolicy): number {
  const initialMs = parseDuration(policy.initialBackoff);
  const maxMs = parseDuration(policy.maxBackoff);
  const raw = initialMs * Math.pow(policy.backoffMultiplier, attempt - 1);
  return Math.min(raw, maxMs);
}

// ---------------------------------------------------------------------------
// Scheduler
// ---------------------------------------------------------------------------

export interface SchedulerOptions {
  storage: Storage;
  onTimerFired: (entry: TimerEntry) => void | Promise<void>;
  pollIntervalMs?: number;
  getNow?: () => number;
}

type ScannedTimerEntry = {
  key: string;
  entry: TimerEntry;
};

type TimerSource = {
  iterator: AsyncIterator<[string, Uint8Array]>;
  next: ScannedTimerEntry | null;
  readNext: (
    iterator: AsyncIterator<[string, Uint8Array]>,
    storage: Storage,
  ) => Promise<ScannedTimerEntry | null>;
};

function compareScannedTimerEntries(left: ScannedTimerEntry, right: ScannedTimerEntry): number {
  if (left.entry.fireAt !== right.entry.fireAt) {
    return left.entry.fireAt - right.entry.fireAt;
  }

  return left.key.localeCompare(right.key);
}

async function readNextScannedTimerEntry(
  iterator: AsyncIterator<[string, Uint8Array]>,
  storage: Storage,
): Promise<ScannedTimerEntry | null> {
  while (true) {
    const next = await iterator.next();
    if (next.done) {
      return null;
    }

    const [key, value] = next.value;
    const decoded = decode(value);
    if (!isTimerEntry(decoded)) {
      console.error(`Corrupted timer entry at ${key}: removing`);
      await storage.delete(key);
      continue;
    }

    return { key, entry: decoded };
  }
}

async function readNextTerminalCleanupTimerEntry(
  iterator: AsyncIterator<[string, Uint8Array]>,
  storage: Storage,
): Promise<ScannedTimerEntry | null> {
  const prefix = 'wf-cleanup:';

  while (true) {
    const next = await iterator.next();
    if (next.done) {
      return null;
    }

    const [key, value] = next.value;
    const separatorIndex = key.indexOf(':', prefix.length);
    const fireAtValue =
      separatorIndex === -1 ? Number.NaN : Number(key.slice(prefix.length, separatorIndex));
    const timerId =
      separatorIndex === -1 ? null : tryDecodeStorageKeyComponent(key.slice(separatorIndex + 1));
    const decodedWorkflowId = decode(value);

    if (
      !Number.isSafeInteger(fireAtValue) ||
      fireAtValue < 0 ||
      timerId === null ||
      typeof decodedWorkflowId !== 'string'
    ) {
      console.error(`Corrupted terminal cleanup entry at ${key}: removing`);
      await storage.delete(key);
      continue;
    }

    return {
      key,
      entry: {
        id: timerId,
        workflowId: decodedWorkflowId,
        fireAt: fireAtValue,
        kind: 'terminal-cleanup',
      },
    };
  }
}

async function advanceTimerSource(timerSource: TimerSource, storage: Storage): Promise<void> {
  timerSource.next = await timerSource.readNext(timerSource.iterator, storage);
}

function selectNextTimerSource(timerSources: TimerSource[]): TimerSource | undefined {
  let selectedSource: TimerSource | undefined;

  for (const timerSource of timerSources) {
    if (timerSource.next === null) {
      continue;
    }

    if (
      selectedSource === undefined ||
      compareScannedTimerEntries(timerSource.next, selectedSource.next!) < 0
    ) {
      selectedSource = timerSource;
    }
  }

  return selectedSource;
}

function shouldDeleteTimerIndexWithoutLookup(entry: TimerEntry): boolean {
  return entry.kind !== 'schedule' && entry.kind !== 'terminal-cleanup';
}

/** Scheduler manages durable timers and polls for expired deadlines. */
export class Scheduler implements Disposable {
  readonly #storage: Storage;
  readonly #onTimerFired: (entry: TimerEntry) => void | Promise<void>;
  readonly #pollIntervalMs: number;
  readonly #getNow: () => number;
  #intervalHandle: ReturnType<typeof setInterval> | null = null;
  #stopped = false;

  constructor(options: SchedulerOptions) {
    this.#storage = options.storage;
    this.#onTimerFired = options.onTimerFired;
    this.#pollIntervalMs = options.pollIntervalMs ?? 1000;
    this.#getNow = options.getNow ?? Date.now;
  }

  /** Start the polling loop. */
  start(): void {
    if (this.#intervalHandle !== null) return;
    this.#stopped = false;

    this.#intervalHandle = setInterval(() => {
      void this.tick();
    }, this.#pollIntervalMs);
  }

  /** Stop the polling loop. */
  stop(): void {
    this.#stopped = true;
    if (this.#intervalHandle !== null) {
      clearInterval(this.#intervalHandle);
      this.#intervalHandle = null;
    }
  }

  /** Schedule a durable timer (writes to storage). */
  async schedule(entry: TimerEntry): Promise<void> {
    await this.#storage.batch(buildTimerBatchOperations(entry));
  }

  /** Cancel a timer (removes from storage). */
  async cancel(id: string, _workflowId: string): Promise<void> {
    const indexKey = `timer-idx:${id}`;
    const indexValue = await this.#storage.get(indexKey);

    if (indexValue === null) return;

    const decoded = decode(indexValue);
    if (typeof decoded !== 'string') {
      console.error(`Corrupted timer index for ${id}: expected string, got ${typeof decoded}`);
      // Delete the corrupted index key so it does not cause permanent log spam.
      await this.#storage.delete(indexKey);
      return;
    }
    const deadlineKey = decoded;

    await this.#storage.batch([
      { type: 'delete', key: deadlineKey },
      { type: 'delete', key: indexKey },
    ]);
  }

  /** Force an immediate scan for expired timers (for tests). */
  async tick(now?: number): Promise<void> {
    if (this.#stopped) return;
    await this.#processExpiredTimers(now, { respectStopped: true });
  }

  /** Process all expired timers then stop.
   *  Works even after stop() has been called — the intent is to drain remaining
   *  timers before final shutdown. Bypasses the #stopped guard so a
   *  stop()-then-flush() sequence works without re-enabling suspended interval
   *  ticks that might race with this drain.
   */
  async flush(now?: number): Promise<void> {
    await this.#processExpiredTimers(now, { respectStopped: false });
    this.stop();
  }

  /** Scan storage for expired timers, fire callbacks, and clean up keys.
   *  When `respectStopped` is true, an in-flight scan terminates early if
   *  stop() is called concurrently. flush() passes false so it can drain
   *  timers even after stop().
   */
  async #processExpiredTimers(
    now: number | undefined,
    { respectStopped }: { respectStopped: boolean },
  ): Promise<void> {
    const currentTime = now ?? this.#getNow();
    const deadlineIterator = this.#storage.scan('wf-deadline:', {
      lt: resolvePrefixRangeEnd(KEYS.deadline(currentTime, '')),
    });
    const delayedStartIterator = this.#storage.scan('wf-delayed:', {
      lt: resolvePrefixRangeEnd(KEYS.delayedStart(currentTime, '')),
    });
    const scheduleIterator = this.#storage.scan('schedule-due:', {
      lt: resolvePrefixRangeEnd(KEYS.scheduleTick(currentTime, '')),
    });
    const terminalCleanupIterator = this.#storage.scan('wf-cleanup:', {
      lt: resolvePrefixRangeEnd(KEYS.terminalCleanup(currentTime, '')),
    });
    const timerSources = [
      {
        iterator: deadlineIterator[Symbol.asyncIterator](),
        next: null as ScannedTimerEntry | null,
        readNext: readNextScannedTimerEntry,
      },
      {
        iterator: delayedStartIterator[Symbol.asyncIterator](),
        next: null as ScannedTimerEntry | null,
        readNext: readNextScannedTimerEntry,
      },
      {
        iterator: scheduleIterator[Symbol.asyncIterator](),
        next: null as ScannedTimerEntry | null,
        readNext: readNextScannedTimerEntry,
      },
      {
        iterator: terminalCleanupIterator[Symbol.asyncIterator](),
        next: null as ScannedTimerEntry | null,
        readNext: readNextTerminalCleanupTimerEntry,
      },
    ] satisfies TimerSource[];

    for (const timerSource of timerSources) {
      await advanceTimerSource(timerSource, this.#storage);
    }

    while (timerSources.some((timerSource) => timerSource.next !== null)) {
      const selectedSource = selectNextTimerSource(timerSources);
      const nextEntry = selectedSource?.next;
      if (!nextEntry || !selectedSource) {
        break;
      }

      // Re-check #stopped before each callback so an interval-dispatched tick
      // terminates early when stop() or dispose is called concurrently. flush()
      // skips this check because its purpose is to drain remaining timers.
      if (respectStopped && this.#stopped) return;

      try {
        await this.#onTimerFired(nextEntry.entry);
      } catch (error) {
        // Callback failed — leave the timer in storage so it retries on the
        // next tick. Do not fall through to the delete below.
        console.error(`Timer callback failed for timer ${nextEntry.entry.id}:`, error);
        await advanceTimerSource(selectedSource, this.#storage);
        continue;
      }

      const indexKey = `timer-idx:${nextEntry.entry.id}`;

      // Callback succeeded — clean up the timer keys. If this delete fails,
      // the timer will re-fire on the next tick (duplicate execution), but we
      // surface the error rather than silently swallowing it.
      try {
        const cleanupOperations: BatchOperation[] = [{ type: 'delete', key: nextEntry.key }];
        if (nextEntry.entry.kind === 'schedule') {
          const indexValue = await this.#storage.get(indexKey);
          if (indexValue !== null) {
            const decodedIndexValue = decode(indexValue);

            // Schedule callbacks re-arm the next tick with the same timer id.
            // Only remove the index when it still points at the timer that just
            // fired; otherwise we would delete the freshly-registered next tick.
            if (typeof decodedIndexValue !== 'string' || decodedIndexValue === nextEntry.key) {
              cleanupOperations.push({ type: 'delete', key: indexKey });
            }
          }
        } else if (shouldDeleteTimerIndexWithoutLookup(nextEntry.entry)) {
          cleanupOperations.push({ type: 'delete', key: indexKey });
        }

        await this.#storage.batch(cleanupOperations);
      } catch (deleteError) {
        console.error(`Failed to delete timer keys for ${nextEntry.entry.id}:`, deleteError);
      }

      await advanceTimerSource(selectedSource, this.#storage);
    }
  }

  [Symbol.dispose](): void {
    this.stop();
  }
}
