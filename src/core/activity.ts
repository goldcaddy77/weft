/**
 * Type-safe factory for activity definitions.
 *
 * Associates retry/timeout/queue configuration with an activity function
 * while preserving full type information for input and output.
 *
 * @module core/activity
 */

import type { ActivityDefinition } from './types.ts';

/**
 * Creates an {@link ActivityDefinition} with full type inference.
 *
 * This is an identity function at runtime — it returns the definition as-is.
 * Its purpose is purely ergonomic: it provides TypeScript autocompletion and
 * validation when defining activities.
 */
export function activity<TInput, TOutput>(
  definition: ActivityDefinition<TInput, TOutput>,
): ActivityDefinition<TInput, TOutput> {
  return definition;
}
