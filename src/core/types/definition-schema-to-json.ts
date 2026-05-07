import { z } from 'zod';

import type {
  DefinitionSchema,
  StandardJSONSchemaV1Options,
  StandardJSONSchemaV1Target,
} from './definition-schema.ts';

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Direction parameter for {@link definitionSchemaToJsonSchema}. `"input"`
 * produces the JSON Schema describing the validator's accepted input;
 * `"output"` produces the schema describing the validated value.
 *
 * @example
 * ```ts
 * import type { DefinitionSchemaDirection } from 'weft';
 *
 * const direction: DefinitionSchemaDirection = 'input';
 * void direction;
 * ```
 */
export type DefinitionSchemaDirection = 'input' | 'output';

/**
 * Convert a {@link DefinitionSchema} to a JSON Schema fragment. Dispatch
 * order: a structural `~standard.jsonSchema` converter wins; otherwise the
 * function dispatches on `~standard.vendor` (Zod via `z.toJSONSchema`,
 * Valibot via `@valibot/to-json-schema`). Throws when the vendor has no
 * built-in adapter and no structural converter is attached.
 *
 * @example
 * ```ts
 * import { definitionSchemaToJsonSchema } from 'weft';
 * import { z } from 'zod';
 *
 * const schema = z.object({ email: z.string() });
 * const jsonSchema = definitionSchemaToJsonSchema(schema);
 * void jsonSchema;
 * ```
 */
export function definitionSchemaToJsonSchema(
  schema: DefinitionSchema,
  direction: DefinitionSchemaDirection = 'input',
): Record<string, unknown> {
  const standard = schema['~standard'];
  const vendor = standard.vendor;

  // Built-in vendor adapters win over a structural converter that may ship
  // alongside the validator. Zod 4, for example, exposes its own
  // `~standard.jsonSchema` that does not honor the project's
  // `unrepresentable: 'any'` option; deferring to the vendor adapter keeps
  // generated artifacts stable.
  if (vendor === 'zod') return convertZod(schema as z.ZodType);
  if (vendor === 'valibot') return convertValibot(schema);

  const structuralConverter = (standard as { jsonSchema?: unknown }).jsonSchema;
  if (isStructuralConverter(structuralConverter)) {
    const fn = structuralConverter[direction];
    if (typeof fn === 'function') {
      const options: StandardJSONSchemaV1Options = { target: defaultTarget };
      return stripDialect(fn(options));
    }
  }

  throw new Error(
    `definitionSchemaToJsonSchema: no built-in adapter for vendor "${vendor}". ` +
      `Attach a \`~standard.jsonSchema\` converter to the schema, or use Zod or Valibot.`,
  );
}

function isStructuralConverter(value: unknown): value is {
  readonly input?: (options: StandardJSONSchemaV1Options) => Record<string, unknown>;
  readonly output?: (options: StandardJSONSchemaV1Options) => Record<string, unknown>;
} {
  return value !== null && typeof value === 'object';
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

const defaultTarget: StandardJSONSchemaV1Target = 'draft-2020-12';

function convertZod(schema: z.ZodType): Record<string, unknown> {
  const result: unknown = z.toJSONSchema(schema, { unrepresentable: 'any' });
  return stripDialect(asPlainObject(result));
}

let cachedValibotConverter: ((schema: unknown, options?: unknown) => unknown) | undefined;

function convertValibot(schema: DefinitionSchema): Record<string, unknown> {
  const toJsonSchema = loadValibotConverter();
  const result: unknown = toJsonSchema(schema);
  return stripDialect(asPlainObject(result));
}

function loadValibotConverter(): (schema: unknown, options?: unknown) => unknown {
  if (cachedValibotConverter !== undefined) return cachedValibotConverter;
  let valibotModule: { toJsonSchema?: (schema: unknown, options?: unknown) => unknown };
  try {
    // Resolve from the working directory so the lookup is independent of
    // module identity tricks (test harnesses sometimes alter `import.meta.url`).
    const resolved = Bun.resolveSync('@valibot/to-json-schema', process.cwd());
    valibotModule = require(resolved) as {
      toJsonSchema?: (schema: unknown, options?: unknown) => unknown;
    };
  } catch {
    throw new Error(
      `definitionSchemaToJsonSchema: \`@valibot/to-json-schema\` is not installed. ` +
        `Install it to convert Valibot schemas to JSON Schema, or attach a ` +
        `\`~standard.jsonSchema\` converter to your schema.`,
    );
  }
  if (typeof valibotModule.toJsonSchema !== 'function') {
    throw new Error(
      `definitionSchemaToJsonSchema: the installed \`@valibot/to-json-schema\` ` +
        `does not export \`toJsonSchema\`.`,
    );
  }
  cachedValibotConverter = valibotModule.toJsonSchema;
  return cachedValibotConverter;
}

function stripDialect(object: Record<string, unknown>): Record<string, unknown> {
  if (!('$schema' in object)) return object;
  const result = { ...object };
  delete result['$schema'];
  return result;
}

function asPlainObject(value: unknown): Record<string, unknown> {
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return {};
}
