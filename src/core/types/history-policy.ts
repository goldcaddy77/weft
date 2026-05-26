// ---------------------------------------------------------------------------
// History circuit-breaker policy
// ---------------------------------------------------------------------------

/**
 * Operator-configured upper bound on workflow history. Activation rehydrates a
 * workflow by replaying its event log, so cost is O(history); an unbounded log
 * (e.g. a runaway infinite-yield loop) can stall the shared single-process
 * engine for every workflow. `maxEvents` is a safety backstop: once a
 * workflow's durable event-log record count would exceed it, the engine forces
 * the workflow to a terminal `timed-out` state. Pass via
 * {@link EngineOptions.history}.
 *
 * Thresholds are operator config only — there are no baked-in defaults. Omit
 * the policy (or `maxEvents`) to disable the circuit breaker.
 *
 * @example
 * ```ts
 * import { Engine, type HistoryPolicy } from 'weft';
 *
 * const history: HistoryPolicy = { maxEvents: 100_000 };
 * const engine = new Engine({ history });
 * void engine;
 * ```
 */
export interface HistoryPolicy {
  /**
   * Maximum number of event-log records a workflow may accumulate. Exactly
   * `maxEvents` records are allowed; the record that would push the count to
   * `maxEvents + 1` trips the circuit breaker and the workflow is forced to
   * `timed-out`. Must be a positive safe integer. `0`, omitted, or `undefined`
   * disables enforcement.
   */
  maxEvents?: number;
}

/**
 * History policy after validation and normalisation. `maxEvents` is either a
 * positive safe integer (enforcement active) or `null` (disabled). Used
 * internally by the engine; callers configure via {@link HistoryPolicy}.
 */
export interface NormalizedHistoryPolicy {
  maxEvents: number | null;
}

/**
 * Terminal reason recorded on a workflow forced to `timed-out` by the history
 * circuit breaker. Distinguishes circuit-breaker termination from an ordinary
 * deadline timeout (which carries no reason). A single-member union today;
 * widen as additional distinct termination reasons are introduced.
 *
 * @example
 * ```ts
 * import { HISTORY_CIRCUIT_BREAKER_REASON, type TerminationReason } from 'weft';
 *
 * const reason: TerminationReason = HISTORY_CIRCUIT_BREAKER_REASON;
 * void reason;
 * ```
 */
export type TerminationReason = typeof HISTORY_CIRCUIT_BREAKER_REASON;

/**
 * Value written to `WorkflowState.terminationReason` and
 * `WorkflowTimedOutEvent.reason` when the history circuit breaker fires. Compare
 * against it to tell circuit-breaker termination apart from a deadline timeout.
 *
 * @example
 * ```ts
 * import { Engine, HISTORY_CIRCUIT_BREAKER_REASON } from 'weft';
 *
 * const engine = new Engine({ history: { maxEvents: 100_000 } });
 * const state = await engine.get('some-workflow-id');
 * if (state?.terminationReason === HISTORY_CIRCUIT_BREAKER_REASON) {
 *   console.log('terminated by the history circuit breaker');
 * }
 * ```
 */
export const HISTORY_CIRCUIT_BREAKER_REASON = 'history-circuit-breaker';
