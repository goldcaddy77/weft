import { afterEach, describe, expect, it, spyOn } from 'bun:test';

import { createTransportForSource } from './transport-factory.ts';
import { HttpSseTransport } from './transport-http-sse.ts';
import { HttpTransport } from './transport-http.ts';
import { StdioTransport } from './transport-stdio.ts';

const originalFetch = globalThis.fetch;

function mockFetch(implementation: (...args: any[]) => Promise<Response>): void {
  const mock = Object.assign(implementation, { preconnect: (_url: string) => {} });
  globalThis.fetch = mock as typeof fetch;
}

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe('createTransportForSource', () => {
  it('creates a stdio transport and warns when HTTP auth is configured', async () => {
    const warningSpy = spyOn(console, 'warn').mockImplementation(() => {});

    try {
      const transport = await createTransportForSource({
        mcp: 'stdio:///bin/tool?mode=read',
        auth: { type: 'bearer', token: 'secret-token' },
      });

      expect(transport).toBeInstanceOf(StdioTransport);
      expect(warningSpy).toHaveBeenCalledWith(
        '[MCP] Auth config ignored for stdio transport: stdio:///bin/tool?mode=read. Stdio uses process-level credentials, not HTTP headers.',
      );

      transport[Symbol.dispose]();
    } finally {
      warningSpy.mockRestore();
    }
  });

  it('creates an HTTP transport for default HTTP sources', async () => {
    const transport = await createTransportForSource({ mcp: 'https://mcp.example.com' });

    expect(transport).toBeInstanceOf(HttpTransport);

    transport[Symbol.dispose]();
  });

  it('creates an SSE transport when requested explicitly', async () => {
    const transport = await createTransportForSource({
      mcp: 'https://mcp.example.com',
      transport: 'sse',
      timeout: 1234,
    });

    expect(transport).toBeInstanceOf(HttpSseTransport);

    transport[Symbol.dispose]();
  });

  it('uses OAuth2 tokens when resolving HTTP transport headers', async () => {
    let tokenRequests = 0;
    let capturedAuthorizationHeader = '';

    mockFetch(async (input: any, init: any) => {
      const url = typeof input === 'string' ? input : input.url;

      if (url === 'https://auth.example.com/token') {
        tokenRequests++;
        return new Response(JSON.stringify({ access_token: 'oauth-token', expires_in: 3600 }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }

      if (url === 'https://mcp.example.com/health') {
        capturedAuthorizationHeader = new Headers(init?.headers).get('Authorization') ?? '';
        return new Response('OK', { status: 200 });
      }

      return new Response('Not Found', { status: 404 });
    });

    const transport = await createTransportForSource({
      mcp: 'https://mcp.example.com',
      auth: {
        type: 'oauth2',
        tokenEndpoint: 'https://auth.example.com/token',
        clientId: 'client-id',
        clientSecret: 'client-secret',
      },
    });

    try {
      expect(await transport.healthCheck()).toBe(true);
      expect(tokenRequests).toBe(1);
      expect(capturedAuthorizationHeader).toBe('Bearer oauth-token');
    } finally {
      transport[Symbol.dispose]();
    }
  });
});
