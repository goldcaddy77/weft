import { afterEach, describe, expect, it } from 'bun:test';

import { Engine } from '../core/engine.ts';
import { MemoryStorage } from '../storage/memory.ts';
import {
  generateApiCatalog,
  originFromRequest,
  resetPublicOriginWarningForTesting,
} from './api-catalog.ts';
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

  it('prefers the request URL origin over header-derived values', () => {
    // The request URL reflects the actual incoming scheme/host pair as
    // Bun.serve() resolved them. Headers are client-controllable so they
    // are NOT used when the URL is authoritative.
    const request = new Request('https://api.example.com/.well-known/api-catalog', {
      headers: {
        host: 'attacker.example',
        'x-forwarded-proto': 'http',
      },
    });

    expect(originFromRequest(request)).toBe('https://api.example.com');
  });

  it('rejects an unrecognized X-Forwarded-Proto value', () => {
    // The request URL takes precedence here, so the malicious proto can't
    // poison the result. This test pins the behavior — even when the URL
    // is authoritative, the result is the URL's origin, not header text.
    const request = new Request('https://api.example.com/.well-known/api-catalog', {
      headers: {
        host: 'api.example.com',
        'x-forwarded-proto': 'javascript',
      },
    });

    expect(originFromRequest(request)).toBe('https://api.example.com');
  });

  it('rejects a malformed Host header pattern', () => {
    // Same precedence applies — URL wins, malformed host header is ignored.
    const request = new Request('https://api.example.com/.well-known/api-catalog', {
      headers: {
        host: 'evil@attacker/path',
        'x-forwarded-proto': 'https',
      },
    });

    expect(originFromRequest(request)).toBe('https://api.example.com');
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

  it('uses an explicit publicOrigin from handler options instead of request-derived origin', async () => {
    engine = createEngine();
    const response = await handleRequest(
      new Request('https://attacker.example/.well-known/api-catalog'),
      engine,
      { publicOrigin: 'https://api.example.com' },
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as { linkset?: { anchor?: string }[] };
    expect(body.linkset?.[0]?.anchor).toBe('https://api.example.com');
  });

  it('warns once when publicOrigin is unset and the route falls back to request-derived origin', async () => {
    engine = createEngine();
    resetPublicOriginWarningForTesting();
    const originalWarn = console.warn;
    const warnings: string[] = [];
    console.warn = (...args: unknown[]) => {
      warnings.push(args.map(String).join(' '));
    };
    try {
      await handleRequest(new Request('https://api.example.com/.well-known/api-catalog'), engine);
      await handleRequest(new Request('https://api.example.com/.well-known/api-catalog'), engine);
    } finally {
      console.warn = originalWarn;
    }
    const matching = warnings.filter((line) =>
      line.includes('/.well-known/api-catalog: `publicOrigin` is not configured'),
    );
    // One-shot warning: only the first call should log.
    expect(matching).toHaveLength(1);
  });

  it('does not warn when publicOrigin is configured', async () => {
    engine = createEngine();
    resetPublicOriginWarningForTesting();
    const originalWarn = console.warn;
    const warnings: string[] = [];
    console.warn = (...args: unknown[]) => {
      warnings.push(args.map(String).join(' '));
    };
    try {
      await handleRequest(new Request('https://api.example.com/.well-known/api-catalog'), engine, {
        publicOrigin: 'https://api.example.com',
      });
    } finally {
      console.warn = originalWarn;
    }
    const matching = warnings.filter((line) => line.includes('publicOrigin'));
    expect(matching).toHaveLength(0);
  });
});
