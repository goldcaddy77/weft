/**
 * Shared name-grammar validator for workflow and activity names.
 *
 * The wire format used by the remote worker protocol qualifies activity names
 * as `${workflowType}.${activityName}` (introduced in Phase 4). To keep that
 * encoding unambiguous, the dot separator must never appear inside a workflow
 * or activity name, and names must start with a letter or underscore. The
 * permitted character class is `[A-Za-z_][A-Za-z0-9_-]*`.
 *
 * This helper is called from three construction sites:
 *
 *   1. `workflow({ name })` — rejects invalid workflow names.
 *   2. `WorkflowBuilder.activities({ ... })` keys — rejects invalid activity
 *      names supplied as the outer object key.
 *   3. `activity({ name })` — rejects invalid names on the canonical
 *      activity-definition constructor.
 *
 * Keep this list in sync with Phase 4's worker SDK key validation: any name
 * that passes here must also pass on the worker side, and vice versa.
 */

const NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_-]*$/;

/**
 * Discriminator for the error message so callers see which construction site
 * rejected the name. Add new kinds here when new entry points need validation.
 */
export type NameKind = 'workflow' | 'activity';

/**
 * Validate a workflow or activity name against the wire-safe grammar.
 *
 * Throws an `Error` if the name is empty, contains a `.`, or fails the
 * `[A-Za-z_][A-Za-z0-9_-]*` regex. The thrown message includes the offending
 * name and the `kind` so the failure points at the source location, not deep
 * inside replay or worker dispatch.
 *
 * @example
 * ```ts
 * import { validateWorkflowOrActivityName } from 'weft';
 *
 * validateWorkflowOrActivityName('formatGreeting', 'activity'); // ok
 * try {
 *   validateWorkflowOrActivityName('bad.name', 'activity');
 * } catch (error) {
 *   void error; // Error: activity name "bad.name" is invalid ...
 * }
 * ```
 */
export function validateWorkflowOrActivityName(name: string, kind: NameKind): void {
  if (typeof name !== 'string' || name.length === 0) {
    throw new Error(
      `${kind} name must be a non-empty string — must match /^[A-Za-z_][A-Za-z0-9_-]*$/ and contain no '.' characters`,
    );
  }
  if (name.includes('.')) {
    throw new Error(
      `${kind} name "${name}" is invalid — must match /^[A-Za-z_][A-Za-z0-9_-]*$/ and contain no '.' characters`,
    );
  }
  if (!NAME_PATTERN.test(name)) {
    throw new Error(
      `${kind} name "${name}" is invalid — must match /^[A-Za-z_][A-Za-z0-9_-]*$/ and contain no '.' characters`,
    );
  }
}
