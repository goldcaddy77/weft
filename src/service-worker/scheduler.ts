/**
 * Browser-compatible timer scheduler for Service Worker environments.
 *
 * Replaces the server-side Scheduler with one that uses
 * Periodic Background Sync (where available) or falls back to
 * `setTimeout`-based polling.
 *
 * @module service-worker/scheduler
 */

import { decode, encode } from '../core/codec';
import type { TimerEntry } from '../core/types';
import type { Storage } from '../storage/interface';
import { KEYS } from '../storage/interface';

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
    const deadlineKey = KEYS.deadline(entry.fireAt, entry.id);
    const indexKey = `timer-idx:${entry.id}`;

    await this.#storage.batch([
      { type: 'put', key: deadlineKey, value: encode(entry) },
      { type: 'put', key: indexKey, value: encode(deadlineKey) },
    ]);
  }

  /** Cancel a timer (removes from storage). */
  async cancel(id: string): Promise<void> {
    const indexKey = `timer-idx:${id}`;
    const indexValue = await this.#storage.get(indexKey);

    if (indexValue === null) return;

    const deadlineKey = decode(indexValue) as string;

    await this.#storage.batch([
      { type: 'delete', key: deadlineKey },
      { type: 'delete', key: indexKey },
    ]);
  }

  /** Scan for expired timers, fire callbacks, and clean up. */
  async tick(now?: number): Promise<void> {
    const currentTime = now ?? this.#getNow();
    const upperBound = KEYS.deadline(currentTime, '\xff');

    const expired: Array<{ key: string; entry: TimerEntry }> = [];

    for await (const [key, value] of this.#storage.scan('wf-deadline:', { lte: upperBound })) {
      const entry = decode(value) as TimerEntry;
      expired.push({ key, entry });
    }

    for (const { key, entry } of expired) {
      await this.#onTimerFired(entry);

      const indexKey = `timer-idx:${entry.id}`;
      await this.#storage.batch([
        { type: 'delete', key },
        { type: 'delete', key: indexKey },
      ]);
    }
  }

  /** Process all expired timers then stop. */
  async flush(now?: number): Promise<void> {
    await this.tick(now);
    this.stop();
  }

  /** Start the scheduler. Uses Periodic Background Sync if available, otherwise falls back to setTimeout polling. */
  start(): void {
    if (this.#running) return;
    this.#running = true;

    const periodicSync = this.#registration?.periodicSync;

    if (periodicSync) {
      void periodicSync.register(this.#periodicSyncTag, {
        minInterval: DEFAULT_PERIODIC_SYNC_MIN_INTERVAL,
      });
      return;
    }

    this.#schedulePoll();
  }

  /** Stop the scheduler and clear all timeout handles. */
  stop(): void {
    this.#running = false;

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

  #schedulePoll(): void {
    if (!this.#running) return;

    this.#timeoutHandle = setTimeout(() => {
      void this.tick().then(() => {
        this.#schedulePoll();
        return undefined;
      });
    }, this.#fallbackIntervalMilliseconds);
  }
}
