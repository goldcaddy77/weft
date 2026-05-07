import { describe, expect, it } from 'bun:test';
import * as v from 'valibot';
import { z } from 'zod';

import { definitionSchemaToJsonSchema } from './definition-schema-to-json.ts';
import type { DefinitionSchema, StandardJSONSchemaV1 } from './definition-schema.ts';

describe('definitionSchemaToJsonSchema', () => {
  describe('structural Standard JSON Schema converter', () => {
    it('uses ~standard.jsonSchema.input by default', () => {
      const schema: StandardJSONSchemaV1 = {
        '~standard': {
          version: 1,
          vendor: 'weft-test',
          jsonSchema: {
            input: () => ({ type: 'object', properties: { name: { type: 'string' } } }),
            output: () => ({ type: 'string' }),
          },
        },
      };

      expect(definitionSchemaToJsonSchema(schema)).toEqual({
        type: 'object',
        properties: { name: { type: 'string' } },
      });
    });

    it('uses ~standard.jsonSchema.output when direction is "output"', () => {
      const schema: StandardJSONSchemaV1 = {
        '~standard': {
          version: 1,
          vendor: 'weft-test',
          jsonSchema: {
            input: () => ({ type: 'object' }),
            output: () => ({ type: 'string' }),
          },
        },
      };

      expect(definitionSchemaToJsonSchema(schema, 'output')).toEqual({ type: 'string' });
    });

    it('passes the requested target dialect through to the converter', () => {
      let receivedTarget: string | undefined;
      const schema: StandardJSONSchemaV1 = {
        '~standard': {
          version: 1,
          vendor: 'weft-test',
          jsonSchema: {
            input: (options) => {
              receivedTarget = options.target;
              return { type: 'object' };
            },
            output: () => ({ type: 'object' }),
          },
        },
      };

      definitionSchemaToJsonSchema(schema, 'input');
      expect(receivedTarget).toBe('draft-2020-12');
    });
  });

  describe('Zod vendor adapter', () => {
    it('converts a Zod schema and strips the $schema dialect', () => {
      const schema = z.object({ email: z.string() });
      const result = definitionSchemaToJsonSchema(schema);
      expect(result).toMatchObject({
        type: 'object',
        properties: { email: { type: 'string' } },
      });
      expect(result).not.toHaveProperty('$schema');
    });

    it('preserves the unrepresentable=any option for Zod schemas', () => {
      // Zod's date type is unrepresentable in JSON Schema; with unrepresentable: 'any',
      // it should still produce a schema rather than throwing.
      const schema = z.object({ when: z.date() });
      expect(() => definitionSchemaToJsonSchema(schema)).not.toThrow();
    });
  });

  describe('Valibot vendor adapter', () => {
    it('converts a Valibot schema via dynamic import', async () => {
      const schema = v.object({ name: v.string() });
      const result = definitionSchemaToJsonSchema(schema);
      expect(result).toMatchObject({
        type: 'object',
        properties: { name: { type: 'string' } },
      });
    });
  });

  describe('error cases', () => {
    it('throws a clear error for unknown vendors with no JSON Schema converter', () => {
      const schema: DefinitionSchema = {
        '~standard': {
          version: 1,
          vendor: 'mystery-vendor',
          validate: (value) => ({ value }),
        },
      };

      expect(() => definitionSchemaToJsonSchema(schema)).toThrow(/mystery-vendor/);
    });

    it('mentions the structural converter escape hatch in the unknown-vendor error', () => {
      const schema: DefinitionSchema = {
        '~standard': {
          version: 1,
          vendor: 'mystery-vendor',
          validate: (value) => ({ value }),
        },
      };

      expect(() => definitionSchemaToJsonSchema(schema)).toThrow(/~standard\.jsonSchema/);
    });
  });
});
