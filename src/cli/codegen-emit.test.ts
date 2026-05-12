import { describe, expect, it } from 'bun:test';

import type { RegistrySnapshot } from '../core/registry-snapshot.ts';
import {
  emitPropertyKey,
  emitRegistryDeclaration,
  jsonSchemaToTypeScript,
} from './codegen-emit.ts';

describe('emitPropertyKey', () => {
  it('emits double-quoted string literals for plain identifiers', () => {
    expect(emitPropertyKey('welcome')).toBe('"welcome"');
  });

  it('escapes embedded quotes and backslashes', () => {
    expect(emitPropertyKey('with "quote"')).toBe('"with \\"quote\\""');
    expect(emitPropertyKey('back\\slash')).toBe('"back\\\\slash"');
  });

  it('escapes control characters', () => {
    expect(emitPropertyKey('line\nbreak')).toBe('"line\\nbreak"');
  });
});

describe('jsonSchemaToTypeScript primitives', () => {
  it.each([
    [{ type: 'string' }, 'string'],
    [{ type: 'number' }, 'number'],
    [{ type: 'integer' }, 'number'],
    [{ type: 'boolean' }, 'boolean'],
    [{ type: 'null' }, 'null'],
  ])('%p → %p', (schema, expected) => {
    expect(jsonSchemaToTypeScript(schema)).toBe(expected);
  });

  it('absent type and unknown keywords degrade to unknown', () => {
    expect(jsonSchemaToTypeScript({})).toBe('unknown');
    expect(jsonSchemaToTypeScript({ description: 'just a description' })).toBe('unknown');
    expect(jsonSchemaToTypeScript(undefined)).toBe('unknown');
    expect(jsonSchemaToTypeScript(null)).toBe('unknown');
  });

  it('boolean schemas convert to unknown/never', () => {
    expect(jsonSchemaToTypeScript(true)).toBe('unknown');
    expect(jsonSchemaToTypeScript(false)).toBe('never');
  });
});

describe('jsonSchemaToTypeScript enum and const', () => {
  it('emits a parenthesized union for primitive enums', () => {
    expect(jsonSchemaToTypeScript({ enum: ['a', 'b', 'c'] })).toBe('("a" | "b" | "c")');
    expect(jsonSchemaToTypeScript({ enum: [1, 2, 3] })).toBe('(1 | 2 | 3)');
    expect(jsonSchemaToTypeScript({ enum: [true, false] })).toBe('(true | false)');
  });

  it('emits unknown when an enum contains a non-primitive', () => {
    expect(jsonSchemaToTypeScript({ enum: ['a', { nested: true }] })).toBe('unknown');
  });

  it('emits a primitive literal for const', () => {
    expect(jsonSchemaToTypeScript({ const: 'fixed' })).toBe('"fixed"');
    expect(jsonSchemaToTypeScript({ const: 42 })).toBe('42');
    expect(jsonSchemaToTypeScript({ const: true })).toBe('true');
    expect(jsonSchemaToTypeScript({ const: null })).toBe('null');
  });

  it('emits unknown for non-primitive const', () => {
    expect(jsonSchemaToTypeScript({ const: { nested: true } })).toBe('unknown');
  });
});

describe('jsonSchemaToTypeScript combinators', () => {
  it('emits parenthesized unions for oneOf and anyOf', () => {
    expect(jsonSchemaToTypeScript({ oneOf: [{ type: 'string' }, { type: 'number' }] })).toBe(
      '(string | number)',
    );
    expect(jsonSchemaToTypeScript({ anyOf: [{ type: 'string' }, { type: 'boolean' }] })).toBe(
      '(string | boolean)',
    );
  });

  it('emits a parenthesized intersection for allOf', () => {
    expect(
      jsonSchemaToTypeScript({
        allOf: [
          {
            type: 'object',
            properties: { a: { type: 'string' } },
            required: ['a'],
            additionalProperties: false,
          },
          {
            type: 'object',
            properties: { b: { type: 'number' } },
            required: ['b'],
            additionalProperties: false,
          },
        ],
      }),
    ).toBe('({ "a": string; } & { "b": number; })');
  });

  it('parenthesizes unions when nested inside an array (precedence)', () => {
    const arrayOfUnion = jsonSchemaToTypeScript({
      type: 'array',
      items: { oneOf: [{ type: 'string' }, { type: 'number' }] },
    });
    expect(arrayOfUnion).toBe('Array<(string | number)>');
  });

  it('emits nullable from type-as-array and from oneOf-null', () => {
    expect(jsonSchemaToTypeScript({ type: ['string', 'null'] })).toBe('(string | null)');
    expect(
      jsonSchemaToTypeScript({
        oneOf: [{ type: 'string' }, { type: 'null' }],
      }),
    ).toBe('(string | null)');
  });
});

describe('jsonSchemaToTypeScript objects', () => {
  it('emits required and optional named properties', () => {
    const result = jsonSchemaToTypeScript({
      type: 'object',
      properties: { name: { type: 'string' }, age: { type: 'number' } },
      required: ['name'],
      additionalProperties: false,
    });
    expect(result).toBe('{ "age"?: number; "name": string; }');
  });

  it('closes the object when additionalProperties: false and emits no index signature', () => {
    const result = jsonSchemaToTypeScript({
      type: 'object',
      properties: { a: { type: 'string' } },
      required: ['a'],
      additionalProperties: false,
    });
    expect(result).not.toContain('[index:');
    expect(result).toBe('{ "a": string; }');
  });

  it('defaults to open with [index: string]: unknown when additionalProperties is absent', () => {
    const result = jsonSchemaToTypeScript({
      type: 'object',
      properties: { a: { type: 'string' } },
      required: ['a'],
    });
    expect(result).toBe('{ "a": string; [index: string]: unknown; }');
  });

  it('treats additionalProperties: true as default-open with unknown index value', () => {
    expect(
      jsonSchemaToTypeScript({
        type: 'object',
        properties: { a: { type: 'string' } },
        required: ['a'],
        additionalProperties: true,
      }),
    ).toBe('{ "a": string; [index: string]: unknown; }');
  });

  it('typed additionalProperties widens to include named property value types', () => {
    const result = jsonSchemaToTypeScript({
      type: 'object',
      properties: { count: { type: 'number' } },
      required: ['count'],
      additionalProperties: { type: 'string' },
    });
    expect(result).toBe('{ "count": number; [index: string]: string | number; }');
  });

  it('typed additionalProperties adds undefined when any named property is optional', () => {
    const result = jsonSchemaToTypeScript({
      type: 'object',
      properties: { count: { type: 'number' } },
      required: [],
      additionalProperties: { type: 'string' },
    });
    expect(result).toBe('{ "count"?: number; [index: string]: string | number | undefined; }');
  });

  it('required keys absent from properties become unknown', () => {
    expect(
      jsonSchemaToTypeScript({
        type: 'object',
        properties: { a: { type: 'string' } },
        required: ['a', 'b'],
        additionalProperties: false,
      }),
    ).toBe('{ "a": string; "b": unknown; }');
  });

  it('empty closed object becomes Record<string, never>', () => {
    expect(jsonSchemaToTypeScript({ type: 'object', additionalProperties: false })).toBe(
      'Record<string, never>',
    );
  });

  it('empty default-open object becomes Record<string, unknown>', () => {
    expect(jsonSchemaToTypeScript({ type: 'object' })).toBe('Record<string, unknown>');
  });
});

describe('jsonSchemaToTypeScript arrays (draft-2020-12)', () => {
  it('items as a single schema emits Array<T>', () => {
    expect(jsonSchemaToTypeScript({ type: 'array', items: { type: 'string' } })).toBe(
      'Array<string>',
    );
  });

  it('prefixItems + items: false emits fixed-length tuple', () => {
    expect(
      jsonSchemaToTypeScript({
        type: 'array',
        prefixItems: [{ type: 'string' }, { type: 'number' }],
        items: false,
      }),
    ).toBe('[string, number]');
  });

  it('prefixItems + items schema emits tuple with rest type', () => {
    expect(
      jsonSchemaToTypeScript({
        type: 'array',
        prefixItems: [{ type: 'string' }],
        items: { type: 'number' },
      }),
    ).toBe('[string, ...number[]]');
  });

  it('prefixItems alone emits tuple with unknown rest (open default)', () => {
    expect(
      jsonSchemaToTypeScript({
        type: 'array',
        prefixItems: [{ type: 'string' }],
      }),
    ).toBe('[string, ...unknown[]]');
  });

  it('legacy items as array + additionalItems false emits fixed tuple', () => {
    expect(
      jsonSchemaToTypeScript({
        type: 'array',
        items: [{ type: 'string' }, { type: 'number' }],
        additionalItems: false,
      }),
    ).toBe('[string, number]');
  });

  it('legacy items as array + additionalItems schema emits tuple with rest', () => {
    expect(
      jsonSchemaToTypeScript({
        type: 'array',
        items: [{ type: 'string' }],
        additionalItems: { type: 'number' },
      }),
    ).toBe('[string, ...number[]]');
  });

  it('array with no items keyword emits Array<unknown>', () => {
    expect(jsonSchemaToTypeScript({ type: 'array' })).toBe('Array<unknown>');
  });
});

describe('jsonSchemaToTypeScript $ref and ignored keywords', () => {
  it('$ref and $defs degrade to unknown', () => {
    expect(jsonSchemaToTypeScript({ $ref: '#/$defs/Foo' })).toBe('unknown');
    expect(jsonSchemaToTypeScript({ $defs: { Foo: { type: 'string' } } })).toBe('unknown');
  });

  it('ignores description/default/numeric/string constraints on typed schemas', () => {
    expect(
      jsonSchemaToTypeScript({
        type: 'string',
        description: 'an email',
        default: 'a@b',
        minLength: 3,
        maxLength: 200,
        pattern: '@',
      }),
    ).toBe('string');
    expect(
      jsonSchemaToTypeScript({
        type: 'number',
        description: 'count',
        minimum: 0,
        maximum: 100,
      }),
    ).toBe('number');
  });
});

describe('emitRegistryDeclaration', () => {
  function buildSnapshot(input: Partial<RegistrySnapshot> = {}): RegistrySnapshot {
    return {
      registryVersion: 1,
      workflows: input.workflows ?? {},
      activities: input.activities ?? {},
    };
  }

  it('emits a valid empty file when the snapshot has no entries', () => {
    const output = emitRegistryDeclaration(buildSnapshot());
    expect(output).toContain("declare module 'weft' {");
    expect(output).toContain('interface WorkflowRegistry {}');
    expect(output).toContain('interface ActivityTypes {}');
    expect(output).toContain('export {};');
    expect(output.endsWith('\n')).toBe(true);
  });

  it('is byte-identical across two runs with the same input', () => {
    const snapshot = buildSnapshot({
      workflows: {
        welcome: {
          inputSchema: {
            type: 'object',
            properties: { name: { type: 'string' } },
            required: ['name'],
            additionalProperties: false,
          },
          outputSchema: { type: 'string' },
        },
      },
    });
    expect(emitRegistryDeclaration(snapshot)).toBe(emitRegistryDeclaration(snapshot));
  });

  it('sorts keys deterministically regardless of insertion order', () => {
    const snapshot = buildSnapshot({
      workflows: {
        zeta: { inputSchema: { type: 'string' } },
        alpha: { inputSchema: { type: 'string' } },
      },
      activities: {
        zPing: { queue: 'q', outputSchema: { type: 'string' } },
        aPing: { queue: 'q', outputSchema: { type: 'string' } },
      },
    });
    const output = emitRegistryDeclaration(snapshot);
    expect(output.indexOf('"alpha"')).toBeLessThan(output.indexOf('"zeta"'));
    expect(output.indexOf('"aPing"')).toBeLessThan(output.indexOf('"zPing"'));
  });

  it('uses null-prototype-safe key handling for names like __proto__', () => {
    const workflows: Record<string, { inputSchema?: Record<string, unknown> }> =
      Object.create(null);
    workflows['__proto__'] = { inputSchema: { type: 'string' } };
    workflows['valid'] = { inputSchema: { type: 'string' } };
    const output = emitRegistryDeclaration(buildSnapshot({ workflows }));
    expect(output).toContain('"__proto__"');
    expect(output).toContain('"valid"');
  });

  it('emits zero-arg activities when inputSchema is absent', () => {
    const output = emitRegistryDeclaration(
      buildSnapshot({
        activities: {
          ping: { queue: 'default', outputSchema: { type: 'string' } },
        },
      }),
    );
    expect(output).toContain('"ping": () => Promise<string>;');
    expect(output).not.toContain('(input:');
  });

  it('keeps null-input activities explicit (input: null), not zero-arg', () => {
    const output = emitRegistryDeclaration(
      buildSnapshot({
        activities: {
          poke: {
            queue: 'default',
            inputSchema: { type: 'null' },
            outputSchema: { type: 'string' },
          },
        },
      }),
    );
    expect(output).toContain('"poke": (input: null) => Promise<string>;');
  });

  it('emits unknown for workflows with no schemas', () => {
    const output = emitRegistryDeclaration(
      buildSnapshot({
        workflows: { bare: {} },
      }),
    );
    expect(output).toContain('"bare": { input: unknown; output: unknown };');
  });

  it('quotes names with special characters', () => {
    const output = emitRegistryDeclaration(
      buildSnapshot({
        workflows: { 'kebab-name': {}, 'with "quote"': {} },
      }),
    );
    expect(output).toContain('"kebab-name"');
    expect(output).toContain('"with \\"quote\\""');
  });
});
