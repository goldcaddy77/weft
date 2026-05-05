import type { DefinitionSchema } from './definition-schema.ts';

/**
 * Read-only metadata exposed by the engine for a registered workflow type.
 *
 * @example
 * ```ts
 * import { Engine, type WorkflowDefinition } from 'weft';
 *
 * const engine = new Engine();
 * const definition: WorkflowDefinition | undefined = engine.getWorkflowDefinition('greet');
 *
 * void definition;
 * ```
 */
export interface WorkflowDefinition<TInput = unknown, TOutput = unknown> {
  /** Registered workflow type name. */
  type: string;
  /** Current registration version. */
  version: string;
  /** User-facing grouping tags for catalog and documentation surfaces. */
  tags: ReadonlyArray<string>;
  /** User-facing description for catalog, code generation, and tool surfaces. */
  description?: string;
  /** Optional input schema metadata for introspection; core execution does not validate input against it. */
  inputSchema?: DefinitionSchema<unknown, TInput>;
  /** Optional output schema metadata for introspection; core execution does not validate output against it. */
  outputSchema?: DefinitionSchema<unknown, TOutput>;
}

/**
 * Type-level map of workflow names to their input and output shapes. This
 * shape is consumed by code generation and future typed wrappers; the current
 * `Engine` class does not accept a registry generic. Each key is a workflow
 * name; each value declares the `input` type and `output` type.
 *
 * @example
 * ```ts
 * import type { WorkflowRegistry } from 'weft';
 *
 * type MyRegistry = WorkflowRegistry & {
 *   greet: { input: string; output: string };
 * };
 *
 * // WorkflowRegistry documents the shape contract for generated wrappers.
 * const _registry: MyRegistry = { greet: { input: '', output: '' } };
 * void _registry;
 * ```
 */
export type WorkflowRegistry = Record<string, { input: unknown; output: unknown }>;
