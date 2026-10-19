import type { BatchOperation, Storage } from '../../storage/interface.ts';
import { KEYS, resolvePrefixRangeEnd } from '../../storage/interface.ts';
import { decode } from '../codec.ts';
import type { TimerEntry } from '../types.ts';
import { DEFAULT_POLL_INTERVAL_MS } from '../types/constants.ts';
import { buildTimerBatchOperations } from './timer-batch.ts';
import type { TimerDeferral } from './timer-deferral.ts';
import { isTimerDeferredError, timerDeferralBackoffMs } from './timer-deferral.ts';
import type { ScannedTimerEntry, TimerSource } from './timer-sources.ts';
import {
  advanceTimerSource,
  readNextScannedTimerEntry,
  readNextTeardownTimerEntry,
  readNextTerminalCleanupTimerEntry,
  selectNextTimerSource,
  shouldDeleteTimerIndexWithoutLookup,
} from './timer-sources.ts';

export interface SchedulerOptions {
  storage: Storage;
  onTimerFired: (entry: TimerEntry) => void | Promise<void>;
  pollIntervalMs?: number;
  getNow?: () => number;
  /**
   * Commit the batch that deletes a fired timer's keys after its callback
   * returns. Defaults to an unfenced `storage.batch`. The engine supplies a
   * lease-fenced commit (#563) so the fired-timer delete and the callback's own
   * follow-up writes share the same ownership fence — under deposition both are
   * rejected and the timer survives for the successor to re-drive. With no lease
   * held this commits exactly as the unfenced default would.
   */
  commitTimerCleanup?: (operations: BatchOperation[]) => Promise<void>;
}

type TimerScanIterators = {
  deadline: AsyncIterable<[string, Uint8Array]>;
  delayedStart: AsyncIterable<[string, Uint8Array]>;
  schedule: AsyncIterable<[string, Uint8Array]>;
  terminalCleanup: AsyncIterable<[string, Uint8Array]>;
  teardown: AsyncIterable<[string, Uint8Array]>;
};

type TimerProcessingResult = 'processed' | 'retry';

/**
 * Maximum expired timers read per timer source on one scheduler tick.
 * A larger backlog stays durable and is drained by later ticks, bounding
 * per-tick memory and callback work while preserving retry semantics.
 */
const EXPIRED_TIMER_SCAN_LIMIT_PER_SOURCE = 1_000;

/**
 * Scheduler manages durable timers and polls for expired deadlines.
 *
 * @example
 * ```ts
 * import { Scheduler } from '@lostgradient/weft';
 * import { MemoryStorage } from '@lostgradient/weft/storage/memory';
 *
 * const storage = new MemoryStorage();
 * const scheduler = new Scheduler({
 *   storage,
 *   onTimerFired: (entry) => {
 *     console.log('timer fired:', entry.id, entry.kind);
 *   },
 *   pollIntervalMs: 500,
 * });
 *
 * scheduler.start();
 * // ... use scheduler ...
 * scheduler.stop();
 * ```
 */
export class Scheduler implements Disposable {
  readonly #storage: Storage;
  readonly #onTimerFired: (entry: TimerEntry) => void | Promise<void>;
  readonly #pollIntervalMs: number;
  readonly #getNow: () => number;
  readonly #commitTimerCleanup: (operations: BatchOperation[]) => Promise<void>;
  #intervalHandle: ReturnType<typeof setInterval> | null = null;
  #stopped = false;
  /**
   * Timers whose callback deferred them ({@link TimerDeferredError}), keyed by
   * timer id. A deferred timer stays durable but is skipped until `retryAt`, so a
   * consumer that is not ready yet never turns into a retry on every tick
   * (HAPS-687). In-memory only: a fresh process simply fires it again.
   */
  readonly #deferredTimers = new Map<string, TimerDeferral>();

  constructor(options: SchedulerOptions) {
    this.#storage = options.storage;
    this.#onTimerFired = options.onTimerFired;
    this.#pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    this.#getNow = options.getNow ?? Date.now;
    this.#commitTimerCleanup =
      options.commitTimerCleanup ?? ((operations) => this.#storage.batch(operations));
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
    this.#deferredTimers.delete(id);
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

  /**
   * Clear a timer's deferral backoff so the next tick fires it again. Called
   * when the consumer that deferred the timer becomes ready (for a sleep: when
   * its resolver registers), so readiness never waits out the backoff.
   */
  releaseDeferredTimer(id: string): void {
    this.#deferredTimers.delete(id);
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
    const timerSources = this.#createTimerSources(this.#scanExpiredTimers(currentTime));
    const cleanupOperations: BatchOperation[] = [];
    const seenTimerIds = new Set<string>();

    for (const timerSource of timerSources) {
      await advanceTimerSource(timerSource, this.#storage);
    }

    while (this.#hasPendingTimer(timerSources)) {
      const selectedSource = selectNextTimerSource(timerSources);
      const nextEntry = selectedSource?.next;
      if (!nextEntry || !selectedSource) {
        break;
      }

      // Re-check #stopped before each callback so an interval-dispatched tick
      // terminates early when stop() or dispose is called concurrently. flush()
      // skips this check because its purpose is to drain remaining timers.
      if (respectStopped && this.#stopped) break;

      seenTimerIds.add(nextEntry.entry.id);
      if (this.#isDeferred(nextEntry.entry.id, currentTime)) {
        await advanceTimerSource(selectedSource, this.#storage);
        continue;
      }

      const processingResult = await this.#processSelectedTimer(
        nextEntry,
        cleanupOperations,
        currentTime,
      );
      if (processingResult === 'retry') {
        await advanceTimerSource(selectedSource, this.#storage);
        continue;
      }

      await advanceTimerSource(selectedSource, this.#storage);
    }

    await this.#deleteProcessedTimerKeys(cleanupOperations);
    // A scan cut short by stop() did not see every due timer; keep deferrals.
    if (!(respectStopped && this.#stopped)) this.#pruneDeferrals(seenTimerIds, currentTime);
  }

  /**
   * Forget deferrals for timers that were due but absent from this tick's scan
   * (cancelled, deleted by cleanup, or past the scan limit). Keeps the map
   * bounded by the live deferred set; a forgotten timer that is still durable
   * just fires normally on a later tick.
   */
  #pruneDeferrals(seenTimerIds: Set<string>, currentTime: number): void {
    for (const [id, deferral] of this.#deferredTimers) {
      if (deferral.retryAt <= currentTime && !seenTimerIds.has(id)) {
        this.#deferredTimers.delete(id);
      }
    }
  }

  #scanExpiredTimers(currentTime: number): TimerScanIterators {
    // Deferred timers are skipped without running their callback, so they must
    // not eat the per-tick budget: otherwise a backlog of deferred timers at the
    // head of the keyspace would starve every due timer behind it (HAPS-687).
    const limit = EXPIRED_TIMER_SCAN_LIMIT_PER_SOURCE + this.#deferredTimers.size;
    return {
      deadline: this.#storage.scan('wf-deadline:', {
        lt: resolvePrefixRangeEnd(KEYS.deadline(currentTime, '')),
        limit,
      }),
      delayedStart: this.#storage.scan('wf-delayed:', {
        lt: resolvePrefixRangeEnd(KEYS.delayedStart(currentTime, '')),
        limit,
      }),
      schedule: this.#storage.scan('schedule-due:', {
        lt: resolvePrefixRangeEnd(KEYS.scheduleTick(currentTime, '')),
        limit,
      }),
      terminalCleanup: this.#storage.scan('wf-cleanup:', {
        lt: resolvePrefixRangeEnd(KEYS.terminalCleanup(currentTime, '')),
        limit,
      }),
      teardown: this.#storage.scan('wf-teardown:', {
        lt: resolvePrefixRangeEnd(KEYS.teardownTimer(currentTime, '')),
        limit,
      }),
    };
  }

  #createTimerSources(iterators: TimerScanIterators): TimerSource[] {
    return [
      {
        iterator: iterators.deadline[Symbol.asyncIterator](),
        next: null as ScannedTimerEntry | null,
        readNext: readNextScannedTimerEntry,
      },
      {
        iterator: iterators.delayedStart[Symbol.asyncIterator](),
        next: null as ScannedTimerEntry | null,
        readNext: readNextScannedTimerEntry,
      },
      {
        iterator: iterators.schedule[Symbol.asyncIterator](),
        next: null as ScannedTimerEntry | null,
        readNext: readNextScannedTimerEntry,
      },
      {
        iterator: iterators.terminalCleanup[Symbol.asyncIterator](),
        next: null as ScannedTimerEntry | null,
        readNext: readNextTerminalCleanupTimerEntry,
      },
      {
        iterator: iterators.teardown[Symbol.asyncIterator](),
        next: null as ScannedTimerEntry | null,
        readNext: readNextTeardownTimerEntry,
      },
    ] satisfies TimerSource[];
  }

  #hasPendingTimer(timerSources: TimerSource[]): boolean {
    return timerSources.some((timerSource) => timerSource.next !== null);
  }

  #isDeferred(id: string, currentTime: number): boolean {
    const deferral = this.#deferredTimers.get(id);
    return deferral !== undefined && deferral.retryAt > currentTime;
  }

  #deferTimer(entry: TimerEntry, error: Error, currentTime: number): void {
    const attempts = (this.#deferredTimers.get(entry.id)?.attempts ?? 0) + 1;
    const backoffMs = timerDeferralBackoffMs(this.#pollIntervalMs, attempts);
    this.#deferredTimers.set(entry.id, { attempts, retryAt: currentTime + backoffMs });
    // One line per timer, never a stack: a deferral is an expected condition,
    // and thousands of them at boot must not flood the log (HAPS-687).
    if (attempts === 1) {
      console.warn(`Timer ${entry.id} deferred: ${error.message}`);
    }
  }

  async #processSelectedTimer(
    nextEntry: ScannedTimerEntry,
    cleanupOperations: BatchOperation[],
    currentTime: number,
  ): Promise<TimerProcessingResult> {
    try {
      await this.#onTimerFired(nextEntry.entry);
    } catch (error) {
      if (isTimerDeferredError(error)) {
        this.#deferTimer(nextEntry.entry, error, currentTime);
        return 'retry';
      }
      // Callback failed — leave the timer in storage so it retries on the
      // next tick. Do not fall through to the delete below.
      console.error(`Timer callback failed for timer ${nextEntry.entry.id}:`, error);
      return 'retry';
    }

    this.#deferredTimers.delete(nextEntry.entry.id);
    await this.#appendTimerCleanupOperationsAfterCallback(nextEntry, cleanupOperations);
    return 'processed';
  }

  async #appendTimerCleanupOperationsAfterCallback(
    nextEntry: ScannedTimerEntry,
    cleanupOperations: BatchOperation[],
  ): Promise<void> {
    try {
      cleanupOperations.push(...(await this.#buildTimerCleanupOperations(nextEntry)));
    } catch (deleteError) {
      console.error(`Failed to delete timer keys for ${nextEntry.entry.id}:`, deleteError);
    }
  }

  async #deleteProcessedTimerKeys(cleanupOperations: BatchOperation[]): Promise<void> {
    if (cleanupOperations.length === 0) return;

    try {
      // Routed through the (engine-supplied, lease-fenced) cleanup commit so a
      // deposed engine cannot drop a fired timer while its fenced follow-up
      // write was rejected (#563). A rejected fenced commit throws here and is
      // logged-and-swallowed exactly like an unfenced batch failure: the timer
      // stays in storage and the successor re-drives it.
      await this.#commitTimerCleanup(cleanupOperations);
    } catch (deleteError) {
      console.error('Failed to delete timer keys for processed scheduler tick:', deleteError);
    }
  }

  async #buildTimerCleanupOperations(nextEntry: ScannedTimerEntry): Promise<BatchOperation[]> {
    const cleanupOperations: BatchOperation[] = [{ type: 'delete', key: nextEntry.key }];
    const indexDeleteOperation = await this.#buildTimerIndexDeleteOperation(nextEntry);
    if (indexDeleteOperation) {
      cleanupOperations.push(indexDeleteOperation);
    }

    return cleanupOperations;
  }

  async #buildTimerIndexDeleteOperation(
    nextEntry: ScannedTimerEntry,
  ): Promise<BatchOperation | null> {
    const indexKey = `timer-idx:${nextEntry.entry.id}`;
    if (nextEntry.entry.kind === 'schedule') {
      return this.#buildScheduleTimerIndexDeleteOperation(nextEntry, indexKey);
    }

    return shouldDeleteTimerIndexWithoutLookup(nextEntry.entry)
      ? { type: 'delete', key: indexKey }
      : null;
  }

  async #buildScheduleTimerIndexDeleteOperation(
    nextEntry: ScannedTimerEntry,
    indexKey: string,
  ): Promise<BatchOperation | null> {
    const indexValue = await this.#storage.get(indexKey);
    if (indexValue === null) {
      return null;
    }

    const decodedIndexValue = decode(indexValue);

    // Schedule callbacks re-arm the next tick with the same timer id.
    // Only remove the index when it still points at the timer that just
    // fired; otherwise we would delete the freshly-registered next tick.
    return typeof decodedIndexValue !== 'string' || decodedIndexValue === nextEntry.key
      ? { type: 'delete', key: indexKey }
      : null;
  }

  [Symbol.dispose](): void {
    this.stop();
  }
}
