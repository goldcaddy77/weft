import { describe, expect, it } from 'bun:test';
import { z } from 'zod';

import { emitBindings, generateOpenApiDocument } from './openapi.ts';
import { createOperationRegistry } from './operation-catalog.ts';
import { defineOperation } from './operation-registry.ts';
import type { UnknownRestBinding } from './rest-bindings.ts';
import { ROUTES, toOpenApiPath, toRegex } from './route-model.ts';

describe('OpenAPI document generation', () => {
  const document = generateOpenApiDocument();

  it('/openapi.json is a full OpenAPI 3.1 contract for the REST-ish HTTP surface. It includes path and query parameters, request bodies, response schemas by status code, shared error objects, and security declarations.', () => {
    expect(document).toHaveProperty('openapi', '3.1.0');
    expect(document).toHaveProperty('info');
    expect(document).toHaveProperty('paths');
    expect(document).toHaveProperty('tags');

    const paths = document['paths'] as Record<string, Record<string, Record<string, unknown>>>;
    expect(paths['/v1/workflows/{id}/signal/{name}']?.['post']?.['parameters']).toBeDefined();
    expect(paths['/v1/workflows']?.['post']).toHaveProperty('requestBody');

    const components = document['components'] as Record<string, unknown> | undefined;
    expect(
      document['security'] !== undefined || components?.['securitySchemes'] !== undefined,
    ).toBe(true);
  });

  it('uses default title and version', () => {
    const info = document['info'] as Record<string, unknown>;
    expect(info['title']).toBe('Weft Workflow Engine');
    expect(info['version']).toBe('0.0.1');
  });

  it('accepts custom options', () => {
    const custom = generateOpenApiDocument({
      title: 'Custom API',
      version: '2.0.0',
      serverUrl: 'https://api.example.com',
    });
    const info = custom['info'] as Record<string, unknown>;
    expect(info['title']).toBe('Custom API');
    expect(info['version']).toBe('2.0.0');
    const servers = custom['servers'] as Array<{ url: string }>;
    expect(servers[0]!.url).toBe('https://api.example.com');
  });

  it('includes all non-meta routes as path items', () => {
    const paths = document['paths'] as Record<string, unknown>;
    const domainRoutes = ROUTES.filter((r) => r.handler !== 'openApiDocument');

    for (const route of domainRoutes) {
      const openApiPath = toOpenApiPath(route.path);
      expect(paths[openApiPath]).toBeDefined();

      const pathItem = paths[openApiPath] as Record<string, unknown>;
      const method = route.method.toLowerCase();
      expect(pathItem).toHaveProperty(method);
    }
  });

  it('correctly extracts path parameters', () => {
    const paths = document['paths'] as Record<string, Record<string, Record<string, unknown>>>;
    const signalPath = paths['/v1/workflows/{id}/signal/{name}'];
    expect(signalPath).toBeDefined();

    const operation = signalPath!['post']!;
    const parameters = operation['parameters'] as Array<{ name: string; in: string }>;
    expect(parameters).toHaveLength(2);
    expect(parameters[0]!.name).toBe('id');
    expect(parameters[0]!.in).toBe('path');
    expect(parameters[1]!.name).toBe('name');
  });

  it('marks step parameter as integer type', () => {
    const paths = document['paths'] as Record<string, Record<string, Record<string, unknown>>>;
    const checkpointPath = paths['/v1/workflows/{id}/checkpoints/{step}'];
    expect(checkpointPath).toBeDefined();

    const operation = checkpointPath!['get']!;
    const parameters = operation['parameters'] as Array<{
      name: string;
      schema: { type: string };
    }>;
    const stepParam = parameters.find((p) => p.name === 'step');
    expect(stepParam!.schema.type).toBe('integer');
  });

  it('marks replay step parameter as integer type', () => {
    const paths = document['paths'] as Record<string, Record<string, Record<string, unknown>>>;
    const replayPath = paths['/v1/workflows/{id}/replay/{step}'];
    expect(replayPath).toBeDefined();

    const operation = replayPath!['get']!;
    const parameters = operation['parameters'] as Array<{
      name: string;
      schema: { type: string };
    }>;
    const stepParam = parameters.find((parameter) => parameter.name === 'step');
    expect(stepParam!.schema.type).toBe('integer');
  });

  it('includes tags sorted alphabetically', () => {
    const tags = document['tags'] as Array<{ name: string }>;
    expect(tags.length).toBeGreaterThan(0);
    const names = tags.map((t) => t.name);
    expect(names).toEqual([...names].toSorted());
  });

  it('adds requestBody for POST/PUT/PATCH routes', () => {
    const paths = document['paths'] as Record<string, Record<string, Record<string, unknown>>>;
    const startPath = paths['/v1/workflows'];
    expect(startPath).toBeDefined();
    const operation = startPath!['post']!;
    expect(operation).toHaveProperty('requestBody');
  });

  it('adds requestBody for legacy non-GET/DELETE routes emitted from the route table', () => {
    const paths = document['paths'] as Record<string, Record<string, Record<string, unknown>>>;
    const pausePath = paths['/v1/schedules/{id}/pause'];
    expect(pausePath).toBeDefined();

    const operation = pausePath!['post']!;
    expect(operation).toHaveProperty('requestBody');
  });

  it('does not add requestBody for GET routes', () => {
    const paths = document['paths'] as Record<string, Record<string, Record<string, unknown>>>;
    const healthPath = paths['/v1/health'];
    expect(healthPath).toBeDefined();
    const operation = healthPath!['get']!;
    expect(operation).not.toHaveProperty('requestBody');
  });
});

// Exercises `emitBindings` with a synthetic POST/PUT/PATCH binding so
// the body-emitting branch is covered before any production REST
// operation lives on that method. Without this, the first POST binding
// added to REST_BINDINGS would silently lose its `requestBody` entry.
describe('emitBindings — body-accepting methods', () => {
  for (const method of ['POST', 'PUT', 'PATCH'] as const) {
    it(`adds requestBody for ${method} bindings`, () => {
      const operation = defineOperation({
        name: 'weft.test.bodysuffix',
        mcpExposable: false,
        summary: 'body-accepting test op',
        inputSchema: z.object({ payload: z.unknown() }),
        outputSchema: z.unknown(),
        access: { kind: 'public' },
        transports: {
          http: true,
          jsonRpcHttp: false,
          jsonRpcWebSocket: false,
          jsonRpcStdio: false,
        },
        unknownKeyPolicy: { http: 'reject', jsonRpc: 'reject' },
        invoke: async () => ({}),
      });
      const binding: UnknownRestBinding = {
        method,
        path: '/v1/test/bodysuffix',
        pathParamNames: [],
        operationName: 'weft.test.bodysuffix',
        inputSources: { payload: { kind: 'body' } },
        extractInput: async (request) => ({ payload: await request.json() }),
        success: { kind: 'json', status: 200 },
      };
      const registry = createOperationRegistry([operation]);
      const paths: Record<string, Record<string, unknown>> = {};
      emitBindings(paths, new Set(), [binding], registry);

      const entry = paths['/v1/test/bodysuffix']?.[method.toLowerCase()] as
        | Record<string, unknown>
        | undefined;
      expect(entry).toBeDefined();
      expect(entry).toHaveProperty('requestBody');
    });
  }

  it('does not add requestBody for GET bindings', () => {
    const operation = defineOperation({
      name: 'weft.test.getread',
      mcpExposable: false,
      summary: 'get-only test op',
      inputSchema: z.object({ id: z.string() }),
      outputSchema: z.unknown(),
      access: { kind: 'public' },
      transports: { http: true, jsonRpcHttp: false, jsonRpcWebSocket: false, jsonRpcStdio: false },
      unknownKeyPolicy: { http: 'strip', jsonRpc: 'reject' },
      invoke: async () => ({}),
    });
    const binding: UnknownRestBinding = {
      method: 'GET',
      path: '/v1/test/getread/:id',
      pathParamNames: ['id'],
      operationName: 'weft.test.getread',
      inputSources: { id: { kind: 'path', pathParam: 'id' } },
      extractInput: async (_request, pathParams) => ({ id: pathParams['id'] ?? '' }),
      success: { kind: 'json', status: 200 },
    };
    const registry = createOperationRegistry([operation]);
    const paths: Record<string, Record<string, unknown>> = {};
    emitBindings(paths, new Set(), [binding], registry);

    const entry = paths['/v1/test/getread/{id}']?.['get'] as Record<string, unknown> | undefined;
    expect(entry).toBeDefined();
    expect(entry).not.toHaveProperty('requestBody');
  });

  it('does not let non-discoverable bindings suppress matching legacy routes', () => {
    const operation = defineOperation({
      name: 'weft.test.hiddenhealth',
      mcpExposable: false,
      summary: 'hidden health binding',
      inputSchema: z.object({}),
      outputSchema: z.object({ ok: z.boolean() }),
      access: { kind: 'authenticated' },
      discoverable: false,
      transports: { http: true, jsonRpcHttp: false, jsonRpcWebSocket: false, jsonRpcStdio: false },
      unknownKeyPolicy: { http: 'reject', jsonRpc: 'reject' },
      invoke: async () => ({ ok: true }),
    });
    const binding: UnknownRestBinding = {
      method: 'GET',
      path: '/v1/health',
      pathParamNames: [],
      operationName: 'weft.test.hiddenhealth',
      inputSources: {},
      extractInput: async () => ({}),
      success: { kind: 'json', status: 200 },
    };
    const document = generateOpenApiDocument({
      registry: createOperationRegistry([operation]),
      restBindings: [binding],
    });

    const legacyHealthRoute = (document['paths'] as Record<string, Record<string, unknown>>)[
      '/v1/health'
    ]?.['get'] as Record<string, unknown> | undefined;
    expect(legacyHealthRoute).toBeDefined();
    expect(legacyHealthRoute?.['operationId']).not.toBe('weft.test.hiddenhealth');
  });
});

describe('route-model helpers', () => {
  describe('toOpenApiPath', () => {
    it('converts :param to {param}', () => {
      expect(toOpenApiPath('/v1/workflows/:id/signal/:name')).toBe(
        '/v1/workflows/{id}/signal/{name}',
      );
    });

    it('handles paths without parameters', () => {
      expect(toOpenApiPath('/v1/health')).toBe('/v1/health');
    });
  });

  describe('toRegex', () => {
    it('matches a path with parameters', () => {
      const regex = toRegex('/v1/workflows/:id/signal/:name');
      const match = regex.exec('/v1/workflows/abc/signal/done');
      expect(match).not.toBeNull();
      expect(match![1]).toBe('abc');
      expect(match![2]).toBe('done');
    });

    it('rejects non-matching paths', () => {
      const regex = toRegex('/v1/workflows/:id');
      expect(regex.exec('/v1/workflows/abc/extra')).toBeNull();
    });

    it('matches numeric :step parameter', () => {
      const regex = toRegex('/v1/workflows/:id/checkpoints/:step');
      expect(regex.exec('/v1/workflows/abc/checkpoints/42')).not.toBeNull();
      expect(regex.exec('/v1/workflows/abc/checkpoints/notanumber')).toBeNull();
    });

    it('matches paths without parameters', () => {
      const regex = toRegex('/v1/health');
      expect(regex.exec('/v1/health')).not.toBeNull();
      expect(regex.exec('/v1/health/extra')).toBeNull();
    });
  });
});

// MF5: Integration test that boots serve() with a JWT auth config, fetches
// /openapi.json, and asserts the document's security schemes match what the
// live server actually enforces.  A request without a Bearer token must be
// rejected (401), proving the document's bearerAuth claim is honest.
describe('OpenAPI security schemes — live server honesty', () => {
  it('serves /openapi.json with only the configured auth schemes for an api-key-only server', async () => {
    // Dynamic import to avoid pulling the full serve() dependency into every
    // openapi.test.ts import scope — the pattern matches authentication.test.ts.
    const { serve } = await import('./index.ts');

    const { Engine } = await import('../core/engine.ts');
    const { MemoryStorage } = await import('../storage/memory.ts');

    const engine = new Engine({ storage: new MemoryStorage() });
    const server = serve({
      engine,
      port: 0,
      auth: { apiKeys: ['test-key'] },
    });

    try {
      // 1. Fetch the OpenAPI document (unauthenticated — /openapi.json is
      //    explicitly a public meta-endpoint).
      const docResponse = await fetch(`${server.url}/openapi.json`);
      expect(docResponse.status).toBe(200);
      const doc = (await docResponse.json()) as Record<string, unknown>;

      // 2. The document must declare only the active API key scheme.
      const components = doc['components'] as Record<string, Record<string, unknown>> | undefined;
      const schemes = components?.['securitySchemes'];
      expect(schemes).toBeDefined();
      expect(schemes).toHaveProperty('apiKeyAuth');
      expect(schemes).not.toHaveProperty('bearerAuth');

      // 3. The document's top-level security array must reference only
      //    the configured API key scheme.
      const security = doc['security'] as Array<Record<string, unknown>> | undefined;
      expect(Array.isArray(security)).toBe(true);
      const schemeNames = (security ?? []).flatMap((entry) => Object.keys(entry));
      expect(schemeNames).toContain('apiKeyAuth');
      expect(schemeNames).not.toContain('bearerAuth');

      // 4. Verify the api-key-only claim is honest: a request to a
      //    protected endpoint WITHOUT credentials must be rejected with 401.
      const noAuthResponse = await fetch(`${server.url}/v1/workflows`, {
        headers: { accept: 'application/json' },
      });
      expect(noAuthResponse.status).toBe(401);

      // 5. A request WITH the valid API key passes through, proving apiKeyAuth
      //    is the active enforcement mechanism and the document is not lying.
      const authResponse = await fetch(`${server.url}/v1/workflows`, {
        headers: { 'x-api-key': 'test-key', accept: 'application/json' },
      });
      expect(authResponse.status).toBe(200);
    } finally {
      await server.stop();
      engine[Symbol.dispose]();
    }
  });
});
