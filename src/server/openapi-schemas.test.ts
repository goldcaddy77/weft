import { describe, expect, it } from 'bun:test';
import { z } from 'zod';

import { extractComponentsSchemas } from './openapi-schemas.ts';
import { createOperationRegistry, type RegistrableOperation } from './operation-catalog.ts';
import { defineOperation } from './operation-registry.ts';

function makeOperation(options: {
  readonly name: string;
  readonly inputSchema: z.ZodType;
  readonly outputSchema: z.ZodType;
  readonly eventSchema?: z.ZodType;
}): RegistrableOperation {
  return defineOperation({
    name: options.name,
    summary: 'test operation',
    tags: ['Tests'],
    inputSchema: options.inputSchema,
    outputSchema: options.outputSchema,
    ...(options.eventSchema === undefined ? {} : { eventSchema: options.eventSchema }),
    access: { kind: 'public' },
    transports: { http: true, jsonRpcHttp: true, jsonRpcWebSocket: true, jsonRpcStdio: true },
    unknownKeyPolicy: { http: 'reject', jsonRpc: 'reject' },
    invoke: async () => ({}),
  });
}

function isReference(value: unknown): value is { readonly $ref: string } {
  return value !== null && typeof value === 'object' && '$ref' in value;
}

describe('extractComponentsSchemas', () => {
  it('hoists duplicate schemas to one component and returns refs for both owners', () => {
    const registry = createOperationRegistry([
      makeOperation({
        name: 'weft.alpha.one',
        inputSchema: z.object({ id: z.string() }),
        outputSchema: z.object({ firstResult: z.string() }),
      }),
      makeOperation({
        name: 'weft.beta.two',
        inputSchema: z.object({ id: z.string() }),
        outputSchema: z.object({ secondResult: z.string() }),
      }),
    ]);

    const helper = extractComponentsSchemas(registry);

    expect(Object.keys(helper.components)).toEqual(['WeftAlphaOneInput']);
    expect(helper.refFor('weft.alpha.one', 'Input')).toEqual({
      $ref: '#/components/schemas/WeftAlphaOneInput',
    });
    expect(helper.refFor('weft.beta.two', 'Input')).toEqual({
      $ref: '#/components/schemas/WeftAlphaOneInput',
    });
  });

  it('returns inline schemas for single-use schemas', () => {
    const registry = createOperationRegistry([
      makeOperation({
        name: 'weft.single.use',
        inputSchema: z.object({ id: z.string() }),
        outputSchema: z.object({ ok: z.boolean() }),
      }),
    ]);

    const helper = extractComponentsSchemas(registry);
    const inputSchema = helper.refFor('weft.single.use', 'Input');

    expect(helper.components).toEqual({});
    expect(isReference(inputSchema)).toBe(false);
    expect(inputSchema).toEqual(
      expect.objectContaining({
        type: 'object',
        properties: expect.objectContaining({
          id: expect.objectContaining({ type: 'string' }),
        }),
      }),
    );
  });

  it('generates byte-identical components across repeated extraction', () => {
    const registry = createOperationRegistry([
      makeOperation({
        name: 'weft.alpha.one',
        inputSchema: z.object({ id: z.string() }),
        outputSchema: z.object({ firstResult: z.string() }),
      }),
      makeOperation({
        name: 'weft.beta.two',
        inputSchema: z.object({ id: z.string() }),
        outputSchema: z.object({ secondResult: z.string() }),
      }),
    ]);

    const first = extractComponentsSchemas(registry);
    const second = extractComponentsSchemas(registry);

    expect(JSON.stringify(first.components)).toBe(JSON.stringify(second.components));
  });

  it('handles event schemas when present', () => {
    const eventSchema = z.object({ sequence: z.number(), value: z.string() });
    const registry = createOperationRegistry([
      makeOperation({
        name: 'weft.events.alpha',
        inputSchema: z.object({ alpha: z.string() }),
        outputSchema: z.object({ alphaStarted: z.boolean() }),
        eventSchema,
      }),
      makeOperation({
        name: 'weft.events.beta',
        inputSchema: z.object({ beta: z.string() }),
        outputSchema: z.object({ betaStarted: z.boolean() }),
        eventSchema,
      }),
    ]);

    const helper = extractComponentsSchemas(registry);

    expect(helper.components).toHaveProperty('WeftEventsAlphaEvent');
    expect(helper.refFor('weft.events.alpha', 'Event')).toEqual({
      $ref: '#/components/schemas/WeftEventsAlphaEvent',
    });
    expect(helper.refFor('weft.events.beta', 'Event')).toEqual({
      $ref: '#/components/schemas/WeftEventsAlphaEvent',
    });
  });
});
