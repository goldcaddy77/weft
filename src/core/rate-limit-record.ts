/**
 * The durable rate-limit record and the pure reducers that mutate it. These are
 * the deterministic core of the {@link DurableRateLimiter} primitive in
 * `./rate-limiter.ts`, exactly as `./concurrency-lock-record.ts` is the core of
 * the semaphore: every grant and withdrawal is one pure function over a
 * {@link RateLimitRecord}, so the algorithm is replay-safe and unit-testable in
 * isolation from any storage flavour.
 *
 * The model is a token bucket. The bucket holds up to `capacity` tokens and
 * accrues one token every `refillIntervalMs`, computed deterministically from
 * the caller-supplied `now` against a persisted anchor — the primitive never
 * reads a clock. `capacity: 1` degenerates to a minimum interval between
 * grants ("at most one capture of this host every 30 seconds"); a larger
 * capacity expresses burst allowances ("at most 10 requests a minute, in any
 * shape").
 *
 * Unlike the semaphore there is no lease and no release: a grant CONSUMES a
 * token, and there is nothing to give back. The crash-safety concern moves to
 * the WAITER queue instead — a contender that enqueues and then dies would
 * block FIFO forever — so each waiter entry carries its own expiry, refreshed
 * on every retry, and a stale waiter simply ages out.
 *
 * @module core/rate-limit-record
 */

/**
 * One contender waiting for a token. `expiresAt` is refreshed on every retry;
 * an entry whose expiry has passed is dropped, so a crashed waiter cannot
 * block the FIFO queue behind it.
 *
 * @example
 * ```ts
 * import type { RateWaiter } from '@lostgradient/weft';
 *
 * const waiter: RateWaiter = { holderId: 'workflow-b', expiresAt: 1_717_000_030_000 };
 * void waiter;
 * ```
 */
export interface RateWaiter {
  /** Caller-chosen identifier for the contender (typically `ctx.workflowId`). */
  holderId: string;
  /** Timestamp (ms since epoch) after which this waiter entry may be dropped. */
  expiresAt: number;
}

/**
 * The durable record persisted in a single CAS state slot. `tokens` is the
 * whole number of grants currently available; `refillAnchorAt` is the
 * deterministic timestamp fractional accrual is measured from; `waiters` is
 * the FIFO queue of contenders.
 *
 * @example
 * ```ts
 * import type { RateLimitRecord } from '@lostgradient/weft';
 *
 * const record: RateLimitRecord = {
 *   tokens: 0,
 *   refillAnchorAt: 1_717_000_000_000,
 *   waiters: [{ holderId: 'workflow-b', expiresAt: 1_717_000_030_000 }],
 * };
 * void record;
 * ```
 */
export interface RateLimitRecord {
  /** Whole tokens currently available (0..capacity). */
  tokens: number;
  /**
   * The timestamp accrual is measured from. Advanced by whole refill intervals
   * as tokens are minted, so sub-interval progress is never lost between
   * reductions; re-anchored to `now` while the bucket is full, so idle time
   * never mints a retroactive burst beyond `capacity`.
   */
  refillAnchorAt: number;
  /** FIFO queue of contenders, each with its own expiry. */
  waiters: RateWaiter[];
}

/**
 * Outcome of a single non-blocking grant attempt.
 *
 * @example
 * ```ts
 * import type { RateGrantAttempt } from '@lostgradient/weft';
 *
 * const attempt: RateGrantAttempt = { granted: false, position: 0, retryAfterMs: 30_000 };
 * if (!attempt.granted) {
 *   // Sleep ~retryAfterMs (durably, inside a workflow) and retry.
 * }
 * ```
 */
export interface RateGrantAttempt {
  /** Whether the caller consumed a token. */
  granted: boolean;
  /**
   * Zero-based position in the FIFO waiter queue when `granted` is `false`
   * (`0` means next in line). `-1` when `granted` is `true`.
   */
  position: number;
  /**
   * Milliseconds until enough tokens will have accrued for every contender
   * ahead of the caller AND the caller itself, assuming no new contenders
   * arrive. An ESTIMATE to sleep on, not a promise: FIFO order is only decided
   * at grant time. `-1` when `granted` is `true`; never less than `1` when not.
   */
  retryAfterMs: number;
}

/**
 * A fresh empty {@link RateLimitRecord} — a full bucket anchored at `now`.
 * Pass this as the `initial` option when constructing the CAS state handle so
 * the first reader sees a full bucket rather than `undefined`.
 *
 * @example
 * ```ts
 * import { initialRateLimitRecord, AtomicState } from '@lostgradient/weft';
 * import { MemoryStorage } from '@lostgradient/weft/storage/memory';
 *
 * const slot = new AtomicState(new MemoryStorage(), 'state:workflow-scope:default:rate', {
 *   initial: initialRateLimitRecord(3, 1_717_000_000_000),
 * });
 * void slot;
 * ```
 */
export function initialRateLimitRecord(capacity: number, now: number): RateLimitRecord {
  return { tokens: capacity, refillAnchorAt: now, waiters: [] };
}

function normalizeRecord(
  record: RateLimitRecord | undefined,
  capacity: number,
  now: number,
): RateLimitRecord {
  if (record === undefined) return initialRateLimitRecord(capacity, now);
  return {
    tokens: typeof record.tokens === 'number' && record.tokens >= 0 ? record.tokens : 0,
    // `>= 0`, not `> 0`: zero is a legitimate anchor (deterministic tests count
    // from epoch zero), and treating it as absent silently resets the bucket's
    // accrual on every reduction.
    refillAnchorAt:
      typeof record.refillAnchorAt === 'number' &&
      Number.isFinite(record.refillAnchorAt) &&
      record.refillAnchorAt >= 0
        ? record.refillAnchorAt
        : now,
    waiters: Array.isArray(record.waiters) ? record.waiters : [],
  };
}

/**
 * Accrue whole tokens deterministically from the anchor. Advances the anchor
 * by exactly the intervals consumed, so sub-interval progress carries over;
 * re-anchors at `now` when the bucket is (or becomes) full, so idle time never
 * mints a retroactive burst.
 */
function refill(
  record: RateLimitRecord,
  options: { capacity: number; refillIntervalMs: number; now: number },
): RateLimitRecord {
  const { capacity, refillIntervalMs, now } = options;
  const elapsed = now - record.refillAnchorAt;
  if (record.tokens >= capacity) {
    return { ...record, tokens: capacity, refillAnchorAt: now };
  }
  if (elapsed < refillIntervalMs) return record;
  const minted = Math.floor(elapsed / refillIntervalMs);
  const tokens = Math.min(capacity, record.tokens + minted);
  const refillAnchorAt =
    tokens >= capacity ? now : record.refillAnchorAt + minted * refillIntervalMs;
  return { ...record, tokens, refillAnchorAt };
}

function dropExpiredWaiters(waiters: RateWaiter[], now: number): RateWaiter[] {
  return waiters.filter((waiter) => waiter.expiresAt > now);
}

/**
 * Pure reducer for one grant attempt. Refills the bucket from the anchor,
 * ages out stale waiters, registers the caller in the FIFO queue (refreshing
 * its expiry on retry), and consumes a token only when the caller is at the
 * head of the queue and a token exists. Deterministic in its inputs so it
 * replays identically.
 *
 * @example
 * ```ts
 * import { reduceRateAcquire } from '@lostgradient/weft';
 *
 * const { record, attempt } = reduceRateAcquire(undefined, {
 *   holderId: 'workflow-a',
 *   now: 1_000,
 *   capacity: 1,
 *   refillIntervalMs: 30_000,
 *   waiterTtlMs: 60_000,
 * });
 * // attempt.granted === true — a fresh bucket starts full.
 * void record;
 * ```
 */
export function reduceRateAcquire(
  current: RateLimitRecord | undefined,
  options: {
    holderId: string;
    now: number;
    capacity: number;
    refillIntervalMs: number;
    waiterTtlMs: number;
  },
): { record: RateLimitRecord; attempt: RateGrantAttempt } {
  const { holderId, now, capacity, refillIntervalMs, waiterTtlMs } = options;
  const refilled = refill(normalizeRecord(current, capacity, now), {
    capacity,
    refillIntervalMs,
    now,
  });
  const liveWaiters = dropExpiredWaiters(refilled.waiters, now);

  // Register-or-refresh the caller in the FIFO queue exactly once.
  const existingIndex = liveWaiters.findIndex((waiter) => waiter.holderId === holderId);
  const entry: RateWaiter = { holderId, expiresAt: now + waiterTtlMs };
  const waiters =
    existingIndex === -1
      ? [...liveWaiters, entry]
      : liveWaiters.map((waiter, index) => (index === existingIndex ? entry : waiter));

  const position = waiters.findIndex((waiter) => waiter.holderId === holderId);
  if (position === 0 && refilled.tokens >= 1) {
    const consumed = refilled.tokens - 1;
    return {
      record: {
        tokens: consumed,
        // A full bucket's anchor was re-set to `now` by refill; consuming from
        // a full bucket starts the next interval HERE, which is what makes
        // `capacity: 1` a true minimum interval between grants.
        refillAnchorAt: refilled.refillAnchorAt,
        waiters: waiters.slice(1),
      },
      attempt: { granted: true, position: -1, retryAfterMs: -1 },
    };
  }

  // Tokens needed for everyone ahead of the caller, plus the caller, minus
  // what the bucket already holds — then ms until that many have accrued.
  const needed = position + 1 - refilled.tokens;
  const accruedMs = now - refilled.refillAnchorAt;
  const retryAfterMs = Math.max(1, needed * refillIntervalMs - accruedMs);

  return {
    record: { tokens: refilled.tokens, refillAnchorAt: refilled.refillAnchorAt, waiters },
    attempt: { granted: false, position, retryAfterMs },
  };
}

/**
 * Pure reducer for leaving the queue without a grant. Idempotent: withdrawing
 * a holder that is not enqueued only ages out stale waiters. A contender that
 * gives up (timeout, cancellation) withdraws so the queue behind it advances
 * immediately rather than waiting out its TTL.
 *
 * @example
 * ```ts
 * import { reduceRateWithdraw } from '@lostgradient/weft';
 *
 * const record = reduceRateWithdraw(
 *   { tokens: 0, refillAnchorAt: 1_000, waiters: [{ holderId: 'a', expiresAt: 61_000 }] },
 *   { holderId: 'a', now: 2_000 },
 * );
 * // record.waiters === []
 * void record;
 * ```
 */
export function reduceRateWithdraw(
  current: RateLimitRecord | undefined,
  options: { holderId: string; now: number },
): RateLimitRecord {
  const { holderId, now } = options;
  // Capacity is irrelevant to a withdrawal; normalize against a zero-token
  // fallback and leave the token count untouched.
  const record = normalizeRecord(current, 0, now);
  return {
    tokens: record.tokens,
    refillAnchorAt: record.refillAnchorAt,
    waiters: dropExpiredWaiters(record.waiters, now).filter(
      (waiter) => waiter.holderId !== holderId,
    ),
  };
}
