import { describe, expect, it } from 'bun:test';

import { ToolSchemaValidationError, validateSchema } from './schema-validator';

describe('validateSchema', () => {
  it('passes validation for a valid object', () => {
    const schema = {
      type: 'object',
      properties: {
        name: { type: 'string' },
        age: { type: 'number' },
      },
      required: ['name'],
    };

    const result = validateSchema({ name: 'Alice', age: 30 }, schema);

    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it('fails when a required field is missing', () => {
    const schema = {
      type: 'object',
      properties: {
        name: { type: 'string' },
        age: { type: 'number' },
      },
      required: ['name', 'age'],
    };

    const result = validateSchema({ name: 'Alice' }, schema);

    expect(result.valid).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.errors[0]!.path).toContain('age');
    expect(result.errors[0]!.message).toMatch(/required/i);
  });

  it('fails when the type is wrong (string expected, number given)', () => {
    const schema = {
      type: 'object',
      properties: {
        name: { type: 'string' },
      },
    };

    const result = validateSchema({ name: 42 }, schema);

    expect(result.valid).toBe(false);
    expect(result.errors[0]!.expected).toBe('string');
    expect(result.errors[0]!.actual).toBe('number');
  });

  it('validates nested objects', () => {
    const schema = {
      type: 'object',
      properties: {
        address: {
          type: 'object',
          properties: {
            city: { type: 'string' },
          },
          required: ['city'],
        },
      },
      required: ['address'],
    };

    const result = validateSchema({ address: { city: 123 } }, schema);

    expect(result.valid).toBe(false);
    expect(result.errors[0]!.path).toContain('address.city');
  });

  it('validates anything when the schema is empty', () => {
    const result = validateSchema({ anything: 'goes' }, {});

    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it('validates array types', () => {
    const schema = {
      type: 'object',
      properties: {
        tags: { type: 'array' },
      },
    };

    const validResult = validateSchema({ tags: ['a', 'b'] }, schema);
    expect(validResult.valid).toBe(true);

    const invalidResult = validateSchema({ tags: 'not-an-array' }, schema);
    expect(invalidResult.valid).toBe(false);
    expect(invalidResult.errors[0]!.expected).toBe('array');
    expect(invalidResult.errors[0]!.actual).toBe('string');
  });
});

describe('ToolSchemaValidationError', () => {
  it('stores toolName and errors', () => {
    const errors = [{ path: '.name', message: 'Required field missing' }];
    const error = new ToolSchemaValidationError('my-tool', errors);

    expect(error).toBeInstanceOf(Error);
    expect(error.toolName).toBe('my-tool');
    expect(error.errors).toEqual(errors);
    expect(error.message).toContain('my-tool');
  });
});
