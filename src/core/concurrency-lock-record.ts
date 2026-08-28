/**
 * The durable lock record and the pure reducers that mutate it. These are the
 * deterministic core of the {@link DurableSemaphore}/{@link DurableMutex}
 * primitives in `./concurrency.ts`: every acquire, release, and renew is one
 * pure function over a {@link LockRecord}, so the algorithm is trivially
 * replay-safe and unit-testable in isolation from any storage flavour.
 *
 * Liveness is symmetric: HOLDERS carry a lease reclaimed on expiry, and
 * WAITERS carry their own expiry, refreshed on every retry — exactly the
 * scheme `./rate-limit-record.ts` uses. Without the waiter expiry, a contender
 * that enqueues and then crashes would sit at the head of the FIFO queue
 * forever, blocking every live waiter behind it even with zero holders — a
 * ghost-waiter deadlock, observed in production before this shipped.
 *
 * @module core/concurrency-lock-record
 */

/**
 * One permit currently held against a {@link DurableSemaphore}. `leaseExpiresAt`
 * is the deterministic timestamp (milliseconds since epoch) after which the
 * permit may be reclaimed by another contender, preventing a crashed holder
 * from deadlocking the lock.
 *
 * @example
 * ```ts
 * import type { LockHolder } from '@lostgradient/weft';
 *
 * const holder: LockHolder = { holderId: 'workflow-a', leaseExpiresAt: 1_717_000_030_000 };
 * void holder;
 * ```
 */
export interface LockHolder {
  /** Caller-chosen identifier for the holder (typically `ctx.workflowId`). */
  holderId: string;
  /** Timestamp (ms since epoch) after which this lease may be reclaimed. */
  leaseExpiresAt: number;
}

/**
 * One contender waiting for a permit. `expiresAt` is refreshed on every retry;
 * an entry whose expiry has passed is dropped by the next reduction, so a
 * crashed waiter cannot head-of-line-block the FIFO queue behind it.
 *
 * @example
 * ```ts
 * import type { LockWaiter } from '@lostgradient/weft';
 *
 * const waiter: LockWaiter = { holderId: 'workflow-b', expiresAt: 1_717_000_030_000 };
 * void waiter;
 * ```
 */
export interface LockWaiter {
  /** Caller-chosen identifier for the contender (typically `ctx.workflowId`). */
  holderId: string;
  /** Timestamp (ms since epoch) after which this waiter entry may be dropped. */
  expiresAt: number;
}

/**
 * The durable record persisted in a single CAS state slot. `holders` are the
 * permits currently granted (length never exceeds the semaphore's permit
 * count); `waiters` is the FIFO queue of contenders waiting for a permit, each
 * carrying its own expiry.
 *
 * Records persisted before waiter expiries existed carry bare string ids in
 * `waiters`; the reducers normalize those on read (stamping a fresh expiry),
 * so a standing legacy record — ghosts included — heals itself one TTL after
 * the first reduction touches it.
 *
 * @example
 * ```ts
 * import type { LockRecord } from '@lostgradient/weft';
 *
 * const record: LockRecord = {
 *   holders: [{ holderId: 'workflow-a', leaseExpiresAt: 1_717_000_030_000 }],
 *   waiters: [{ holderId: 'workflow-b', expiresAt: 1_717_000_030_000 }],
 * };
 * void record;
 * ```
 */
export interface LockRecord {
  holders: LockHolder[];
  waiters: LockWaiter[];
}

/**
 * Outcome of a single non-blocking acquire attempt.
 *
 * @example
 * ```ts
 * import type { AcquireAttempt } from '@lostgradient/weft';
 *
 * const attempt: AcquireAttempt = { acquired: false, position: 0 };
 * if (!attempt.acquired) {
 *   // attempt.position is the caller's place in the FIFO queue.
 * }
 * ```
 */
export interface AcquireAttempt {
  /** Whether the caller now holds a permit. */
  acquired: boolean;
  /**
   * Zero-based position in the FIFO waiter queue when `acquired` is `false`.
   * `0` means the caller is next in line. `-1` when `acquired` is `true`.
   */
  position: number;
}

/**
 * Floor for waiter expiries stamped onto legacy entries and for the reducers'
 * default TTL. Mirrors the rate limiter's floor: generous against any honest
 * retry cadence, short enough that a crashed waiter frees the queue promptly.
 *
 * @example
 * ```ts
 * import { MIN_LOCK_WAITER_TTL_MS } from '@lostgradient/weft';
 *
 * // The default waiter TTL is never below this floor, however short the lease.
 * const ttl = Math.max(MIN_LOCK_WAITER_TTL_MS, 5_000);
 * void ttl;
 * ```
 */
export const MIN_LOCK_WAITER_TTL_MS = 30_000;

/**
 * A fresh empty {@link LockRecord}. Pass this as the `initial` option when
 * constructing the CAS state handle so the first reader sees an empty lock
 * rather than `undefined`.
 *
 * @example
 * ```ts
 * import { initialLockRecord, AtomicState } from '@lostgradient/weft';
 * import { MemoryStorage } from '@lostgradient/weft/storage/memory';
 *
 * const slot = new AtomicState(new MemoryStorage(), 'state:workflow-scope:default:lock', {
 *   initial: initialLockRecord(),
 * });
 * void slot;
 * ```
 */
export function initialLockRecord(): LockRecord {
  return { holders: [], waiters: [] };
}

/**
 * Normalize one persisted waiter entry. Entries written before waiter
 * expiries existed are bare strings; they are stamped `fallbackExpiresAt` so a
 * live legacy waiter keeps its FIFO position across the upgrade (it refreshes
 * itself on its next retry) while a ghost ages out one TTL later.
 */
function normalizeWaiter(entry: unknown, fallbackExpiresAt: number): LockWaiter | null {
  if (typeof entry === 'string') return { holderId: entry, expiresAt: fallbackExpiresAt };
  if (
    typeof entry === 'object' &&
    entry !== null &&
    typeof (entry as LockWaiter).holderId === 'string'
  ) {
    const expiresAt = (entry as LockWaiter).expiresAt;
    return {
      holderId: (entry as LockWaiter).holderId,
      expiresAt:
        typeof expiresAt === 'number' && Number.isFinite(expiresAt)
          ? expiresAt
          : fallbackExpiresAt,
    };
  }
  return null;
}

function normalizeRecord(record: LockRecord | undefined, fallbackExpiresAt: number): LockRecord {
  if (record === undefined) return initialLockRecord();
  const rawWaiters: unknown[] = Array.isArray(record.waiters) ? record.waiters : [];
  return {
    holders: Array.isArray(record.holders) ? record.holders : [],
    waiters: rawWaiters
      .map((entry) => normalizeWaiter(entry, fallbackExpiresAt))
      .filter((waiter): waiter is LockWaiter => waiter !== null),
  };
}

/**
 * Drop expired leases from `holders`. A lease is expired when its
 * `leaseExpiresAt` is at or before `now`; reclaiming it is what frees a lock
 * held by a crashed workflow.
 */
function dropExpiredHolders(holders: LockHolder[], now: number): LockHolder[] {
  return holders.filter((holder) => holder.leaseExpiresAt > now);
}

/**
 * Drop expired waiter entries. An entry is expired when its `expiresAt` is at
 * or before `now`; dropping it is what frees a FIFO queue head-of-line-blocked
 * by a crashed waiter.
 */
function dropExpiredWaiters(waiters: LockWaiter[], now: number): LockWaiter[] {
  return waiters.filter((waiter) => waiter.expiresAt > now);
}

/**
 * Pure reducer for one acquire attempt. Returns the next record alongside
 * whether the caller acquired a permit and its queue position. Deterministic
 * in its inputs so it replays identically.
 *
 * Every reduction reclaims expired holder leases AND ages out expired waiter
 * entries, then registers-or-refreshes the caller in the FIFO queue — so any
 * live contender's ordinary retry is also what heals the record of ghosts.
 * `waiterTtlMs` defaults to `max(MIN_LOCK_WAITER_TTL_MS, leaseMs)` so waiters
 * and holders share one liveness horizon unless the caller says otherwise.
 *
 * @example
 * ```ts
 * import { reduceAcquire } from '@lostgradient/weft';
 *
 * const { record, attempt } = reduceAcquire(undefined, {
 *   holderId: 'workflow-a',
 *   now: 1_000,
 *   leaseMs: 60_000,
 *   permits: 1,
 * });
 * // attempt.acquired === true — an empty lock grants immediately.
 * void record;
 * ```
 */
export function reduceAcquire(
  current: LockRecord | undefined,
  options: {
    holderId: string;
    now: number;
    leaseMs: number;
    permits: number;
    waiterTtlMs?: number;
  },
): { record: LockRecord; attempt: AcquireAttempt } {
  const { holderId, now, leaseMs, permits } = options;
  const waiterTtlMs = options.waiterTtlMs ?? Math.max(MIN_LOCK_WAITER_TTL_MS, leaseMs);
  const record = normalizeRecord(current, now + waiterTtlMs);

  // Reclaim any leases and age out any waiters that have expired before
  // deciding anything else.
  const liveHolders = dropExpiredHolders(record.holders, now);
  const liveWaiters = dropExpiredWaiters(record.waiters, now);

  // Re-acquisition is idempotent: an existing holder renews its own lease.
  const existingHolderIndex = liveHolders.findIndex((holder) => holder.holderId === holderId);
  if (existingHolderIndex !== -1) {
    const renewed = liveHolders.map((holder, index) =>
      index === existingHolderIndex ? { holderId, leaseExpiresAt: now + leaseMs } : holder,
    );
    return {
      record: {
        holders: renewed,
        waiters: liveWaiters.filter((waiter) => waiter.holderId !== holderId),
      },
      attempt: { acquired: true, position: -1 },
    };
  }

  // Register-or-refresh the caller in the FIFO queue exactly once.
  const entry: LockWaiter = { holderId, expiresAt: now + waiterTtlMs };
  const existingWaiterIndex = liveWaiters.findIndex((waiter) => waiter.holderId === holderId);
  const waiters =
    existingWaiterIndex === -1
      ? [...liveWaiters, entry]
      : liveWaiters.map((waiter, index) => (index === existingWaiterIndex ? entry : waiter));

  const freePermits = permits - liveHolders.length;
  const isNextInLine = waiters[0]?.holderId === holderId;

  if (freePermits > 0 && isNextInLine) {
    return {
      record: {
        holders: [...liveHolders, { holderId, leaseExpiresAt: now + leaseMs }],
        waiters: waiters.slice(1),
      },
      attempt: { acquired: true, position: -1 },
    };
  }

  return {
    record: { holders: liveHolders, waiters },
    attempt: {
      acquired: false,
      position: waiters.findIndex((waiter) => waiter.holderId === holderId),
    },
  };
}

/**
 * Pure reducer for releasing a permit. Removes the holder (and any stale waiter
 * entry) and reclaims expired leases and waiters so the record stays clean.
 */
export function reduceRelease(
  current: LockRecord | undefined,
  options: { holderId: string; now: number; waiterTtlMs?: number },
): LockRecord {
  const { holderId, now } = options;
  const waiterTtlMs = options.waiterTtlMs ?? MIN_LOCK_WAITER_TTL_MS;
  const record = normalizeRecord(current, now + waiterTtlMs);
  return {
    holders: dropExpiredHolders(record.holders, now).filter(
      (holder) => holder.holderId !== holderId,
    ),
    waiters: dropExpiredWaiters(record.waiters, now).filter(
      (waiter) => waiter.holderId !== holderId,
    ),
  };
}

/**
 * Pure reducer for renewing a held lease. Extends the holder's
 * `leaseExpiresAt`; a no-op if the caller is not currently a holder.
 */
export function reduceRenew(
  current: LockRecord | undefined,
  options: { holderId: string; now: number; leaseMs: number; waiterTtlMs?: number },
): { record: LockRecord; renewed: boolean } {
  const { holderId, now, leaseMs } = options;
  const waiterTtlMs = options.waiterTtlMs ?? Math.max(MIN_LOCK_WAITER_TTL_MS, leaseMs);
  const record = normalizeRecord(current, now + waiterTtlMs);
  const liveHolders = dropExpiredHolders(record.holders, now);
  let renewed = false;
  const holders = liveHolders.map((holder) => {
    if (holder.holderId === holderId) {
      renewed = true;
      return { holderId, leaseExpiresAt: now + leaseMs };
    }
    return holder;
  });
  return { record: { holders, waiters: record.waiters }, renewed };
}
