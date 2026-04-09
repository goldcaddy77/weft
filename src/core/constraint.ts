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

export interface ConstraintDefinition<TState = unknown> {
  name: string;
  /** Domain label for observability (e.g. 'transaction', 'budget'). */
  scope: string;
  /** Return `true` when the invariant holds, `false` when it is violated. */
  check: (state: TState) => boolean | Promise<boolean>;
  onViolation: ConstraintViolation;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create a constraint definition.
 *
 * @example
 * ```ts
 * const positiveBalance = constraint('positiveBalance', {
 *   scope: 'transaction',
 *   check: (state) => (state as { balance: number }).balance >= 0,
 *   onViolation: 'compensate',
 * });
 *
 * engine.register(workflow, { constraints: [positiveBalance] });
 * ```
 */
export function constraint<TState = unknown>(
  name: string,
  options: Omit<ConstraintDefinition<TState>, 'name'>,
): ConstraintDefinition<TState> {
  return { name, ...options };
}
