export interface ValidationResult {
  valid: boolean;
  errors: ValidationError[];
}

export interface ValidationError {
  path: string;
  message: string;
  expected?: string;
  actual?: string;
}

/** Validate a value against a JSON Schema. Minimal implementation for tool input validation. */
export function validateSchema(value: unknown, schema: Record<string, unknown>): ValidationResult {
  const errors: ValidationError[] = [];
  validateValue(value, schema, '', errors);
  return { valid: errors.length === 0, errors };
}

function getTypeName(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}

function validateValue(
  value: unknown,
  schema: Record<string, unknown>,
  path: string,
  errors: ValidationError[],
): void {
  // An empty schema (no type, no properties, no required) accepts anything.
  if (Object.keys(schema).length === 0) return;

  const expectedType = schema['type'] as string | undefined;

  if (expectedType !== undefined) {
    const actualType = getTypeName(value);

    if (expectedType === 'object') {
      if (actualType !== 'object') {
        errors.push({
          path: path || '.',
          message: `Expected type "object" but got "${actualType}"`,
          expected: 'object',
          actual: actualType,
        });
        return;
      }

      validateObjectProperties(value as Record<string, unknown>, schema, path, errors);
    } else if (expectedType === 'array') {
      if (!Array.isArray(value)) {
        errors.push({
          path: path || '.',
          message: `Expected type "array" but got "${actualType}"`,
          expected: 'array',
          actual: actualType,
        });
      }
    } else if (actualType !== expectedType) {
      errors.push({
        path: path || '.',
        message: `Expected type "${expectedType}" but got "${actualType}"`,
        expected: expectedType,
        actual: actualType,
      });
    }
  } else if (schema['properties'] !== undefined || schema['required'] !== undefined) {
    // Schema defines object-like constraints without an explicit type
    if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
      validateObjectProperties(value as Record<string, unknown>, schema, path, errors);
    }
  }
}

function validateObjectProperties(
  value: Record<string, unknown>,
  schema: Record<string, unknown>,
  path: string,
  errors: ValidationError[],
): void {
  const properties = (schema['properties'] ?? {}) as Record<string, Record<string, unknown>>;
  const required = (schema['required'] ?? []) as string[];

  for (const field of required) {
    if (!(field in value)) {
      errors.push({
        path: path ? `${path}.${field}` : field,
        message: `Required field "${field}" is missing`,
      });
    }
  }

  for (const [key, propertySchema] of Object.entries(properties)) {
    if (key in value) {
      validateValue(value[key], propertySchema, path ? `${path}.${key}` : key, errors);
    }
  }
}

export class ToolSchemaValidationError extends Error {
  readonly toolName: string;
  readonly errors: ValidationError[];

  constructor(toolName: string, errors: ValidationError[]) {
    const summary = errors.map((e) => `  ${e.path}: ${e.message}`).join('\n');
    super(`Schema validation failed for tool "${toolName}":\n${summary}`);
    this.name = 'ToolSchemaValidationError';
    this.toolName = toolName;
    this.errors = errors;
  }
}
