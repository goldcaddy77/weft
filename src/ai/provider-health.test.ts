import { describe, expect, it } from 'bun:test';

import { AgentProviderCircuitOpenEvent } from './events.ts';
import {
  ProviderHealthTracker,
  type CircuitState,
  type ProviderHealthOptions,
} from './provider-health.ts';

function createTracker(overrides?: ProviderHealthOptions): ProviderHealthTracker {
  let now = 0;
  return new ProviderHealthTracker({
    windowDuration: 60_000,
    errorThreshold: 0.5,
    cooldownDuration: 30_000,
    minimumRequests: 5,
    getNow: () => now,
    ...overrides,
  });
}

/** Create a tracker with a controllable clock. */
function createTrackerWithClock(overrides?: Partial<ProviderHealthOptions>) {
  let now = 0;
  const tracker = new ProviderHealthTracker({
    windowDuration: 60_000,
    errorThreshold: 0.5,
    cooldownDuration: 30_000,
    minimumRequests: 5,
    getNow: () => now,
    ...overrides,
  });
  return {
    tracker,
    advance(ms: number) {
      now += ms;
    },
    setTime(ms: number) {
      now = ms;
    },
  };
}

describe('ProviderHealthTracker', () => {
  describe('new provider starts as closed and healthy', () => {
    it('returns closed state and healthy for an unknown provider', () => {
      const tracker = createTracker();

      expect(tracker.getState('openai')).toBe('closed');
      expect(tracker.isHealthy('openai')).toBe(true);
    });
  });

  describe('successes keep provider healthy', () => {
    it('remains closed after many successes', () => {
      const tracker = createTracker();

      for (let i = 0; i < 20; i++) {
        tracker.recordSuccess('openai');
      }

      expect(tracker.getState('openai')).toBe('closed');
      expect(tracker.isHealthy('openai')).toBe(true);
      expect(tracker.getErrorRate('openai')).toBe(0);
    });
  });

  describe('failures increase error rate', () => {
    it('computes the correct error rate from mixed results', () => {
      const tracker = createTracker({ minimumRequests: 1 });

      tracker.recordSuccess('openai');
      tracker.recordFailure('openai');
      tracker.recordSuccess('openai');
      tracker.recordFailure('openai');

      // 2 failures out of 4 total = 0.5
      expect(tracker.getErrorRate('openai')).toBe(0.5);
    });
  });

  describe('circuit opens when threshold exceeded and minimum requests met', () => {
    it('transitions to open when error rate exceeds threshold', () => {
      const tracker = createTracker({
        minimumRequests: 5,
        errorThreshold: 0.5,
      });

      // Record 5 requests: 3 failures, 2 successes = 60% error rate > 50% threshold
      tracker.recordSuccess('openai');
      tracker.recordSuccess('openai');
      tracker.recordFailure('openai');
      tracker.recordFailure('openai');
      tracker.recordFailure('openai'); // 5th request, error rate = 3/5 = 0.6

      expect(tracker.getState('openai')).toBe('open');
    });
  });

  describe('provider is unhealthy when circuit is open', () => {
    it('reports unhealthy for an open circuit', () => {
      const tracker = createTracker({
        minimumRequests: 5,
        errorThreshold: 0.5,
      });

      // Trip the circuit
      tracker.recordSuccess('openai');
      tracker.recordSuccess('openai');
      tracker.recordFailure('openai');
      tracker.recordFailure('openai');
      tracker.recordFailure('openai');

      expect(tracker.isHealthy('openai')).toBe(false);
    });
  });

  describe('circuit transitions to half-open after cooldown', () => {
    it('moves from open to half-open once cooldown elapses', () => {
      const { tracker, advance } = createTrackerWithClock({
        minimumRequests: 5,
        errorThreshold: 0.5,
        cooldownDuration: 30_000,
      });

      // Trip the circuit
      tracker.recordSuccess('openai');
      tracker.recordSuccess('openai');
      tracker.recordFailure('openai');
      tracker.recordFailure('openai');
      tracker.recordFailure('openai');

      expect(tracker.getState('openai')).toBe('open');

      // Advance past the cooldown
      advance(30_001);

      expect(tracker.getState('openai')).toBe('half-open');
      expect(tracker.isHealthy('openai')).toBe(true);
    });
  });

  describe('success in half-open closes circuit', () => {
    it('transitions from half-open to closed on success', () => {
      const { tracker, advance } = createTrackerWithClock({
        minimumRequests: 5,
        errorThreshold: 0.5,
        cooldownDuration: 30_000,
      });

      // Trip the circuit
      tracker.recordSuccess('openai');
      tracker.recordSuccess('openai');
      tracker.recordFailure('openai');
      tracker.recordFailure('openai');
      tracker.recordFailure('openai');

      // Wait for cooldown
      advance(30_001);
      expect(tracker.getState('openai')).toBe('half-open');

      // Succeed in half-open
      tracker.recordSuccess('openai');

      expect(tracker.getState('openai')).toBe('closed');
      expect(tracker.isHealthy('openai')).toBe(true);
    });
  });

  describe('failure in half-open reopens circuit', () => {
    it('transitions from half-open back to open on failure', () => {
      const { tracker, advance } = createTrackerWithClock({
        minimumRequests: 5,
        errorThreshold: 0.5,
        cooldownDuration: 30_000,
      });

      // Trip the circuit
      tracker.recordSuccess('openai');
      tracker.recordSuccess('openai');
      tracker.recordFailure('openai');
      tracker.recordFailure('openai');
      tracker.recordFailure('openai');

      // Wait for cooldown
      advance(30_001);
      expect(tracker.getState('openai')).toBe('half-open');

      // Fail in half-open
      tracker.recordFailure('openai');

      expect(tracker.getState('openai')).toBe('open');
      expect(tracker.isHealthy('openai')).toBe(false);
    });

    it('resets the cooldown timer after reopening', () => {
      const { tracker, advance } = createTrackerWithClock({
        minimumRequests: 5,
        errorThreshold: 0.5,
        cooldownDuration: 30_000,
      });

      // Trip the circuit
      tracker.recordSuccess('openai');
      tracker.recordSuccess('openai');
      tracker.recordFailure('openai');
      tracker.recordFailure('openai');
      tracker.recordFailure('openai');

      // Wait for cooldown
      advance(30_001);
      expect(tracker.getState('openai')).toBe('half-open');

      // Fail in half-open -> back to open
      tracker.recordFailure('openai');
      expect(tracker.getState('openai')).toBe('open');

      // Need to wait another full cooldown
      advance(29_999);
      expect(tracker.getState('openai')).toBe('open');

      advance(2);
      expect(tracker.getState('openai')).toBe('half-open');
    });
  });

  describe('error rate calculation is correct', () => {
    it('returns 0 when no requests recorded', () => {
      const tracker = createTracker();

      expect(tracker.getErrorRate('openai')).toBe(0);
    });

    it('returns 1 when all requests fail', () => {
      const tracker = createTracker();

      for (let i = 0; i < 10; i++) {
        tracker.recordFailure('openai');
      }

      expect(tracker.getErrorRate('openai')).toBe(1);
    });

    it('returns 0 when all requests succeed', () => {
      const tracker = createTracker();

      for (let i = 0; i < 10; i++) {
        tracker.recordSuccess('openai');
      }

      expect(tracker.getErrorRate('openai')).toBe(0);
    });

    it('computes correctly with mixed results', () => {
      const tracker = createTracker();

      // 3 successes, 7 failures = 0.7
      for (let i = 0; i < 3; i++) tracker.recordSuccess('openai');
      for (let i = 0; i < 7; i++) tracker.recordFailure('openai');

      expect(tracker.getErrorRate('openai')).toBeCloseTo(0.7, 10);
    });
  });

  describe('sliding window drops old entries', () => {
    it('excludes entries outside the window from error rate', () => {
      const { tracker, advance } = createTrackerWithClock({
        windowDuration: 60_000,
        minimumRequests: 1,
        errorThreshold: 0.9, // High threshold so circuit doesn't trip
      });

      // Record 5 failures at time 0
      for (let i = 0; i < 5; i++) {
        tracker.recordFailure('openai');
      }

      expect(tracker.getErrorRate('openai')).toBe(1);

      // Advance past the window
      advance(60_001);

      // Record 5 successes
      for (let i = 0; i < 5; i++) {
        tracker.recordSuccess('openai');
      }

      // Old failures should be dropped; only the 5 successes remain
      expect(tracker.getErrorRate('openai')).toBe(0);
    });

    it('partially drops entries as they age out', () => {
      const { tracker, advance } = createTrackerWithClock({
        windowDuration: 10_000,
        minimumRequests: 1,
        errorThreshold: 0.9, // High threshold so circuit doesn't trip
      });

      // Record 2 failures at time 0
      tracker.recordFailure('openai');
      tracker.recordFailure('openai');

      // Advance to time 5000 and record 2 successes
      advance(5_000);
      tracker.recordSuccess('openai');
      tracker.recordSuccess('openai');

      // At time 5000: 2 failures + 2 successes = 50% error rate
      expect(tracker.getErrorRate('openai')).toBe(0.5);

      // Advance to time 10001 — the original failures fall outside the window
      advance(5_001);

      // Only the 2 successes from time 5000 remain
      expect(tracker.getErrorRate('openai')).toBe(0);
    });
  });

  describe('minimum requests prevents premature tripping', () => {
    it('does not trip circuit when below minimum requests', () => {
      const tracker = createTracker({
        minimumRequests: 5,
        errorThreshold: 0.5,
      });

      // 4 requests, all failures = 100% error rate, but under minimum
      for (let i = 0; i < 4; i++) {
        tracker.recordFailure('openai');
      }

      expect(tracker.getErrorRate('openai')).toBe(1);
      expect(tracker.getState('openai')).toBe('closed');
      expect(tracker.isHealthy('openai')).toBe(true);
    });

    it('trips circuit once minimum requests reached', () => {
      const tracker = createTracker({
        minimumRequests: 5,
        errorThreshold: 0.5,
      });

      // 5 failures = 100% error rate, meets minimum
      for (let i = 0; i < 5; i++) {
        tracker.recordFailure('openai');
      }

      expect(tracker.getState('openai')).toBe('open');
    });
  });

  describe('onStateChange callback fires on transitions', () => {
    it('fires when circuit opens', () => {
      const transitions: Array<{ provider: string; from: CircuitState; to: CircuitState }> = [];
      const tracker = createTracker({
        minimumRequests: 5,
        errorThreshold: 0.5,
      });
      tracker.onStateChange = (provider, from, to) => {
        transitions.push({ provider, from, to });
      };

      // Trip the circuit
      tracker.recordSuccess('openai');
      tracker.recordSuccess('openai');
      tracker.recordFailure('openai');
      tracker.recordFailure('openai');
      tracker.recordFailure('openai');

      expect(transitions).toHaveLength(1);
      expect(transitions[0]).toEqual({
        provider: 'openai',
        from: 'closed',
        to: 'open',
      });
    });

    it('fires when circuit transitions through half-open to closed', () => {
      const transitions: Array<{ provider: string; from: CircuitState; to: CircuitState }> = [];
      const { tracker, advance } = createTrackerWithClock({
        minimumRequests: 5,
        errorThreshold: 0.5,
        cooldownDuration: 30_000,
      });
      tracker.onStateChange = (provider, from, to) => {
        transitions.push({ provider, from, to });
      };

      // Trip the circuit
      tracker.recordSuccess('openai');
      tracker.recordSuccess('openai');
      tracker.recordFailure('openai');
      tracker.recordFailure('openai');
      tracker.recordFailure('openai');

      // Wait for cooldown, then query state to trigger half-open
      advance(30_001);
      tracker.getState('openai');

      // Succeed to close
      tracker.recordSuccess('openai');

      expect(transitions).toHaveLength(3);
      expect(transitions[0]).toEqual({ provider: 'openai', from: 'closed', to: 'open' });
      expect(transitions[1]).toEqual({ provider: 'openai', from: 'open', to: 'half-open' });
      expect(transitions[2]).toEqual({ provider: 'openai', from: 'half-open', to: 'closed' });
    });

    it('fires when circuit transitions from half-open back to open', () => {
      const transitions: Array<{ provider: string; from: CircuitState; to: CircuitState }> = [];
      const { tracker, advance } = createTrackerWithClock({
        minimumRequests: 5,
        errorThreshold: 0.5,
        cooldownDuration: 30_000,
      });
      tracker.onStateChange = (provider, from, to) => {
        transitions.push({ provider, from, to });
      };

      // Trip the circuit
      tracker.recordSuccess('openai');
      tracker.recordSuccess('openai');
      tracker.recordFailure('openai');
      tracker.recordFailure('openai');
      tracker.recordFailure('openai');

      // Wait for cooldown, then query state to trigger half-open
      advance(30_001);
      tracker.getState('openai');

      // Fail to reopen
      tracker.recordFailure('openai');

      expect(transitions).toHaveLength(3);
      expect(transitions[0]).toEqual({ provider: 'openai', from: 'closed', to: 'open' });
      expect(transitions[1]).toEqual({ provider: 'openai', from: 'open', to: 'half-open' });
      expect(transitions[2]).toEqual({ provider: 'openai', from: 'half-open', to: 'open' });
    });
  });

  describe('entries array is pruned to stay bounded', () => {
    it('drops expired entries from the backing array during recordSuccess', () => {
      const { tracker, advance } = createTrackerWithClock({
        windowDuration: 10_000,
        minimumRequests: 5,
        errorThreshold: 0.9, // High enough that the circuit will not trip.
      });

      // Record 100 successes at time 0.
      for (let i = 0; i < 100; i++) {
        tracker.recordSuccess('openai');
      }
      expect(tracker.getEntryCount('openai')).toBe(100);

      // Advance well past the window, then record one more success.
      advance(11_000);
      tracker.recordSuccess('openai');

      // All 100 prior entries should have been pruned; only the fresh one
      // remains in the backing array.
      expect(tracker.getEntryCount('openai')).toBe(1);
    });

    it('drops expired entries from the backing array during recordFailure', () => {
      const { tracker, advance } = createTrackerWithClock({
        windowDuration: 10_000,
        minimumRequests: 5,
        errorThreshold: 0.9,
      });

      for (let i = 0; i < 50; i++) {
        tracker.recordFailure('openai');
      }
      expect(tracker.getEntryCount('openai')).toBe(50);

      advance(11_000);
      tracker.recordFailure('openai');

      expect(tracker.getEntryCount('openai')).toBe(1);
    });

    it('keeps the entries array bounded across many recordings over time', () => {
      const { tracker, advance } = createTrackerWithClock({
        windowDuration: 10_000,
        minimumRequests: 5,
        errorThreshold: 0.9,
      });

      // Simulate a provider that stays healthy for a long time. Without
      // pruning, `entries` would grow to 10 000 items.
      const batches = 10;
      const perBatch = 1000;
      for (let batch = 0; batch < batches; batch++) {
        for (let i = 0; i < perBatch; i++) {
          tracker.recordSuccess('openai');
        }
        // Advance just past the window so the next batch prunes the previous.
        advance(11_000);
      }

      // After the last advance, the final batch was never pruned (no writes
      // happened post-advance), so the bound is `perBatch`. One more write
      // should trigger pruning and collapse the array to a single entry.
      expect(tracker.getEntryCount('openai')).toBeLessThanOrEqual(perBatch);

      tracker.recordSuccess('openai');
      expect(tracker.getEntryCount('openai')).toBe(1);
    });

    it('keeps in-window entries during pruning', () => {
      const { tracker, advance } = createTrackerWithClock({
        windowDuration: 10_000,
        minimumRequests: 5,
        errorThreshold: 0.9,
      });

      // Record 5 entries at time 0.
      for (let i = 0; i < 5; i++) {
        tracker.recordSuccess('openai');
      }

      // Advance only halfway through the window and record 5 more.
      advance(5_000);
      for (let i = 0; i < 5; i++) {
        tracker.recordSuccess('openai');
      }

      // All 10 entries should still be present — none are expired.
      expect(tracker.getEntryCount('openai')).toBe(10);

      // Advance past the time-0 entries' expiry, then record one more.
      // The first 5 should prune, leaving 5 + 1 = 6.
      advance(6_000);
      tracker.recordSuccess('openai');
      expect(tracker.getEntryCount('openai')).toBe(6);
    });
  });

  describe('unknown provider defaults to healthy', () => {
    it('treats never-seen providers as healthy and closed', () => {
      const tracker = createTracker();

      expect(tracker.isHealthy('never-seen-provider')).toBe(true);
      expect(tracker.getState('never-seen-provider')).toBe('closed');
      expect(tracker.getErrorRate('never-seen-provider')).toBe(0);
    });
  });

  describe('independent tracking per provider', () => {
    it('tracks multiple providers independently', () => {
      const tracker = createTracker({
        minimumRequests: 3,
        errorThreshold: 0.5,
      });

      // Fail openai
      tracker.recordFailure('openai');
      tracker.recordFailure('openai');
      tracker.recordFailure('openai');

      // Succeed anthropic
      tracker.recordSuccess('anthropic');
      tracker.recordSuccess('anthropic');
      tracker.recordSuccess('anthropic');

      expect(tracker.getState('openai')).toBe('open');
      expect(tracker.getState('anthropic')).toBe('closed');
      expect(tracker.isHealthy('openai')).toBe(false);
      expect(tracker.isHealthy('anthropic')).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // D6: AgentProviderCircuitOpenEvent dispatched when circuit opens
  // -------------------------------------------------------------------------

  describe('eventTarget dispatch on circuit open', () => {
    it('dispatches AgentProviderCircuitOpenEvent when circuit trips', () => {
      const circuitEvents: AgentProviderCircuitOpenEvent[] = [];
      const eventTarget = new EventTarget();

      eventTarget.addEventListener(AgentProviderCircuitOpenEvent.type, ((
        event: AgentProviderCircuitOpenEvent,
      ) => {
        circuitEvents.push(event);
      }) as EventListener);

      const tracker = new ProviderHealthTracker({
        windowDuration: 60_000,
        errorThreshold: 0.5,
        cooldownDuration: 30_000,
        minimumRequests: 5,
        getNow: () => 0,
      });

      tracker.eventTarget = eventTarget;

      // Trip the circuit: 5 failures
      for (let i = 0; i < 5; i++) {
        tracker.recordFailure('openai');
      }

      expect(tracker.getState('openai')).toBe('open');
      expect(circuitEvents).toHaveLength(1);
      expect(circuitEvents[0]!.provider).toBe('openai');
      expect(circuitEvents[0]!.errorRate).toBeGreaterThan(0.5);
      expect(circuitEvents[0]!.threshold).toBe(0.5);
    });

    it('does not dispatch event when circuit stays closed', () => {
      const circuitEvents: AgentProviderCircuitOpenEvent[] = [];
      const eventTarget = new EventTarget();

      eventTarget.addEventListener(AgentProviderCircuitOpenEvent.type, ((
        event: AgentProviderCircuitOpenEvent,
      ) => {
        circuitEvents.push(event);
      }) as EventListener);

      const tracker = new ProviderHealthTracker({
        windowDuration: 60_000,
        errorThreshold: 0.5,
        cooldownDuration: 30_000,
        minimumRequests: 5,
        getNow: () => 0,
      });

      tracker.eventTarget = eventTarget;

      // Only successes — no trip
      for (let i = 0; i < 10; i++) {
        tracker.recordSuccess('openai');
      }

      expect(circuitEvents).toHaveLength(0);
    });

    it('excludes open circuit provider from subsequent isHealthy checks', () => {
      const tracker = new ProviderHealthTracker({
        windowDuration: 60_000,
        errorThreshold: 0.5,
        cooldownDuration: 30_000,
        minimumRequests: 3,
        getNow: () => 0,
      });

      // Trip the circuit
      tracker.recordFailure('openai');
      tracker.recordFailure('openai');
      tracker.recordFailure('openai');

      expect(tracker.isHealthy('openai')).toBe(false);
      expect(tracker.isHealthy('anthropic')).toBe(true);
    });
  });
});
