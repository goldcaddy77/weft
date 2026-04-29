/**
 * Provider error rate tracking with circuit breaker pattern.
 *
 * Tracks success/failure rates per provider using a sliding time window
 * and implements a circuit breaker that trips when the error rate
 * exceeds a configurable threshold.
 *
 * @module provider-health
 */

import { AgentProviderCircuitOpenEvent } from './events.ts';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type CircuitState = 'closed' | 'open' | 'half-open';

export interface ProviderHealthOptions {
  /** Sliding window duration in ms. Defaults to 60 000 (1 minute). */
  windowDuration?: number | undefined;
  /** Error rate (0-1) at which the circuit trips. Defaults to 0.5. */
  errorThreshold?: number | undefined;
  /** Time in ms the circuit stays open before probing. Defaults to 30 000. */
  cooldownDuration?: number | undefined;
  /** Minimum requests in the window before the circuit can trip. Defaults to 5. */
  minimumRequests?: number | undefined;
  /** Clock function for testing. Defaults to `Date.now`. */
  getNow?: (() => number) | undefined;
}

/** Fully resolved options with no optional or undefined fields. */
interface ResolvedProviderHealthOptions {
  windowDuration: number;
  errorThreshold: number;
  cooldownDuration: number;
  minimumRequests: number;
  getNow: () => number;
}

// ---------------------------------------------------------------------------
// Internal state
// ---------------------------------------------------------------------------

interface RequestEntry {
  timestamp: number;
  success: boolean;
}

interface ProviderState {
  entries: RequestEntry[];
  circuit: CircuitState;
  /** Timestamp when the circuit transitioned to open. */
  openedAt: number;
}

// ---------------------------------------------------------------------------
// ProviderHealthTracker
// ---------------------------------------------------------------------------

/**
 * Implements a sliding-window circuit breaker for LLM providers. Records
 * successes and failures per provider name, trips the circuit to `'open'` when
 * the error rate within the window exceeds the configured threshold, and
 * re-probes after a cooldown period. Dispatches {@link AgentProviderCircuitOpenEvent}
 * on state transitions when an `eventTarget` is set.
 *
 * @example Track provider health and receive circuit-open notifications
 * ```ts
 * import { ProviderHealthTracker } from 'weft';
 *
 * const tracker = new ProviderHealthTracker({
 *   errorThreshold: 0.5,
 *   minimumRequests: 5,
 *   windowDuration: 60_000,
 *   cooldownDuration: 30_000,
 * });
 * tracker.eventTarget = new EventTarget();
 *
 * tracker.recordFailure('anthropic');
 * tracker.recordSuccess('anthropic');
 * console.log(tracker.getState('anthropic')); // 'closed' or 'open'
 * ```
 */
export class ProviderHealthTracker {
  #providers: Map<string, ProviderState>;
  #options: ResolvedProviderHealthOptions;

  /** Optional callback fired whenever a provider's circuit state changes. */
  onStateChange?: ((provider: string, from: CircuitState, to: CircuitState) => void) | undefined;

  /** Optional EventTarget for dispatching circuit open events. */
  eventTarget?: EventTarget | undefined;

  constructor(options?: ProviderHealthOptions) {
    this.#providers = new Map();
    this.#options = {
      windowDuration: options?.windowDuration ?? 60_000,
      errorThreshold: options?.errorThreshold ?? 0.5,
      cooldownDuration: options?.cooldownDuration ?? 30_000,
      minimumRequests: options?.minimumRequests ?? 5,
      getNow: options?.getNow ?? Date.now,
    };
  }

  // -----------------------------------------------------------------------
  // Public API
  // -----------------------------------------------------------------------

  /** Record a successful call to a provider. */
  recordSuccess(provider: string): void {
    const state = this.#ensureProvider(provider);

    // Half-open: a single success closes the circuit.
    if (state.circuit === 'half-open') {
      this.#transition(provider, state, 'closed');
      // Reset the window — the provider proved itself healthy.
      state.entries = [];
      return;
    }

    state.entries.push({ timestamp: this.#now(), success: true });
    this.#prune(state);
  }

  /** Record a failed call to a provider. */
  recordFailure(provider: string): void {
    const state = this.#ensureProvider(provider);

    // Half-open: a single failure reopens the circuit.
    if (state.circuit === 'half-open') {
      state.openedAt = this.#now();
      this.#transition(provider, state, 'open');
      state.entries = [];
      return;
    }

    state.entries.push({ timestamp: this.#now(), success: false });
    this.#prune(state);

    // Evaluate whether to trip the circuit (only in closed state).
    if (state.circuit === 'closed') {
      this.#evaluate(provider, state);
    }
  }

  /** Check if a provider is healthy (circuit is closed or half-open). */
  isHealthy(provider: string): boolean {
    const circuit = this.getState(provider);
    return circuit !== 'open';
  }

  /** Get the circuit state for a provider. */
  getState(provider: string): CircuitState {
    const state = this.#providers.get(provider);
    if (!state) {
      return 'closed';
    }

    // Check whether an open circuit should transition to half-open.
    if (state.circuit === 'open') {
      const elapsed = this.#now() - state.openedAt;
      if (elapsed > this.#options.cooldownDuration) {
        this.#transition(provider, state, 'half-open');
      }
    }

    return state.circuit;
  }

  /**
   * Return the backing array size for a provider. This exists solely so
   * tests can verify that `#prune` actually trims expired entries — pruning
   * is a memory optimisation with no behavioural fingerprint (`#windowEntries`
   * already filters at read time), so the backing array length is the only
   * observable signal for the fix. Do not use in production code.
   *
   * @internal
   */
  getEntryCount(provider: string): number {
    const state = this.#providers.get(provider);
    return state?.entries.length ?? 0;
  }

  /** Get the current error rate for a provider within the sliding window. */
  getErrorRate(provider: string): number {
    const state = this.#providers.get(provider);
    if (!state) {
      return 0;
    }

    const windowEntries = this.#windowEntries(state);
    if (windowEntries.length === 0) {
      return 0;
    }

    const failures = windowEntries.filter((entry) => !entry.success).length;
    return failures / windowEntries.length;
  }

  // -----------------------------------------------------------------------
  // Private helpers
  // -----------------------------------------------------------------------

  #now(): number {
    return this.#options.getNow();
  }

  #ensureProvider(provider: string): ProviderState {
    let state = this.#providers.get(provider);
    if (!state) {
      state = {
        entries: [],
        circuit: 'closed',
        openedAt: 0,
      };
      this.#providers.set(provider, state);
    }
    return state;
  }

  /** Return entries within the current sliding window. */
  #windowEntries(state: ProviderState): RequestEntry[] {
    const cutoff = this.#now() - this.#options.windowDuration;
    return state.entries.filter((entry) => entry.timestamp > cutoff);
  }

  /**
   * Drop expired entries from the backing array to prevent unbounded growth.
   *
   * `#windowEntries` filters for reads but never mutates the underlying array,
   * so without this the entries array would grow indefinitely for a provider
   * that stays in the closed state.
   */
  #prune(state: ProviderState): void {
    const cutoff = this.#now() - this.#options.windowDuration;
    // Fast path: nothing expired at the head of the array.
    if (state.entries.length === 0 || state.entries[0]!.timestamp > cutoff) {
      return;
    }
    state.entries = state.entries.filter((entry) => entry.timestamp > cutoff);
  }

  /** Evaluate whether the circuit should trip from closed to open. */
  #evaluate(provider: string, state: ProviderState): void {
    const windowEntries = this.#windowEntries(state);
    if (windowEntries.length < this.#options.minimumRequests) {
      return;
    }

    const failures = windowEntries.filter((entry) => !entry.success).length;
    const errorRate = failures / windowEntries.length;

    if (errorRate > this.#options.errorThreshold) {
      // Set openedAt before transition so getErrorRate() inside #transition
      // sees the fresh timestamp and doesn't re-transition to half-open.
      state.openedAt = this.#now();
      this.#transition(provider, state, 'open');
    }
  }

  /** Transition a provider's circuit to a new state, firing the callback. */
  #transition(provider: string, state: ProviderState, to: CircuitState): void {
    const from = state.circuit;
    state.circuit = to;
    this.onStateChange?.(provider, from, to);

    // Dispatch circuit-open event when transitioning to open
    if (to === 'open' && this.eventTarget) {
      const errorRate = this.getErrorRate(provider);
      this.eventTarget.dispatchEvent(
        new AgentProviderCircuitOpenEvent(
          provider,
          errorRate,
          this.#options.errorThreshold,
          this.#options.windowDuration,
        ),
      );
    }
  }
}
