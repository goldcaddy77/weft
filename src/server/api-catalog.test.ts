import { afterEach, describe, expect, it } from 'bun:test';

import { Engine } from '../core/engine.ts';
import { MemoryStorage } from '../storage/memory.ts';
import { generateApiCatalog, originFromRequest } from './api-catalog.ts';
import { handleRequest } from './handler.ts';

function createEngine(): Engine {
  return new Engine({ storage: new MemoryStorage() });
}

describe('API catalog linkset', () => {
  let engine: Engine | undefined;

  afterEach(() => {
    engine?.[Symbol.dispose]();
    engine = undefined;
  });

  it('generates an RFC 9264 linkset with service descriptions sorted by href', () => {
    const document = generateApiCatalog({ origin: 'https://api.example.com' });

    expect(document).toEqual({
      linkset: [
        {
          anchor: 'https://api.example.com',
          'service-desc': [
            {
              href: 'https://api.example.com/asyncapi.json',
              type: 'application/asyncapi+json',
            },
            {
              href: 'https://api.example.com/openapi.json',
              type: 'application/openapi+json',
            },
            {
              href: 'https://api.example.com/openrpc.json',
              type: 'application/json',
            },
          ],
        },
      ],
    });
  });

  it('extracts the request origin from forwarded protocol and host headers', () => {
    const request = new Request('https://ignored.example/.well-known/api-catalog', {
      headers: {
        host: 'api.example.com',
        'x-forwarded-proto': 'http',
      },
    });

    expect(originFromRequest(request)).toBe('http://api.example.com');
  });

  it('serves the route as application/linkset+json', async () => {
    engine = createEngine();
    const response = await handleRequest(
      new Request('https://api.example.com/.well-known/api-catalog', {
        headers: {
          host: 'api.example.com',
          'x-forwarded-proto': 'https',
        },
      }),
      engine,
    );

    expect(response.status).toBe(200);
    expect(response.headers.get('Content-Type')).toBe('application/linkset+json');
    const body = (await response.json()) as Record<string, unknown>;
    expect(body['linkset']).toBeDefined();
  });
});
