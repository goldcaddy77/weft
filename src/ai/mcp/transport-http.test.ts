import { afterEach, describe, expect, it } from 'bun:test';

import { MCPTransportError } from './transport';
import { HttpTransport } from './transport-http';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const originalFetch = globalThis.fetch;

function mockFetch(implementation: (...args: any[]) => Promise<Response>): void {
  const mock = Object.assign(implementation, { preconnect: (_url: string) => {} });
  globalThis.fetch = mock as typeof fetch;
}

afterEach(() => {
  globalThis.fetch = originalFetch;
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('HttpTransport', () => {
  describe('send', () => {
    it('maps tools/list to GET /tools', async () => {
      let capturedUrl = '';
      let capturedMethod = '';

      mockFetch(async (input: any, init: any) => {
        capturedUrl = typeof input === 'string' ? input : input.url;
        capturedMethod = init?.method ?? 'GET';
        return new Response(JSON.stringify({ tools: [] }), { status: 200 });
      });

      const transport = new HttpTransport({ serverUrl: 'https://mcp.example.com' });
      await transport.send({ method: 'tools/list' });

      expect(capturedUrl).toBe('https://mcp.example.com/tools');
      expect(capturedMethod).toBe('GET');
    });

    it('maps tools/invoke to POST /tools/invoke with body', async () => {
      let capturedBody: unknown;

      mockFetch(async (_input: any, init: any) => {
        capturedBody = JSON.parse(init?.body);
        return new Response(JSON.stringify({ result: { matches: 5 } }), { status: 200 });
      });

      const transport = new HttpTransport({ serverUrl: 'https://mcp.example.com' });
      const response = await transport.send({
        method: 'tools/invoke',
        params: { name: 'search', input: { query: 'hello' } },
      });

      expect(capturedBody).toEqual({ name: 'search', input: { query: 'hello' } });
      expect(response.result).toEqual({ result: { matches: 5 } });
    });

    it('includes custom headers', async () => {
      let capturedHeaders: Headers | undefined;

      mockFetch(async (_input: any, init: any) => {
        capturedHeaders = new Headers(init?.headers);
        return new Response(JSON.stringify({}), { status: 200 });
      });

      const transport = new HttpTransport({
        serverUrl: 'https://mcp.example.com',
        headers: { Authorization: 'Bearer test-token' },
      });
      await transport.send({ method: 'tools/list' });

      expect(capturedHeaders!.get('Authorization')).toBe('Bearer test-token');
      expect(capturedHeaders!.get('Content-Type')).toBe('application/json');
    });

    it('throws MCPTransportError on non-ok response', async () => {
      mockFetch(async () => {
        return new Response('Internal Server Error', { status: 500 });
      });

      const transport = new HttpTransport({ serverUrl: 'https://mcp.example.com' });

      await expect(transport.send({ method: 'tools/list' })).rejects.toThrow(MCPTransportError);
    });

    it('throws MCPTransportError on timeout', async () => {
      mockFetch(async (_input: any, init: any) => {
        await new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => {
            reject(new DOMException('The operation was aborted.', 'AbortError'));
          });
        });
        return new Response('ok');
      });

      const transport = new HttpTransport({
        serverUrl: 'https://mcp.example.com',
        timeout: 50,
      });

      await expect(transport.send({ method: 'tools/list' })).rejects.toThrow(MCPTransportError);
    });

    it('re-throws non-timeout errors from fetch', async () => {
      mockFetch(async () => {
        throw new TypeError('Network error');
      });

      const transport = new HttpTransport({ serverUrl: 'https://mcp.example.com' });

      await expect(transport.send({ method: 'tools/list' })).rejects.toThrow(TypeError);
    });

    it('respects external abort signal', async () => {
      const controller = new AbortController();

      mockFetch(async (_input: any, init: any) => {
        await new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => {
            reject(new DOMException('The operation was aborted.', 'AbortError'));
          });
        });
        return new Response('ok');
      });

      const transport = new HttpTransport({
        serverUrl: 'https://mcp.example.com',
        timeout: 30_000,
      });

      const promise = transport.send({ method: 'tools/list' }, controller.signal);
      controller.abort();

      // Should re-throw the DOMException (not wrap as transport error)
      await expect(promise).rejects.toThrow(DOMException);
    });
  });

  describe('healthCheck', () => {
    it('returns true when server responds ok', async () => {
      mockFetch(async () => {
        return new Response('OK', { status: 200 });
      });

      const transport = new HttpTransport({ serverUrl: 'https://mcp.example.com' });
      expect(await transport.healthCheck()).toBe(true);
    });

    it('returns false when server returns non-ok status', async () => {
      mockFetch(async () => {
        return new Response('Service Unavailable', { status: 503 });
      });

      const transport = new HttpTransport({ serverUrl: 'https://mcp.example.com' });
      expect(await transport.healthCheck()).toBe(false);
    });

    it('returns false when fetch throws', async () => {
      mockFetch(async () => {
        throw new Error('Network failure');
      });

      const transport = new HttpTransport({ serverUrl: 'https://mcp.example.com' });
      expect(await transport.healthCheck()).toBe(false);
    });
  });

  describe('dispose', () => {
    it('implements Symbol.dispose without error', () => {
      const transport = new HttpTransport({ serverUrl: 'https://mcp.example.com' });
      expect(() => transport[Symbol.dispose]()).not.toThrow();
    });
  });
});
