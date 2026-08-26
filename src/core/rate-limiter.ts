/**
 * A durable token-bucket rate limiter — the sibling of {@link DurableSemaphore}
 * for TEMPO rather than concurrency, built on the same compare-and-swap state
 * slots exposed by `ctx.state.*` and admin {@link AtomicState} handles.
 *
 * The semaphore answers "how many at once"; this answers "how often". The two
 * compose: hold a {@link DurableMutex} while also consuming from a
 * `DurableRateLimiter` and you get "one at a time, and never more than one per
 * interval" — the polite-scraper contract that motivated this primitive (a
 * fleet of workflows that must never burst-fetch one host, where dispatch-level
 * spacing cannot help because dispatch order is not execution order).
 *
 * Like the semaphore, the primitive is non-blocking at the slot level and
 * never reads a clock: `tryAcquire` is one CAS transaction over a
 * {@link RateLimitRecord}, callers pass a deterministic `now` (captured
 * durably, e.g. via a clock activity), and a denied attempt reports
 * `retryAfterMs` to sleep on — `yield* ctx.sleep(retryAfterMs)` inside a
 * workflow, a timer anywhere else. Fairness is FIFO with a twist the semaphore
 * does not need: since a grant CONSUMES a token and nothing is ever released,
 * a crashed contender cannot be reclaimed by lease — so each waiter entry
 * carries its own expiry, refreshed on every retry, and a vanished waiter ages
 * out instead of blocking the queue behind it forever.
 *
 * @module core/rate-limiter
 */

import { mapSlotResult, type AcquireWithSlot, type CasSlot } from './concurrency.ts';
import {
  reduceRateAcquire,
  reduceRateWithdraw,
  type RateGrantAttempt,
  type RateLimitRecord,
} from './rate-limit-record.ts';

export {
  initialRateLimitRecord,
  reduceRateAcquire,
  reduceRateWithdraw,
} from './rate-limit-record.ts';
export type { RateGrantAttempt, RateLimitRecord, RateWaiter } from './rate-limit-record.ts';

/**
 * Options for {@link DurableRateLimiter}.
 *
 * @example
 * ```ts
 * import type { DurableRateLimiterOptions } from '@lostgradient/weft';
 *
 * // "At most one grant every 30 seconds" — capacity 1 is a minimum interval.
 * const minInterval: DurableRateLimiterOptions = { refillIntervalMs: 30_000 };
 * // "At most 10 a minute, in any shape" — capacity is the burst allowance.
 * const burstable: DurableRateLimiterOptions = { capacity: 10, refillIntervalMs: 6_000 };
 * void minInterval;
 * void burstable;
 * ```
 */
export interface DurableRateLimiterOptions {
  /**
   * Bucket capacity — the maximum burst. Defaults to `1`, which makes the
   * limiter a pure minimum interval between grants.
   */
  capacity?: number;
  /** Milliseconds to mint one token. Required: a rate limiter without a rate is a bug. */
  refillIntervalMs: number;
  /**
   * How long a waiter entry survives without a retry refreshing it. Defaults
   * to `4 × refillIntervalMs` (min 30s): generous enough that an honest
   * contender sleeping on `retryAfterMs` always refreshes in time, short
   * enough that a crashed one frees the queue promptly.
   */
  waiterTtlMs?: number;
}

const MIN_WAITER_TTL_MS = 30_000;

function assertPositiveInteger(value: number, label: string): void {
  if (!Number.isInteger(value) || value <= 0) {
    throw new RangeError(`${label} must be a positive integer (got ${String(value)})`);
  }
}

/**
 * A durable token-bucket rate limiter: at most `capacity` grants outstanding
 * per rolling window, refilling one token every `refillIntervalMs`. Built
 * entirely on a single compare-and-swap state slot, so it works inside
 * workflows (via `ctx.state.*`) and from admin code (via {@link AtomicState}),
 * across processes, and survives crashes without a reset.
 *
 * There is no `release`: a grant consumes a token, and time is what gives it
 * back. A contender that gives up before being granted calls
 * {@link DurableRateLimiter.withdraw} so the queue behind it advances
 * immediately instead of waiting out its TTL.
 *
 * @example
 * ```ts
 * import { DurableRateLimiter, AtomicState, initialRateLimitRecord } from '@lostgradient/weft';
 * import { MemoryStorage } from '@lostgradient/weft/storage/memory';
 *
 * const limiter = new DurableRateLimiter({ refillIntervalMs: 30_000 });
 * const slot = new AtomicState(new MemoryStorage(), 'state:rate:example.com', {
 *   initial: initialRateLimitRecord(1, Date.now()),
 * });
 * const attempt = await limiter.tryAcquire(slot, { holderId: 'worker-1', now: Date.now() });
 * if (!attempt.granted) {
 *   // Sleep ~attempt.retryAfterMs, then retry — or withdraw to give up.
 * }
 * ```
 *
 * @example
 * ```ts
 * import { DurableRateLimiter, workflow } from '@lostgradient/weft';
 * import type { RateLimitRecord, WorkflowContext } from '@lostgradient/weft';
 *
 * const polite = workflow({ name: 'polite-fetch' }).execute(async function* (
 *   ctx: WorkflowContext,
 * ) {
 *   const limiter = new DurableRateLimiter({ refillIntervalMs: 30_000 });
 *   const slot = ctx.state.workflow<RateLimitRecord>('example.com:rate');
 *   for (;;) {
 *     const now = yield* ctx.run(() => Date.now());
 *     const attempt = yield* limiter.tryAcquire(slot, { holderId: ctx.workflowId, now });
 *     if (attempt.granted) break;
 *     yield* ctx.sleep(attempt.retryAfterMs);
 *   }
 *   // ...the rate-limited work...
 * });
 * void polite;
 * ```
 */
export class DurableRateLimiter {
  readonly capacity: number;
  readonly refillIntervalMs: number;
  readonly waiterTtlMs: number;

  constructor(options: DurableRateLimiterOptions) {
    const capacity = options.capacity ?? 1;
    const { refillIntervalMs } = options;
    assertPositiveInteger(capacity, 'capacity');
    assertPositiveInteger(refillIntervalMs, 'refillIntervalMs');
    const waiterTtlMs = options.waiterTtlMs ?? Math.max(MIN_WAITER_TTL_MS, 4 * refillIntervalMs);
    assertPositiveInteger(waiterTtlMs, 'waiterTtlMs');
    this.capacity = capacity;
    this.refillIntervalMs = refillIntervalMs;
    this.waiterTtlMs = waiterTtlMs;
  }

  /**
   * Attempt to consume a token with a single CAS transaction. Registers the
   * caller in the FIFO queue on a denied attempt (refreshing its expiry on
   * retry) and reports `retryAfterMs` — the estimated wait for the queue ahead
   * of it plus itself — to sleep on before retrying.
   *
   * `RUpdate` is the slot's `update` return type — a `Promise` for
   * {@link AtomicState} or a workflow-operation generator for `ctx.state.*`.
   */
  tryAcquire<RUpdate>(
    slot: CasSlot<RateLimitRecord, RUpdate>,
    options: { holderId: string; now: number },
  ): AcquireWithSlot<RUpdate, RateGrantAttempt> {
    let attempt: RateGrantAttempt = { granted: false, position: -1, retryAfterMs: 1 };
    const update = slot.update((current) => {
      const reduced = reduceRateAcquire(current, {
        holderId: options.holderId,
        now: options.now,
        capacity: this.capacity,
        refillIntervalMs: this.refillIntervalMs,
        waiterTtlMs: this.waiterTtlMs,
      });
      attempt = reduced.attempt;
      return reduced.record;
    });
    return mapSlotResult(update, () => attempt);
  }

  /**
   * Leave the FIFO queue without a grant, with a single CAS transaction.
   * Idempotent. A contender that times out or is cancelled withdraws so the
   * queue behind it advances immediately rather than waiting out its TTL.
   */
  withdraw<RUpdate>(
    slot: CasSlot<RateLimitRecord, RUpdate>,
    options: { holderId: string; now: number },
  ): RUpdate {
    return slot.update((current) => reduceRateWithdraw(current, options));
  }

  /**
   * Read the current record without mutating it. `RGet` is the slot's `get`
   * return type — a `Promise<RateLimitRecord | undefined>` for
   * {@link AtomicState} or a workflow-operation generator for `ctx.state.*`.
   */
  inspect<RGet>(slot: CasSlot<RateLimitRecord, unknown, RGet>): RGet {
    return slot.get();
  }
}
