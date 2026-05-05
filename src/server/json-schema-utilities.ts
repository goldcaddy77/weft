import { z } from 'zod';

export function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

export function zodToJsonSchema(schema: z.ZodType): Record<string, unknown> {
  const result: unknown = z.toJSONSchema(schema, {
    unrepresentable: 'any',
  });
  const object = asPlainObject(result);
  if (!('$schema' in object)) return object;

  const schemaWithoutDialect = { ...object };
  delete schemaWithoutDialect['$schema'];
  return schemaWithoutDialect;
}

export function asPlainObject(value: unknown): Record<string, unknown> {
  if (isPlainObject(value)) return value;
  return {};
}

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
