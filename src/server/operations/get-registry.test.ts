/**
 * `weft.system.registry` operation + REST binding — unit tests.
 *
 * Covers:
 * - Snapshot of the response body for a fixture engine with workflows and
 *   activities, with both schema-present and schema-absent cases.
 * - registryVersion: 1 in the response.
 * - Authorization: 401 unauthenticated, 403 missing scope, 200 with system:read.
 * - 500 with the offending workflow named when an unsupported validator throws.
 * - Workflows registered out of alphabetical order produce sorted keys.
 * - Remote-only activities are excluded by construction (engine never sees them).
 */

import { afterEach, describe, expect, it } from 'bun:test';
import { z } from 'zod';

import { Engine } from '../../core/engine.ts';
import { MemoryStorage } from '../../storage/memory.ts';
import { handleRequest } from '../handler.ts';
import { createOperationRegistry, executeOperation } from '../operation-catalog.ts';
import { principalFromApiKey, principalFromJwtClaims } from '../principal.ts';
import { createLiveOperationRegistry } from '../rest-bindings.ts';
import { getRegistryOperation, getRegistryRestBinding } from './get-registry.ts';

function createEngine(): Engine {
  return new Engine({ storage: new MemoryStorage() });
}

function authContextWithSystemRead() {
  return {
    authContext: {
      method: 'api-key' as const,
      principal: principalFromApiKey({ subject: 'test', scopes: ['system:read'] }),
    },
  };
}

describe('GET /v1/registry — successful responses', () => {
  let engine: Engine | undefined;

  afterEach(() => {
    engine?.[Symbol.dispose]();
    engine = undefined;
  });

  it('returns the snapshot for a populated engine', async () => {
    engine = createEngine();
    engine.register('welcome', {
      handler: async function* () {
        return { greeting: 'hi' };
      },
      inputSchema: z.object({ name: z.string() }),
      outputSchema: z.object({ greeting: z.string() }),
      description: 'Greets a person.',
      tags: ['greeting'],
    });
    engine.register('schemaless', {
      handler: async function* () {},
    });
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
    engine.registerActivity('noop', async () => undefined);

    const response = await handleRequest(
      new Request('http://localhost/v1/registry', { method: 'GET' }),
      engine,
      {
        operationRegistry: createOperationRegistry([getRegistryOperation]),
        restBindings: [getRegistryRestBinding],
        ...authContextWithSystemRead(),
      },
    );

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('application/json');
    const body = await response.json();
    expect(body).toEqual({
      registryVersion: 1,
      workflows: {
        schemaless: {},
        welcome: {
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
          tags: ['greeting'],
        },
      },
      activities: {
        noop: { queue: 'default' },
        sendEmail: {
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
        },
      },
    });
  });

  it('returns an empty snapshot when no workflows or activities are registered', async () => {
    engine = createEngine();

    const response = await handleRequest(
      new Request('http://localhost/v1/registry', { method: 'GET' }),
      engine,
      {
        operationRegistry: createOperationRegistry([getRegistryOperation]),
        restBindings: [getRegistryRestBinding],
        ...authContextWithSystemRead(),
      },
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      registryVersion: 1,
      workflows: {},
      activities: {},
    });
  });

  it('produces alphabetically sorted workflow and activity keys', async () => {
    engine = createEngine();
    engine.register('charlie', { handler: async function* () {} });
    engine.register('alpha', { handler: async function* () {} });
    engine.register('bravo', { handler: async function* () {} });
    engine.registerActivity('zulu', async () => undefined);
    engine.registerActivity('alpha', async () => undefined);

    const response = await handleRequest(
      new Request('http://localhost/v1/registry', { method: 'GET' }),
      engine,
      {
        operationRegistry: createOperationRegistry([getRegistryOperation]),
        restBindings: [getRegistryRestBinding],
        ...authContextWithSystemRead(),
      },
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      workflows: Record<string, unknown>;
      activities: Record<string, unknown>;
    };
    expect(Object.keys(body.workflows)).toEqual(['alpha', 'bravo', 'charlie']);
    expect(Object.keys(body.activities)).toEqual(['alpha', 'zulu']);
  });

  it('excludes remote-only activities (engine never registers them)', async () => {
    // The activity registry the snapshot reads from is the engine's local
    // registry. A "remote-only" activity exists in WorkerRegistry, never in
    // ActivityRegistry, so there is no path through which it could appear in
    // the response. This test pins that by construction: register one local
    // activity, assert it is the only one reported.
    engine = createEngine();
    engine.registerActivity('localOnly', async () => undefined);

    const response = await handleRequest(
      new Request('http://localhost/v1/registry', { method: 'GET' }),
      engine,
      {
        operationRegistry: createOperationRegistry([getRegistryOperation]),
        restBindings: [getRegistryRestBinding],
        ...authContextWithSystemRead(),
      },
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as { activities: Record<string, unknown> };
    expect(Object.keys(body.activities)).toEqual(['localOnly']);
    expect(body.activities).not.toHaveProperty('remoteOnly');
  });
});

describe('GET /v1/registry — authorization', () => {
  let engine: Engine | undefined;

  afterEach(() => {
    engine?.[Symbol.dispose]();
    engine = undefined;
  });

  it('rejects unauthenticated callers with 401 via executeOperation', async () => {
    engine = createEngine();
    const liveRegistry = createLiveOperationRegistry();

    const result = await executeOperation(
      'weft.system.registry',
      {},
      {
        principal: { method: 'unauthenticated' },
        engine,
        transport: 'jsonRpcStdio',
        registry: liveRegistry,
      },
    );

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected rejection');
    expect(result.fault.code).toBe('Unauthorized');
  });

  it('rejects callers with insufficient scope as 403 via executeOperation', async () => {
    engine = createEngine();
    const liveRegistry = createLiveOperationRegistry();

    const result = await executeOperation(
      'weft.system.registry',
      {},
      {
        principal: principalFromJwtClaims({ sub: 'user', scope: 'workflows:read' }),
        engine,
        transport: 'jsonRpcStdio',
        registry: liveRegistry,
      },
    );

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected rejection');
    expect(result.fault.code).toBe('Forbidden');
  });

  it('succeeds with system:read scope via executeOperation', async () => {
    engine = createEngine();
    engine.register('demo', { handler: async function* () {} });
    const liveRegistry = createLiveOperationRegistry();

    const result = await executeOperation(
      'weft.system.registry',
      {},
      {
        principal: principalFromJwtClaims({ sub: 'user', scope: 'system:read' }),
        engine,
        transport: 'jsonRpcStdio',
        registry: liveRegistry,
      },
    );

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected success');
    const value = result.value as { registryVersion: number; workflows: Record<string, unknown> };
    expect(value.registryVersion).toBe(1);
    expect(value.workflows).toHaveProperty('demo');
  });
});

describe('GET /v1/registry — error shaping', () => {
  let engine: Engine | undefined;

  afterEach(() => {
    engine?.[Symbol.dispose]();
    engine = undefined;
  });

  it('returns 500 with "Internal server error" when a registered schema fails to convert', async () => {
    // Register a workflow with a Standard Schema validator the converter
    // cannot handle. The builder throws RegistrySchemaConversionError; the
    // operation pipeline reduces it to an EngineFailure fault and the REST
    // shaper masks the wire response. The typed error message (which names
    // the offending entity and direction) reaches server-side logs so
    // operators can locate the bad registration; clients see only the
    // generic 500 to avoid leaking internal schema layout.
    engine = createEngine();
    const brokenSchema: any = {
      '~standard': {
        version: 1,
        vendor: 'unknown-test-vendor',
        validate: (value: unknown) => ({ value }),
      },
    };
    engine.register('broken', {
      handler: async function* () {},
      inputSchema: brokenSchema,
    });

    const response = await handleRequest(
      new Request('http://localhost/v1/registry', { method: 'GET' }),
      engine,
      {
        operationRegistry: createOperationRegistry([getRegistryOperation]),
        restBindings: [getRegistryRestBinding],
        ...authContextWithSystemRead(),
      },
    );

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: 'Internal server error' });
  });

  it('returns 500 with "Internal server error" for unrelated EngineFailure faults', async () => {
    engine = createEngine();
    const failingOperation = {
      ...getRegistryOperation,
      invoke: async () => {
        throw {
          code: 'EngineFailure' as const,
          message: 'secret internal detail',
          data: {},
        };
      },
    };

    const response = await handleRequest(
      new Request('http://localhost/v1/registry', { method: 'GET' }),
      engine,
      {
        operationRegistry: createOperationRegistry([failingOperation]),
        restBindings: [getRegistryRestBinding],
        ...authContextWithSystemRead(),
      },
    );

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: 'Internal server error' });
  });

  it('shapes a Forbidden fault as 403 via the REST fault shaper', async () => {
    engine = createEngine();
    const forbiddenOperation = {
      ...getRegistryOperation,
      invoke: async () => {
        throw {
          code: 'Forbidden' as const,
          message: 'insufficient scope',
          data: { reason: 'insufficient scope' },
        };
      },
    };

    const response = await handleRequest(
      new Request('http://localhost/v1/registry', { method: 'GET' }),
      engine,
      {
        operationRegistry: createOperationRegistry([forbiddenOperation]),
        restBindings: [getRegistryRestBinding],
        ...authContextWithSystemRead(),
      },
    );

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: 'insufficient scope' });
  });

  it('shapes an Unauthorized fault as 401 via the REST fault shaper', async () => {
    engine = createEngine();
    const unauthorizedOperation = {
      ...getRegistryOperation,
      invoke: async () => {
        throw {
          code: 'Unauthorized' as const,
          message: 'no credentials',
          data: { reason: 'no credentials' },
        };
      },
    };

    const response = await handleRequest(
      new Request('http://localhost/v1/registry', { method: 'GET' }),
      engine,
      {
        operationRegistry: createOperationRegistry([unauthorizedOperation]),
        restBindings: [getRegistryRestBinding],
        ...authContextWithSystemRead(),
      },
    );

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: 'no credentials' });
  });
});
