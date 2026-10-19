/**
 * Thrown by a timer callback to say "this timer is due but its consumer is not
 * ready yet; keep it durable and try again later". The scheduler treats it as
 * an expected, quiet condition: one log line per timer (no stack), and a
 * bounded backoff instead of a retry on every poll tick (HAPS-687).
 */
export class TimerDeferredError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TimerDeferredError';
  }
}

export function isTimerDeferredError(error: unknown): error is TimerDeferredError {
  return error instanceof TimerDeferredError;
}

/** Ceiling for the per-timer deferral backoff. */
export const MAX_TIMER_DEFERRAL_BACKOFF_MS = 30_000;

export type TimerDeferral = {
  /** Consecutive deferrals for this timer; drives the exponential backoff. */
  attempts: number;
  /** Earliest scheduler time at which the timer callback runs again. */
  retryAt: number;
};

/**
 * Backoff before re-firing a deferred timer: one poll interval, doubling per
 * consecutive deferral, capped at {@link MAX_TIMER_DEFERRAL_BACKOFF_MS}.
 */
export function timerDeferralBackoffMs(pollIntervalMs: number, attempts: number): number {
  const exponent = Math.min(Math.max(attempts - 1, 0), 30);
  return Math.min(Math.max(pollIntervalMs, 1) * 2 ** exponent, MAX_TIMER_DEFERRAL_BACKOFF_MS);
}
