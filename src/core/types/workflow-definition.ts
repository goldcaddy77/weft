/**
 * The legacy `WorkflowRegistration` / `WorkflowDefinition` / `WorkflowDefinitionOptions`
 * type surface. Phase 2 of the tRPC-style builder refactor keeps these alive
 * so existing callers continue to typecheck; Phase 5 sweeps the callers to the
 * chained builder form, and Phase 6 deletes these types outright.
 *
 * They live in their own file so `workflow-function.ts` stays under the 500-
 * line lint ceiling and so the eventual deletion in Phase 6 is one `rm` plus
 * import-path updates rather than scattered surgery.
 */

import type { ConstraintDefinition } from '../constraint.ts';
import type { DefinitionSchema } from './definition-schema.ts';
import type { RetentionPolicy } from './retry-retention.ts';
import type { SearchAttributeSchema } from './search-attributes.ts';
import type { WorkflowFunction } from './workflow-function.ts';

/**
 * Full registration descriptor used when calling `engine.register(type, registration)`.
 * Bundles the workflow handler with optional metadata: version for live
 * migration, `searchAttributes` schema for indexing, a `retention` policy,
 * domain `constraints`, and a `migrate` callback that transforms checkpoint
 * state when versions differ.
 *
 * @example
 * ```ts
 * import { activity, Engine, type WorkflowRegistration, type WorkflowContext } from 'weft';
 *
 * const noop = activity({ name: 'noop', execute: async (i: unknown) => i });
 * const registration: WorkflowRegistration = {
 *   version: '1.0.0',
 *   retention: { completed: '7d' },
 *   handler: async function* (ctx: WorkflowContext, input: unknown) {
 *     return yield* ctx.run(noop, input);
 *   },
 * };
 * const engine = new Engine();
 * engine.register('myWorkflow', registration);
 * void engine;
 * ```
 */
export interface WorkflowRegistration<TInput = unknown, TOutput = unknown> {
  /** Version recorded with workflow state and used for checkpoint migration. */
  version?: string;
  /** User-facing description for catalog, code generation, and tool surfaces. */
  description?: string;
  /** User-facing grouping tags for catalog and documentation surfaces. */
  tags?: ReadonlyArray<string>;
  /** Optional input schema metadata for introspection; registration validates metadata shape only. */
  inputSchema?: DefinitionSchema<unknown, TInput>;
  /** Optional output schema metadata for introspection; registration validates metadata shape only. */
  outputSchema?: DefinitionSchema<unknown, TOutput>;
  /** Workflow generator function executed by the engine. */
  handler: WorkflowFunction<TInput, TOutput>;
  /** Optional checkpoint migration from a prior workflow version. */
  migrate?: (checkpoint: unknown, fromVersion: string) => unknown;
  /** Search-attribute schema used to validate indexed workflow metadata. */
  searchAttributes?: SearchAttributeSchema;
  /** Retention policy for terminal workflow records. */
  retention?: RetentionPolicy;
  /**
   * Domain constraints evaluated at every checkpoint commit. When a constraint's
   * `check` returns false, the engine dispatches a `ConstraintViolatedEvent`
   * and reacts per `onViolation` ('fail' | 'compensate' | 'warn').
   *
   * **Note**: Constraints are only evaluated when using the default inline
   * execution strategy. Workflows running in a Web Worker
   * (`workerExecution` option) will silently skip constraint evaluation.
   */
  constraints?: ConstraintDefinition[];
}

/**
 * Named workflow definition returned by {@link workflow}. The runtime object
 * carries the workflow name plus the same metadata accepted by
 * {@link WorkflowRegistration}.
 *
 * @example
 * ```ts
 * import { workflow, type WorkflowDefinition } from 'weft';
 *
 * const greet: WorkflowDefinition<string, string> = workflow(async function* greet(ctx, input: string) {
 *   return `hello ${input}`;
 * });
 * ```
 */
export interface WorkflowDefinition<
  TInput = unknown,
  TOutput = unknown,
  TName extends string = string,
> extends WorkflowRegistration<TInput, TOutput> {
  name: TName;
}

/**
 * Options accepted by the legacy object-literal `workflow({ name, handler, ... })`
 * overload. Identical to {@link WorkflowDefinition}; preserved as a distinct
 * name so existing callers' explicit type annotations keep resolving. Phase 6
 * deletes this alias along with the deprecated overload.
 */
export interface WorkflowDefinitionOptions<
  TInput = unknown,
  TOutput = unknown,
  TName extends string = string,
> extends WorkflowRegistration<TInput, TOutput> {
  name: TName;
}
