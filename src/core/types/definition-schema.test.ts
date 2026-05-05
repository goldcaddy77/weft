import { describe, expect, it } from 'bun:test';

import { isDefinitionSchema } from './definition-schema.ts';

describe('isDefinitionSchema', () => {
  it('accepts Standard Schema validators', () => {
    expect(
      isDefinitionSchema({
        '~standard': {
          version: 1,
          vendor: 'weft-test',
          validate: (value: unknown) => ({ value }),
        },
      }),
    ).toBe(true);
  });

  it('accepts Standard JSON Schema converters', () => {
    expect(
      isDefinitionSchema({
        '~standard': {
          version: 1,
          vendor: 'weft-test',
          jsonSchema: {
            input: () => ({ type: 'object' }),
            output: () => ({ type: 'object' }),
          },
        },
      }),
    ).toBe(true);
  });

  it('rejects Standard Typed metadata without validation or JSON Schema conversion', () => {
    expect(
      isDefinitionSchema({
        '~standard': {
          version: 1,
          vendor: 'weft-test',
        },
      }),
    ).toBe(false);
  });

  it('rejects unsupported Standard Schema versions', () => {
    expect(
      isDefinitionSchema({
        '~standard': {
          version: 2,
          vendor: 'weft-test',
          validate: (value: unknown) => ({ value }),
        },
      }),
    ).toBe(false);
  });

  it('rejects malformed Standard JSON Schema converters', () => {
    const invalidConverters = [
      {},
      { input: () => ({ type: 'object' }) },
      { output: () => ({ type: 'object' }) },
      { input: 'not-a-function', output: () => ({ type: 'object' }) },
      { input: () => ({ type: 'object' }), output: 'not-a-function' },
    ];

    for (const jsonSchema of invalidConverters) {
      expect(
        isDefinitionSchema({
          '~standard': {
            version: 1,
            vendor: 'weft-test',
            jsonSchema,
          },
        }),
      ).toBe(false);
    }
  });
});
