import { describe, expect, it } from 'bun:test';

import { MemoryStorage } from '../storage/memory.ts';
import { AtomicState } from './atomic-state.ts';
import {
  DurableRateLimiter,
  initialRateLimitRecord,
  reduceRateAcquire,
  reduceRateWithdraw,
  type RateLimitRecord,
} from './rate-limiter.ts';

const BASE = {
  capacity: 1,
  refillIntervalMs: 30_000,
  waiterTtlMs: 120_000,
};

function makeSlot(initial?: RateLimitRecord): AtomicState<RateLimitRecord> {
  return new AtomicState<RateLimitRecord>(new MemoryStorage(), 'state:test:rate', {
    initial: initial ?? initialRateLimitRecord(1, 0),
  });
}

describe('rate-limit reducers', () => {
  describe('reduceRateAcquire', () => {
    it('grants from a fresh bucket — an undefined record starts full', () => {
      const { record, attempt } = reduceRateAcquire(undefined, {
        ...BASE,
        holderId: 'a',
        now: 1_000,
      });
      expect(attempt).toEqual({ granted: true, position: -1, retryAfterMs: -1 });
      expect(record.tokens).toBe(0);
      expect(record.refillAnchorAt).toBe(1_000);
      expect(record.waiters).toEqual([]);
    });

    it('denies the next contender for a full refill interval — capacity 1 is a minimum interval', () => {
      const first = reduceRateAcquire(undefined, { ...BASE, holderId: 'a', now: 1_000 });
      const second = reduceRateAcquire(first.record, { ...BASE, holderId: 'b', now: 2_000 });
      expect(second.attempt.granted).toBe(false);
      expect(second.attempt.position).toBe(0);
      // One token needed, 1s already accrued toward the 30s interval.
      expect(second.attempt.retryAfterMs).toBe(29_000);
    });

    it('grants again exactly when the interval has elapsed', () => {
      const first = reduceRateAcquire(undefined, { ...BASE, holderId: 'a', now: 1_000 });
      const denied = reduceRateAcquire(first.record, { ...BASE, holderId: 'b', now: 2_000 });
      const granted = reduceRateAcquire(denied.record, { ...BASE, holderId: 'b', now: 31_000 });
      expect(granted.attempt.granted).toBe(true);
      expect(granted.record.waiters).toEqual([]);
    });

    it('is FIFO: a token goes to the head of the queue, not to whoever polls first', () => {
      const drained = reduceRateAcquire(undefined, { ...BASE, holderId: 'a', now: 1_000 });
      const b = reduceRateAcquire(drained.record, { ...BASE, holderId: 'b', now: 2_000 });
      const c = reduceRateAcquire(b.record, { ...BASE, holderId: 'c', now: 3_000 });
      expect(c.attempt.position).toBe(1);
      // The interval elapses; C polls FIRST but B is head of the queue.
      const cRetry = reduceRateAcquire(c.record, { ...BASE, holderId: 'c', now: 31_100 });
      expect(cRetry.attempt.granted).toBe(false);
      expect(cRetry.attempt.position).toBe(1);
      const bRetry = reduceRateAcquire(cRetry.record, { ...BASE, holderId: 'b', now: 31_200 });
      expect(bRetry.attempt.granted).toBe(true);
    });

    it('does not double-enqueue a waiter that retries, and refreshes its expiry', () => {
      const drained = reduceRateAcquire(undefined, { ...BASE, holderId: 'a', now: 1_000 });
      const first = reduceRateAcquire(drained.record, { ...BASE, holderId: 'b', now: 2_000 });
      const retry = reduceRateAcquire(first.record, { ...BASE, holderId: 'b', now: 10_000 });
      expect(retry.record.waiters).toHaveLength(1);
      expect(retry.record.waiters[0]).toEqual({ holderId: 'b', expiresAt: 130_000 });
    });

    it('ages out a crashed waiter so the queue behind it advances', () => {
      const drained = reduceRateAcquire(undefined, { ...BASE, holderId: 'a', now: 1_000 });
      const dead = reduceRateAcquire(drained.record, { ...BASE, holderId: 'dead', now: 2_000 });
      const c = reduceRateAcquire(dead.record, { ...BASE, holderId: 'c', now: 3_000 });
      expect(c.attempt.position).toBe(1);
      // 'dead' never retries; its TTL (2_000 + 120_000) passes. C reaches the head.
      const later = reduceRateAcquire(c.record, { ...BASE, holderId: 'c', now: 123_000 });
      expect(later.attempt.granted).toBe(true);
    });

    it('accrues multiple tokens across a long idle gap, capped at capacity', () => {
      const options = { capacity: 3, refillIntervalMs: 10_000, waiterTtlMs: 120_000 };
      const drained: RateLimitRecord = { tokens: 0, refillAnchorAt: 0, waiters: [] };
      // 25s → 2 whole tokens, anchor advances by exactly 2 intervals.
      const partial = reduceRateAcquire(drained, { ...options, holderId: 'a', now: 25_000 });
      expect(partial.attempt.granted).toBe(true);
      expect(partial.record.tokens).toBe(1);
      expect(partial.record.refillAnchorAt).toBe(20_000);
      // A week idle mints only up to capacity — never a retroactive burst.
      const idle = reduceRateAcquire(partial.record, {
        ...options,
        holderId: 'b',
        now: 700_000_000,
      });
      expect(idle.record.tokens).toBe(2);
      expect(idle.record.refillAnchorAt).toBe(700_000_000);
    });

    it('keeps sub-interval accrual across reductions — the anchor never loses progress', () => {
      const drained = reduceRateAcquire(undefined, { ...BASE, holderId: 'a', now: 0 });
      // 29s in: denied, 1s to go.
      const late = reduceRateAcquire(drained.record, { ...BASE, holderId: 'b', now: 29_000 });
      expect(late.attempt.retryAfterMs).toBe(1_000);
    });

    it('estimates retryAfterMs for a deep queue as the wait for everyone ahead plus itself', () => {
      const drained = reduceRateAcquire(undefined, { ...BASE, holderId: 'a', now: 0 });
      const b = reduceRateAcquire(drained.record, { ...BASE, holderId: 'b', now: 0 });
      const c = reduceRateAcquire(b.record, { ...BASE, holderId: 'c', now: 0 });
      // C is position 1: two tokens must mint, none accrued yet.
      expect(c.attempt.retryAfterMs).toBe(60_000);
    });
  });

  describe('reduceRateWithdraw', () => {
    it('removes the withdrawing waiter so the queue behind it advances immediately', () => {
      const drained = reduceRateAcquire(undefined, { ...BASE, holderId: 'a', now: 1_000 });
      const b = reduceRateAcquire(drained.record, { ...BASE, holderId: 'b', now: 2_000 });
      const c = reduceRateAcquire(b.record, { ...BASE, holderId: 'c', now: 3_000 });
      const withdrawn = reduceRateWithdraw(c.record, { holderId: 'b', now: 4_000 });
      expect(withdrawn.waiters.map((waiter) => waiter.holderId)).toEqual(['c']);
      const granted = reduceRateAcquire(withdrawn, { ...BASE, holderId: 'c', now: 31_100 });
      expect(granted.attempt.granted).toBe(true);
    });

    it('is idempotent for a holder that never enqueued', () => {
      const record: RateLimitRecord = { tokens: 1, refillAnchorAt: 1_000, waiters: [] };
      expect(reduceRateWithdraw(record, { holderId: 'ghost', now: 2_000 })).toEqual(record);
    });
  });
});

describe('DurableRateLimiter over an AtomicState slot', () => {
  it('grants, denies with a retry estimate, and grants again after the interval', async () => {
    const limiter = new DurableRateLimiter({ refillIntervalMs: 30_000 });
    const slot = makeSlot();

    const first = await limiter.tryAcquire(slot, { holderId: 'a', now: 1_000 });
    expect(first.granted).toBe(true);

    const denied = await limiter.tryAcquire(slot, { holderId: 'b', now: 2_000 });
    expect(denied.granted).toBe(false);
    expect(denied.retryAfterMs).toBe(29_000);

    const granted = await limiter.tryAcquire(slot, { holderId: 'b', now: 31_000 });
    expect(granted.granted).toBe(true);
  });

  it('withdraw lets the queue advance without waiting out the TTL', async () => {
    const limiter = new DurableRateLimiter({ refillIntervalMs: 30_000 });
    const slot = makeSlot();
    await limiter.tryAcquire(slot, { holderId: 'a', now: 1_000 });
    await limiter.tryAcquire(slot, { holderId: 'b', now: 2_000 });
    await limiter.tryAcquire(slot, { holderId: 'c', now: 3_000 });
    await limiter.withdraw(slot, { holderId: 'b', now: 4_000 });
    const attempt = await limiter.tryAcquire(slot, { holderId: 'c', now: 31_100 });
    expect(attempt.granted).toBe(true);
  });

  it('inspect reads the record without mutating it', async () => {
    const limiter = new DurableRateLimiter({ refillIntervalMs: 30_000 });
    const slot = makeSlot();
    await limiter.tryAcquire(slot, { holderId: 'a', now: 1_000 });
    const record = await limiter.inspect(slot);
    expect(record?.tokens).toBe(0);
    expect(record?.waiters).toEqual([]);
  });

  it('rejects a zero or negative refill interval at construction', () => {
    expect(() => new DurableRateLimiter({ refillIntervalMs: 0 })).toThrow(RangeError);
    expect(() => new DurableRateLimiter({ refillIntervalMs: -5 })).toThrow(RangeError);
    expect(() => new DurableRateLimiter({ refillIntervalMs: 1_000, capacity: 0 })).toThrow(
      RangeError,
    );
  });

  it('defaults the waiter TTL to at least 30s even for tiny intervals', () => {
    const limiter = new DurableRateLimiter({ refillIntervalMs: 100 });
    expect(limiter.waiterTtlMs).toBe(30_000);
  });
});
