import {
  validateDefinitionSchemaMetadata,
  type DefinitionSchema,
} from '../types/definition-schema.ts';
import type { Interceptor } from './interceptor-interfaces.ts';

export * from './activity-composition.ts';
export * from './interception-contexts.ts';
export * from './interceptor-interfaces.ts';
export * from './split.ts';
export * from './workflow-composition.ts';

/**
 * Optional schema metadata accepted alongside an interceptor spec. Most
 * interceptors wrap arbitrary handler types and have no single payload
 * shape — leave these undefined in that case. When supplied, the schemas
 * are carried for introspection only; runtime validation is the caller's
 * responsibility because the interceptor's input shape varies by handler.
 *
 * @example
 * ```ts
 * import type { InterceptorSchemas } from 'weft';
 * import { z } from 'zod';
 *
 * const schemas: InterceptorSchemas = {
 *   inputSchema: z.object({ traceId: z.string() }),
 * };
 * void schemas;
 * ```
 */
export interface InterceptorSchemas {
  readonly inputSchema?: DefinitionSchema<unknown, unknown>;
  readonly outputSchema?: DefinitionSchema<unknown, unknown>;
}

/**
 * Create an interceptor with inference preserved at the declaration site.
 * The optional `name` field is carried for observability and diagnostics;
 * optional `inputSchema` / `outputSchema` carry schema metadata when the
 * interceptor has a single well-known payload shape.
 *
 * @example
 * ```ts
 * import { interceptor } from 'weft';
 *
 * const tracer = interceptor({
 *   name: 'tracer',
 *   *activity(ctx, next) {
 *     return yield* next(ctx);
 *   },
 * });
 * ```
 */
export function interceptor<
  TInterceptor extends Interceptor & { readonly name?: string } & InterceptorSchemas,
>(spec: TInterceptor): TInterceptor {
  if (spec.inputSchema !== undefined) {
    validateDefinitionSchemaMetadata(
      spec.inputSchema,
      `interceptor("${spec.name ?? '<anonymous>'}").inputSchema`,
    );
  }
  if (spec.outputSchema !== undefined) {
    validateDefinitionSchemaMetadata(
      spec.outputSchema,
      `interceptor("${spec.name ?? '<anonymous>'}").outputSchema`,
    );
  }
  return spec;
}
