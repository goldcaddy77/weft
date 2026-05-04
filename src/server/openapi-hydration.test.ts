import { afterEach, describe, expect, it } from 'bun:test';

import { Engine } from '../core/engine.ts';
import { MemoryStorage } from '../storage/memory.ts';
import { serve, type WeftServer } from './index.ts';

describe('OpenAPI hydration', () => {
  const servers: WeftServer[] = [];
  const engines: Engine[] = [];

  afterEach(async () => {
    while (servers.length > 0) await servers.pop()?.stop();
    while (engines.length > 0) engines.pop()?.[Symbol.dispose]();
  });

  it('requestBody for weft.workflows.start has real schema instead of the old stub', async () => {
    const engine = new Engine({ storage: new MemoryStorage() });
    engines.push(engine);
    const server = serve({ engine, port: 0 });
    servers.push(server);

    const response = await fetch(`${server.url}/openapi.json`);
    expect(response.status).toBe(200);
    const document = (await response.json()) as Record<string, unknown>;

    const paths = document['paths'] as Record<string, Record<string, Record<string, unknown>>>;
    const startOperation = paths['/v1/workflows']?.['post'];
    expect(startOperation).toBeDefined();
    const requestBody = startOperation!['requestBody'] as Record<string, unknown>;
    const content = requestBody['content'] as Record<string, Record<string, unknown>>;
    const schema = content['application/json']?.['schema'];

    expect(schema).not.toEqual({ type: 'object' });
    expect(schema !== null && typeof schema === 'object').toBe(true);
    expect('$ref' in (schema as object) || 'properties' in (schema as object)).toBe(true);
  });

  it('responses include universal-default error codes for every cataloged operation', async () => {
    const engine = new Engine({ storage: new MemoryStorage() });
    engines.push(engine);
    const server = serve({ engine, port: 0 });
    servers.push(server);

    const response = await fetch(`${server.url}/openapi.json`);
    const document = (await response.json()) as Record<string, unknown>;
    const paths = document['paths'] as Record<string, Record<string, Record<string, unknown>>>;
    const universalStatuses = ['400', '401', '403', '500'];

    for (const [path, pathItem] of Object.entries(paths)) {
      for (const [method, operation] of Object.entries(pathItem)) {
        if (typeof operation['operationId'] !== 'string') continue;
        if (!operation['operationId'].startsWith('weft.')) continue;

        const responses = operation['responses'] as Record<string, unknown> | undefined;
        expect(responses).toBeDefined();
        for (const status of universalStatuses) {
          expect(
            responses,
            `Path ${path} method ${method} missing status ${status}`,
          ).toHaveProperty(status);
        }
      }
    }
  });

  it('components.schemas has Error schema', async () => {
    const engine = new Engine({ storage: new MemoryStorage() });
    engines.push(engine);
    const server = serve({ engine, port: 0 });
    servers.push(server);

    const response = await fetch(`${server.url}/openapi.json`);
    const document = (await response.json()) as Record<string, unknown>;
    const components = document['components'] as Record<string, unknown> | undefined;
    const schemas = components?.['schemas'] as Record<string, unknown> | undefined;

    expect(schemas).toBeDefined();
    expect(schemas).toHaveProperty('Error');
  });

  it('document is deterministic across two generations', async () => {
    const engine = new Engine({ storage: new MemoryStorage() });
    engines.push(engine);
    const server = serve({ engine, port: 0 });
    servers.push(server);

    const firstResponse = await fetch(`${server.url}/openapi.json`);
    const secondResponse = await fetch(`${server.url}/openapi.json`);

    expect(await firstResponse.text()).toBe(await secondResponse.text());
  });
});
