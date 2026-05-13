/**
 * Browser-compatible timer scheduler for Service Worker environments.
 *
 * Replaces the server-side Scheduler with one that uses
 * Periodic Background Sync (where available) or falls back to
 * `setTimeout`-based polling.
 *
 * @module service-worker/scheduler
 */

import { decode } from '../core/codec';
import { buildTimerBatchOperations } from '../core/scheduler';
import type { ScannedTimerEntry, TimerSource } from '../core/scheduler/timer-sources';
import {
  advanceTimerSource,
  readNextScannedTimerEntry,
  readNextTerminalCleanupTimerEntry,
  selectNextTimerSource,
  shouldDeleteTimerIndexWithoutLookup,
} from '../core/scheduler/timer-sources';
import type { TimerEntry } from '../core/types';
import type { BatchOperation, Storage } from '../storage/interface';
import { KEYS, resolvePrefixRangeEnd } from '../storage/interface';

// ---------------------------------------------------------------------------
// Periodic sync type (not in default lib but used at runtime in browsers)
// ---------------------------------------------------------------------------

interface PeriodicSyncManager {
  register(tag: string, options?: { minInterval?: number }): Promise<void>;
}

interface RegistrationWithPeriodicSync extends ServiceWorkerRegistration {
  periodicSync?: PeriodicSyncManager;
}

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export interface ServiceWorkerSchedulerOptions {
  storage: Storage;
  onTimerFired: (entry: TimerEntry) => void | Promise<void>;
  registration?: ServiceWorkerRegistration;
  periodicSyncTag?: string;
  fallbackIntervalMilliseconds?: number;
  getNow?: () => number;
}

// ---------------------------------------------------------------------------
// Default constants
// ---------------------------------------------------------------------------

const DEFAULT_PERIODIC_SYNC_TAG = 'weft-timers';
const DEFAULT_FALLBACK_INTERVAL_MILLISECONDS = 60_000;
const DEFAULT_PERIODIC_SYNC_MIN_INTERVAL = 60_000;

// ---------------------------------------------------------------------------
// ServiceWorkerScheduler
// ---------------------------------------------------------------------------

/** Scheduler for browser Service Worker environments, backed by durable storage. */
export class ServiceWorkerScheduler implements Disposable {
  readonly #storage: Storage;
  readonly #onTimerFired: (entry: TimerEntry) => void | Promise<void>;
  readonly #registration: RegistrationWithPeriodicSync | undefined;
  readonly #periodicSyncTag: string;
  readonly #fallbackIntervalMilliseconds: number;
  readonly #getNow: () => number;
  #timeoutHandle: ReturnType<typeof setTimeout> | null = null;
  #running = false;
  #stopped = false;
  #generation = 0;

  constructor(options: ServiceWorkerSchedulerOptions) {
    this.#storage = options.storage;
    this.#onTimerFired = options.onTimerFired;
    this.#registration = options.registration as RegistrationWithPeriodicSync | undefined;
    this.#periodicSyncTag = options.periodicSyncTag ?? DEFAULT_PERIODIC_SYNC_TAG;
    this.#fallbackIntervalMilliseconds =
      options.fallbackIntervalMilliseconds ?? DEFAULT_FALLBACK_INTERVAL_MILLISECONDS;
    this.#getNow = options.getNow ?? Date.now;
  }

  /** Schedule a durable timer (writes to storage). */
  async schedule(entry: TimerEntry): Promise<void> {
    await this.#storage.batch(buildTimerBatchOperations(entry));
  }

  /** Cancel a timer (removes from storage). */
  async cancel(id: string): Promise<void> {
    const indexKey = `timer-idx:${id}`;
    const indexValue = await this.#storage.get(indexKey);

    if (indexValue === null) return;

    const decoded = decode(indexValue);
    if (typeof decoded !== 'string') {
      console.error(`Corrupted timer index for ${id}: expected string, got ${typeof decoded}`);
      await this.#storage.delete(indexKey);
      return;
    }
    const deadlineKey = decoded;

    await this.#storage.batch([
      { type: 'delete', key: deadlineKey },
      { type: 'delete', key: indexKey },
    ]);
  }

  /** Scan for expired timers, fire callbacks, and clean up. */
  async tick(now?: number): Promise<void> {
    if (this.#stopped) return;
    await this.#processExpiredTimers(now, { respectStopped: true });
  }

  /** Process all expired timers then stop. */
  async flush(now?: number): Promise<void> {
    await this.#processExpiredTimers(now, { respectStopped: false });
    this.stop();
  }

  /** Start the scheduler. Uses Periodic Background Sync if available, otherwise falls back to setTimeout polling. */
  start(): void {
    if (this.#running) return;
    this.#running = true;
    this.#stopped = false;
    this.#generation++;

    const periodicSync = this.#registration?.periodicSync;

    if (periodicSync) {
      // Capture the generation so the async .catch() handler can detect a
      // stop()/start() cycle that happened while the registration was pending.
      // Without this, the deferred handler could create a duplicate polling loop.
      const startGeneration = this.#generation;

      void periodicSync
        .register(this.#periodicSyncTag, {
          minInterval: DEFAULT_PERIODIC_SYNC_MIN_INTERVAL,
        })
        .catch(() => {
          if (this.#generation !== startGeneration) return;
          // Periodic sync registration failed — fall back to polling
          this.#schedulePoll();
        });
      return;
    }

    this.#schedulePoll();
  }

  /** Stop the scheduler and clear all timeout handles. */
  stop(): void {
    this.#running = false;
    this.#stopped = true;
    this.#generation++;

    if (this.#timeoutHandle !== null) {
      clearTimeout(this.#timeoutHandle);
      this.#timeoutHandle = null;
    }
  }

  [Symbol.dispose](): void {
    this.stop();
  }

  // -------------------------------------------------------------------------
  // Private
  // -------------------------------------------------------------------------

  // oxlint-disable-next-line complexity -- ID:service-worker-scheduler-tick-parity
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
      if (!nextEntry || !selectedSource) break;

      if (respectStopped && this.#stopped) return;

      try {
        await this.#onTimerFired(nextEntry.entry);
      } catch (error) {
        console.error(`Timer callback failed for timer ${nextEntry.entry.id}:`, error);
        await advanceTimerSource(selectedSource, this.#storage);
        continue;
      }

      const indexKey = `timer-idx:${nextEntry.entry.id}`;

      try {
        const cleanupOperations: BatchOperation[] = [{ type: 'delete', key: nextEntry.key }];
        if (nextEntry.entry.kind === 'schedule') {
          const indexValue = await this.#storage.get(indexKey);
          if (indexValue !== null) {
            const decodedIndexValue = decode(indexValue);
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

  #schedulePoll(): void {
    if (!this.#running) return;

    // Capture the generation so the async .finally() handler can detect a
    // stop()/start() cycle that happened while a tick was in-flight. Without
    // this, the old tick's .finally() could create a duplicate polling loop.
    const pollGeneration = this.#generation;

    this.#timeoutHandle = setTimeout(() => {
      void this.tick()
        .catch((error: unknown) => {
          console.error('[weft] ServiceWorkerScheduler tick failed:', error);
        })
        .finally(() => {
          if (this.#generation !== pollGeneration) return;
          this.#schedulePoll();
        });
    }, this.#fallbackIntervalMilliseconds);
  }
}
