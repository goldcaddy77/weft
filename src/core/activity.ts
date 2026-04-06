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
 *
 * Activities are the unit of "work that can fail" inside a workflow. Use
 * them for anything with side effects, non-deterministic results, or
 * external dependencies — HTTP calls, database writes, LLM requests, etc.
 * The engine retries failed activities per the attached {@link RetryPolicy}
 * and surfaces their results as deterministic values when the workflow is
 * replayed from a checkpoint.
 *
 * @example Basic activity with retry policy
 * ```ts
 * import { activity } from 'weft';
 *
 * const chargeCard = activity({
 *   name: 'chargeCard',
 *   execute: async (input: { amount: number; cardId: string }) => {
 *     const response = await fetch('https://payments.example.com/charge', {
 *       method: 'POST',
 *       body: JSON.stringify(input),
 *     });
 *     if (!response.ok) throw new Error(`Charge failed: ${response.status}`);
 *     return (await response.json()) as { transactionId: string };
 *   },
 *   retry: {
 *     maxAttempts: 5,
 *     initialInterval: 1000,
 *     maximumInterval: 30_000,
 *     backoffCoefficient: 2,
 *   },
 *   timeout: '30s',
 * });
 * ```
 *
 * @example Calling an activity from a workflow
 * ```ts
 * engine.register('checkout', async function* (ctx, input: { cardId: string }) {
 *   const result = yield* ctx.run(chargeCard, { amount: 100, cardId: input.cardId });
 *   return result.transactionId;
 * });
 * ```
 */
export function activity<TInput, TOutput>(
  definition: ActivityDefinition<TInput, TOutput>,
): ActivityDefinition<TInput, TOutput> {
  return definition;
}
