// ---------------------------------------------------------------------------
// Standard Schema-compatible definition metadata
// ---------------------------------------------------------------------------

interface StandardTypedV1Properties<Input = unknown, Output = Input> {
  readonly version: 1;
  readonly vendor: string;
  readonly types?: StandardTypedV1Types<Input, Output> | undefined;
}

interface StandardTypedV1Types<Input = unknown, Output = Input> {
  readonly input: Input;
  readonly output: Output;
}

interface StandardSchemaV1Properties<
  Input = unknown,
  Output = Input,
> extends StandardTypedV1Properties<Input, Output> {
  readonly validate: (
    value: unknown,
    options?: StandardSchemaV1Options,
  ) => StandardSchemaV1Result<Output> | Promise<StandardSchemaV1Result<Output>>;
}

type StandardSchemaV1Result<Output> =
  | StandardSchemaV1SuccessResult<Output>
  | StandardSchemaV1FailureResult;

interface StandardSchemaV1SuccessResult<Output> {
  readonly value: Output;
  readonly issues?: undefined;
}

interface StandardSchemaV1FailureResult {
  readonly issues: ReadonlyArray<StandardSchemaV1Issue>;
}

interface StandardSchemaV1Issue {
  readonly message: string;
  readonly path?: ReadonlyArray<PropertyKey | StandardSchemaV1PathSegment> | undefined;
}

interface StandardSchemaV1PathSegment {
  readonly key: PropertyKey;
}

interface StandardSchemaV1Options {
  readonly libraryOptions?: Record<string, unknown> | undefined;
}

interface StandardJSONSchemaV1Properties<
  Input = unknown,
  Output = Input,
> extends StandardTypedV1Properties<Input, Output> {
  readonly jsonSchema: StandardJSONSchemaV1Converter;
}

interface StandardJSONSchemaV1Converter {
  readonly input: (options: StandardJSONSchemaV1Options) => Record<string, unknown>;
  readonly output: (options: StandardJSONSchemaV1Options) => Record<string, unknown>;
}

type StandardJSONSchemaV1Target = 'draft-2020-12' | 'draft-07' | 'openapi-3.0' | ({} & string);

interface StandardJSONSchemaV1Options {
  readonly target: StandardJSONSchemaV1Target;
  readonly libraryOptions?: Record<string, unknown> | undefined;
}

/**
 * Base type metadata shared by the Standard Schema family.
 *
 * Weft copies the small structural interfaces it consumes instead of taking a
 * runtime dependency on [`@standard-schema/spec`](https://www.npmjs.com/package/@standard-schema/spec).
 * The runtime contract is the `~standard` property; libraries such as
 * [Zod](https://zod.dev/), [Valibot](https://valibot.dev/), and
 * [ArkType](https://arktype.io/) can satisfy it structurally.
 *
 * @example
 * ```ts
 * import type { StandardTypedV1 } from 'weft';
 *
 * const typedMetadata = {
 *   '~standard': { version: 1, vendor: 'example' },
 * } satisfies StandardTypedV1<unknown, unknown>;
 *
 * void typedMetadata;
 * ```
 */
export interface StandardTypedV1<Input = unknown, Output = Input> {
  readonly '~standard': StandardTypedV1Properties<Input, Output>;
}

/**
 * Standard Schema v1 validation surface.
 *
 * @example
 * ```ts
 * import type { StandardSchemaV1 } from 'weft';
 *
 * const stringSchema = {
 *   '~standard': {
 *     version: 1,
 *     vendor: 'example',
 *     validate(value: unknown) {
 *       return typeof value === 'string'
 *         ? { value }
 *         : { issues: [{ message: 'Expected a string.' }] };
 *     },
 *   },
 * } satisfies StandardSchemaV1<unknown, string>;
 *
 * void stringSchema;
 * ```
 */
export interface StandardSchemaV1<Input = unknown, Output = Input> {
  readonly '~standard': StandardSchemaV1Properties<Input, Output>;
}

/**
 * Standard JSON Schema v1 conversion surface.
 *
 * @example
 * ```ts
 * import type { StandardJSONSchemaV1 } from 'weft';
 *
 * const jsonSchemaMetadata = {
 *   '~standard': {
 *     version: 1,
 *     vendor: 'example',
 *     jsonSchema: {
 *       input: () => ({ type: 'object' }),
 *       output: () => ({ type: 'object' }),
 *     },
 *   },
 * } satisfies StandardJSONSchemaV1<Record<string, unknown>>;
 *
 * void jsonSchemaMetadata;
 * ```
 */
export interface StandardJSONSchemaV1<Input = unknown, Output = Input> {
  readonly '~standard': StandardJSONSchemaV1Properties<Input, Output>;
}

/**
 * Schema metadata accepted by workflow and activity definitions.
 *
 * Validation and JSON Schema conversion are separate capabilities. A schema may
 * provide validation only, JSON Schema conversion only, or both. Core workflow
 * and activity execution stores this as introspection metadata; adapters must
 * opt in explicitly before using it for runtime validation.
 *
 * @example
 * ```ts
 * import type { DefinitionSchema } from 'weft';
 *
 * function acceptsDefinitionSchema(schema: DefinitionSchema): DefinitionSchema {
 *   return schema;
 * }
 *
 * void acceptsDefinitionSchema;
 * ```
 */
export type DefinitionSchema<Input = unknown, Output = Input> =
  | StandardSchemaV1<Input, Output>
  | StandardJSONSchemaV1<Input, Output>;

export function isDefinitionSchema(value: unknown): value is DefinitionSchema {
  if (value === null || typeof value !== 'object') return false;
  const standard = (value as { '~standard'?: unknown })['~standard'];
  if (standard === null || typeof standard !== 'object') return false;
  if ((standard as { version?: unknown }).version !== 1) return false;

  if (typeof (standard as { validate?: unknown }).validate === 'function') return true;

  const jsonSchema = (standard as { jsonSchema?: unknown }).jsonSchema;
  if (jsonSchema === null || typeof jsonSchema !== 'object') return false;
  return (
    typeof (jsonSchema as { input?: unknown }).input === 'function' &&
    typeof (jsonSchema as { output?: unknown }).output === 'function'
  );
}
