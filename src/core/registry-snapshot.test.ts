/**
 * Tests for the registry snapshot builder.
 */

import { afterEach, describe, expect, it } from 'bun:test';
import { z } from 'zod';

import { MemoryStorage } from '../storage/memory.ts';
import { Engine } from './engine.ts';
import { buildRegistrySnapshot, REGISTRY_VERSION } from './registry-snapshot.ts';

function createEngine(): Engine {
  return new Engine({ storage: new MemoryStorage() });
}

describe('buildRegistrySnapshot', () => {
  let engine: Engine | undefined;

  afterEach(() => {
    engine?.[Symbol.dispose]();
    engine = undefined;
  });

  it('returns registryVersion 1', () => {
    engine = createEngine();
    const snapshot = buildRegistrySnapshot(engine);
    expect(snapshot.registryVersion).toBe(REGISTRY_VERSION);
    expect(snapshot.registryVersion).toBe(1);
  });

  it('includes workflows with their schema, description, and tags', () => {
    engine = createEngine();
    engine.register('welcome', {
      handler: async function* () {
        return { greeting: 'hi' };
      },
      inputSchema: z.object({ name: z.string() }),
      outputSchema: z.object({ greeting: z.string() }),
      description: 'Greets a person.',
      tags: ['greeting', 'demo'],
    });

    const snapshot = buildRegistrySnapshot(engine);

    expect(snapshot.workflows['welcome']).toEqual({
      inputSchema: {
        type: 'object',
        properties: { name: { type: 'string' } },
        required: ['name'],
        additionalProperties: false,
      },
      outputSchema: {
        type: 'object',
        properties: { greeting: { type: 'string' } },
        required: ['greeting'],
        additionalProperties: false,
      },
      description: 'Greets a person.',
      tags: ['greeting', 'demo'],
    });
  });

  it('omits schema fields that are absent on the workflow registration', () => {
    engine = createEngine();
    engine.register('schemaless', async function* () {});

    const snapshot = buildRegistrySnapshot(engine);

    const entry = snapshot.workflows['schemaless'];
    expect(entry).toBeDefined();
    expect(entry).not.toHaveProperty('inputSchema');
    expect(entry).not.toHaveProperty('outputSchema');
    expect(entry).not.toHaveProperty('description');
  });

  it('includes only one schema when only the input schema is registered', () => {
    engine = createEngine();
    engine.register('partial', {
      handler: async function* () {},
      inputSchema: z.object({ x: z.number() }),
    });

    const snapshot = buildRegistrySnapshot(engine);
    const entry = snapshot.workflows['partial'];
    expect(entry).toBeDefined();
    expect(entry?.inputSchema).toBeDefined();
    expect(entry).not.toHaveProperty('outputSchema');
  });

  it('does not emit empty tags arrays', () => {
    engine = createEngine();
    engine.register('untagged', async function* () {});

    const snapshot = buildRegistrySnapshot(engine);
    expect(snapshot.workflows['untagged']).not.toHaveProperty('tags');
  });

  it('includes activities with queue, schemas, and description', () => {
    engine = createEngine();
    engine.registerActivity(
      'sendEmail',
      async (input: { to: string }) => ({ delivered: true, recipient: input.to }),
      {
        queue: 'mail',
        inputSchema: z.object({ to: z.string() }),
        outputSchema: z.object({ delivered: z.boolean(), recipient: z.string() }),
        description: 'Sends an email.',
      },
    );

    const snapshot = buildRegistrySnapshot(engine);
    expect(snapshot.activities['sendEmail']).toEqual({
      queue: 'mail',
      inputSchema: {
        type: 'object',
        properties: { to: { type: 'string' } },
        required: ['to'],
        additionalProperties: false,
      },
      outputSchema: {
        type: 'object',
        properties: {
          delivered: { type: 'boolean' },
          recipient: { type: 'string' },
        },
        required: ['delivered', 'recipient'],
        additionalProperties: false,
      },
      description: 'Sends an email.',
    });
  });

  it('omits activity schema fields that are absent on registration', () => {
    engine = createEngine();
    engine.registerActivity('noop', async function* () {});

    const snapshot = buildRegistrySnapshot(engine);
    const entry = snapshot.activities['noop'];
    expect(entry).toBeDefined();
    expect(entry).not.toHaveProperty('inputSchema');
    expect(entry).not.toHaveProperty('outputSchema');
    expect(entry).not.toHaveProperty('description');
    // queue is always present (engine assigns a default)
    expect(typeof entry?.queue).toBe('string');
  });

  it('returns an empty registry when no workflows or activities are registered', () => {
    engine = createEngine();
    const snapshot = buildRegistrySnapshot(engine);
    expect(snapshot.workflows).toEqual({});
    expect(snapshot.activities).toEqual({});
  });

  it('orders workflow keys alphabetically by codepoint', () => {
    engine = createEngine();
    engine.register('charlie', async function* () {});
    engine.register('alpha', async function* () {});
    engine.register('bravo', async function* () {});

    const snapshot = buildRegistrySnapshot(engine);
    expect(Object.keys(snapshot.workflows)).toEqual(['alpha', 'bravo', 'charlie']);
  });

  it('orders activity keys alphabetically by codepoint', () => {
    engine = createEngine();
    engine.registerActivity('xyz', async function* () {});
    engine.registerActivity('abc', async function* () {});
    engine.registerActivity('mno', async function* () {});

    const snapshot = buildRegistrySnapshot(engine);
    expect(Object.keys(snapshot.activities)).toEqual(['abc', 'mno', 'xyz']);
  });

  it('places integer-like keys first per ECMAScript object iteration semantics', () => {
    engine = createEngine();
    engine.register('alpha', async function* () {});
    engine.register('42', async function* () {});
    engine.register('beta', async function* () {});

    const snapshot = buildRegistrySnapshot(engine);
    // Per ECMAScript: integer-index keys come first in numeric order, then
    // string keys in insertion order. Our insertion is alphabetical, so the
    // observable order is: ["42", "alpha", "beta"].
    expect(Object.keys(snapshot.workflows)).toEqual(['42', 'alpha', 'beta']);
  });

  it('throws with workflow name and direction when input schema conversion fails', () => {
    engine = createEngine();
    const brokenSchema = makeBrokenSchema('input');
    engine.register('broken', {
      handler: async function* () {},
      inputSchema: brokenSchema,
    });

    expect(() => buildRegistrySnapshot(engine!)).toThrow(
      /Failed to convert inputSchema for workflow "broken"/,
    );
  });

  it('throws with workflow name and direction when output schema conversion fails', () => {
    engine = createEngine();
    const brokenSchema = makeBrokenSchema('output');
    engine.register('broken', {
      handler: async function* () {},
      outputSchema: brokenSchema,
    });

    expect(() => buildRegistrySnapshot(engine!)).toThrow(
      /Failed to convert outputSchema for workflow "broken"/,
    );
  });

  it('throws with activity name and direction when input schema conversion fails', () => {
    engine = createEngine();
    const brokenSchema = makeBrokenSchema('input');
    engine.registerActivity('brokenActivity', async function* () {}, {
      inputSchema: brokenSchema,
    });

    expect(() => buildRegistrySnapshot(engine!)).toThrow(
      /Failed to convert inputSchema for activity "brokenActivity"/,
    );
  });

  it('throws with activity name and direction when output schema conversion fails', () => {
    engine = createEngine();
    const brokenSchema = makeBrokenSchema('output');
    engine.registerActivity('brokenActivity', async function* () {}, {
      outputSchema: brokenSchema,
    });

    expect(() => buildRegistrySnapshot(engine!)).toThrow(
      /Failed to convert outputSchema for activity "brokenActivity"/,
    );
  });

  it('does not include remote-only activities (workers without local registrations are excluded)', () => {
    engine = createEngine();
    // Locally register one activity. A "remote-only" activity is one that exists only
    // on a connected worker, not in the engine's activity registry. Since
    // buildRegistrySnapshot only reads from engine.listActivityDefinitions(), there is
    // no path through which a remote-only name could leak into the snapshot.
    engine.registerActivity('local', async function* () {});
    const snapshot = buildRegistrySnapshot(engine);
    expect(Object.keys(snapshot.activities)).toEqual(['local']);
    // Sanity: a fictitious remote-only name must not appear.
    expect(snapshot.activities).not.toHaveProperty('remoteOnly');
  });
});

/**
 * Build a Standard Schema-compatible validator that fails conversion: it
 * declares an unknown vendor and exposes no `~standard.jsonSchema` converter,
 * so `definitionSchemaToJsonSchema` will throw.
 */
function makeBrokenSchema(label: string): {
  '~standard': {
    version: 1;
    vendor: string;
    validate: (value: unknown) => { value: unknown };
  };
} {
  return {
    '~standard': {
      version: 1,
      vendor: `unknown-${label}`,
      validate: (value: unknown) => ({ value }),
    },
  };
}
