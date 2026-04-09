/**
 * Workflow constraint primitive.
 *
 * Constraints are domain invariants registered alongside a workflow. The
 * engine evaluates them at every checkpoint commit. When a constraint's
 * `check` function returns `false`, the engine dispatches a
 * {@link ConstraintViolatedEvent} and reacts according to `onViolation`:
 *
 * - `'fail'`       — throws immediately, failing the workflow.
 * - `'compensate'` — throws into the generator so an active `ctx.saga()`
 *                    can run its compensators before the error propagates.
 * - `'warn'`       — logs a warning and continues execution.
 *
 * @module core/constraint
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ConstraintViolation = 'compensate' | 'fail' | 'warn';

/**
 * The minimal state snapshot passed to a constraint's `check` function.
 *
 * Only `id`, `type`, and `status` (`'running'`) are available — constraints
 * are evaluated mid-execution, before the workflow has a result or final
 * status. To inspect external state (e.g. a balance), capture it in the
 * enclosing scope instead of relying on this parameter.
 */
export interface ConstraintCheckState {
  id: string;
  type: string;
  status: 'running';
}

export interface ConstraintDefinition {
  name: string;
  /** Domain label for observability (e.g. 'transaction', 'budget'). */
  scope: string;
  /**
   * Return `true` when the invariant holds, `false` when it is violated.
   *
   * The `state` parameter is a {@link ConstraintCheckState} — always
   * `{ id: string; type: string; status: 'running' }`. To check external
   * state (e.g. a balance from your own closure), capture it in the
   * enclosing scope instead:
   *
   * ```ts
   * let balance = 0;
   * const balanceCheck = constraint('positiveBalance', {
   *   scope: 'transaction',
   *   check: () => balance >= 0,
   *   onViolation: 'compensate',
   * });
   * ```
   *
   * The function may be async — returning `Promise<boolean>` is supported.
   *
   * **Note**: Constraints are only evaluated when using the inline execution
   * strategy. Workflows running in a Web Worker will silently skip constraint
   * evaluation. Document this on your registration if using worker execution.
   */
  check: (state: ConstraintCheckState) => boolean | Promise<boolean>;
  /**
   * Reaction when the constraint is violated.
   *
   * - `'fail'`       — throws into the workflow generator, failing it immediately.
   * - `'compensate'` — throws into the workflow generator; if a `ctx.saga()` is
   *                    active it will catch the error, run its compensators, then
   *                    re-throw. Both `'fail'` and `'compensate'` use the same
   *                    engine dispatch path — the difference is visible only to
   *                    the workflow generator (via an active saga handler).
   * - `'warn'`       — logs a warning and continues execution.
   */
  onViolation: ConstraintViolation;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create a constraint definition.
 *
 * Constraints are domain invariants evaluated at every checkpoint commit.
 * Capture external state in the enclosing scope — the `state` parameter
 * passed to `check` is always a minimal `{ id, type, status }` snapshot.
 *
 * @example
 * ```ts
 * let balance = 0;
 *
 * const positiveBalance = constraint('positiveBalance', {
 *   scope: 'transaction',
 *   check: () => balance >= 0,
 *   onViolation: 'compensate',
 * });
 *
 * engine.register(workflow, { constraints: [positiveBalance] });
 * ```
 */
export function constraint(
  name: string,
  options: Omit<ConstraintDefinition, 'name'>,
): ConstraintDefinition {
  return { name, ...options };
}
