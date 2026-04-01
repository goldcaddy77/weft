/**
 * Sliding time window data structures for metric computation.
 *
 * @module alerting/sliding-window
 */

/** Tracks event counts for rate computation (e.g., failure_rate). */
export class CounterWindow {
  #windowMs: number;
  #events: Array<{ timestamp: number; failed: boolean }>;

  constructor(windowMs: number) {
    this.#windowMs = windowMs;
    this.#events = [];
  }

  /** Record an event with its timestamp and failure status. */
  record(timestamp: number, failed: boolean): void {
    this.#events.push({ timestamp, failed });
    this.#prune(timestamp);
  }

  /** Returns failure rate as a number between 0 and 1. Returns 0 if no events. */
  rate(now: number): number {
    this.#prune(now);
    if (this.#events.length === 0) return 0;
    const failures = this.#events.filter((event) => event.failed).length;
    return failures / this.#events.length;
  }

  #prune(now: number): void {
    const cutoff = now - this.#windowMs;
    this.#events = this.#events.filter((event) => event.timestamp >= cutoff);
  }
}

/** Stores individual values for percentile computation (e.g., p99 duration). */
export class HistogramWindow {
  #windowMs: number;
  #observations: Array<{ timestamp: number; value: number }>;

  constructor(windowMs: number) {
    this.#windowMs = windowMs;
    this.#observations = [];
  }

  /** Record an observation with its timestamp. */
  record(timestamp: number, value: number): void {
    this.#observations.push({ timestamp, value });
    this.#prune(timestamp);
  }

  /** Returns the p-th percentile value (p between 0 and 100). Returns 0 if no observations. */
  percentile(p: number, now: number): number {
    this.#prune(now);
    if (this.#observations.length === 0) return 0;
    const sorted = this.#observations.map((observation) => observation.value).toSorted((a, b) => a - b);
    const index = Math.ceil((p / 100) * sorted.length) - 1;
    return sorted[Math.max(0, index)] ?? 0;
  }

  #prune(now: number): void {
    const cutoff = now - this.#windowMs;
    this.#observations = this.#observations.filter(
      (observation) => observation.timestamp >= cutoff,
    );
  }
}
