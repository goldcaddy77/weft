import { afterEach, describe, expect, it } from 'bun:test';

import { MCPClient, MCPServerUnavailableError, MCPToolTimeoutError } from './client';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// Bun's `typeof fetch` includes a static `preconnect` property that is
// absent from plain function values. Casting through `any` avoids TS errors
// when monkey-patching `globalThis.fetch` in test assertions.
function setFetch(fn: (...args: any[]) => Promise<Response>): void {
  globalThis.fetch = fn as typeof fetch;
}

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('MCPClient', () => {
  it('stores constructor options', () => {
    const client = new MCPClient({
      serverUrl: 'https://mcp.example.com',
      auth: { type: 'bearer', token: 'test-token' },
      timeout: 5000,
    });

    // The client should be constructable without errors
    expect(client).toBeInstanceOf(MCPClient);
  });

  it('returns false from healthCheck when the URL is invalid', async () => {
    const client = new MCPClient({
      serverUrl: 'http://localhost:1',
      timeout: 1000,
    });

    const healthy = await client.healthCheck();
    expect(healthy).toBe(false);
  });

  describe('discoverTools', () => {
    it('fetches tools from the MCP server', async () => {
      const mockTools = [
        { name: 'search', description: 'Search the web', inputSchema: {}, parameters: {} },
        { name: 'calculate', description: 'Do math', inputSchema: {}, parameters: {} },
      ];

      setFetch(async (input: any) => {
        const url = typeof input === 'string' ? input : input.url;
        expect(url).toBe('https://mcp.example.com/tools');
        return new Response(JSON.stringify({ tools: mockTools }), { status: 200 });
      });

      const client = new MCPClient({ serverUrl: 'https://mcp.example.com' });
      const tools = await client.discoverTools();

      expect(tools).toEqual(mockTools);
    });

    it('throws MCPServerUnavailableError when server returns non-ok', async () => {
      setFetch(async () => {
        return new Response('Internal Server Error', { status: 500 });
      });

      const client = new MCPClient({ serverUrl: 'https://mcp.example.com' });

      await expect(client.discoverTools()).rejects.toThrow(MCPServerUnavailableError);
    });

    it('includes auth headers when auth is configured', async () => {
      let capturedHeaders: Headers | undefined;

      setFetch(async (_input: any, init: any) => {
        capturedHeaders = new Headers(init?.headers);
        return new Response(JSON.stringify({ tools: [] }), { status: 200 });
      });

      const client = new MCPClient({
        serverUrl: 'https://mcp.example.com',
        auth: { type: 'bearer', token: 'my-secret-token' },
      });

      await client.discoverTools();

      expect(capturedHeaders!.get('Authorization')).toBe('Bearer my-secret-token');
    });
  });

  describe('invokeTool', () => {
    it('invokes a tool and returns its result', async () => {
      setFetch(async (_input: any, init: any) => {
        const body = JSON.parse(init?.body);
        expect(body.name).toBe('search');
        expect(body.input).toEqual({ query: 'hello' });
        return new Response(JSON.stringify({ result: { matches: 5 } }), { status: 200 });
      });

      const client = new MCPClient({ serverUrl: 'https://mcp.example.com' });
      const result = await client.invokeTool('search', { query: 'hello' });

      expect(result).toEqual({ matches: 5 });
    });

    it('throws MCPServerUnavailableError when server returns non-ok', async () => {
      setFetch(async () => {
        return new Response('Server Error', { status: 500 });
      });

      const client = new MCPClient({ serverUrl: 'https://mcp.example.com' });

      await expect(client.invokeTool('search', {})).rejects.toThrow(MCPServerUnavailableError);
    });

    it('throws MCPToolTimeoutError when the request times out', async () => {
      setFetch(async (_input: any, init: any) => {
        // Wait for the abort signal to fire
        await new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => {
            reject(new DOMException('The operation was aborted.', 'AbortError'));
          });
        });
        return new Response('ok');
      });

      const client = new MCPClient({
        serverUrl: 'https://mcp.example.com',
        timeout: 50,
      });

      await expect(client.invokeTool('slow-tool', {})).rejects.toThrow(MCPToolTimeoutError);
    });

    it('re-throws non-timeout errors from fetch', async () => {
      setFetch(async () => {
        throw new TypeError('Network error');
      });

      const client = new MCPClient({ serverUrl: 'https://mcp.example.com' });

      await expect(client.invokeTool('search', {})).rejects.toThrow(TypeError);
    });

    it('respects external abort signal', async () => {
      const controller = new AbortController();

      setFetch(async (_input: any, init: any) => {
        await new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => {
            reject(new DOMException('The operation was aborted.', 'AbortError'));
          });
        });
        return new Response('ok');
      });

      const client = new MCPClient({
        serverUrl: 'https://mcp.example.com',
        timeout: 30_000,
      });

      const promise = client.invokeTool('search', {}, controller.signal);
      controller.abort();

      // Should re-throw the DOMException (not wrap as timeout)
      await expect(promise).rejects.toThrow();
    });

    it('uses default timeout when none is specified', async () => {
      let receivedSignal: AbortSignal | undefined;

      setFetch(async (_input: any, init: any) => {
        receivedSignal = init?.signal;
        return new Response(JSON.stringify({ result: 'ok' }), { status: 200 });
      });

      const client = new MCPClient({ serverUrl: 'https://mcp.example.com' });
      await client.invokeTool('search', {});

      expect(receivedSignal).toBeDefined();
      // The signal should not be aborted since 30s default hasn't passed
      expect(receivedSignal!.aborted).toBe(false);
    });
  });

  describe('healthCheck', () => {
    it('returns true when server responds with ok', async () => {
      setFetch(async () => {
        return new Response('OK', { status: 200 });
      });

      const client = new MCPClient({ serverUrl: 'https://mcp.example.com' });
      const healthy = await client.healthCheck();

      expect(healthy).toBe(true);
    });

    it('returns false when server returns non-ok status', async () => {
      setFetch(async () => {
        return new Response('Service Unavailable', { status: 503 });
      });

      const client = new MCPClient({ serverUrl: 'https://mcp.example.com' });
      const healthy = await client.healthCheck();

      expect(healthy).toBe(false);
    });

    it('returns false when fetch throws', async () => {
      setFetch(async () => {
        throw new Error('Network failure');
      });

      const client = new MCPClient({ serverUrl: 'https://mcp.example.com' });
      const healthy = await client.healthCheck();

      expect(healthy).toBe(false);
    });
  });
});

describe('MCPServerUnavailableError', () => {
  it('stores serverUrl', () => {
    const error = new MCPServerUnavailableError('https://mcp.example.com');

    expect(error).toBeInstanceOf(Error);
    expect(error.serverUrl).toBe('https://mcp.example.com');
    expect(error.message).toContain('https://mcp.example.com');
  });

  it('stores the underlying cause', () => {
    const cause = new Error('connection refused');
    const error = new MCPServerUnavailableError('https://mcp.example.com', cause);

    expect(error.cause).toBe(cause);
  });
});

describe('MCPToolTimeoutError', () => {
  it('stores toolName and timeout', () => {
    const error = new MCPToolTimeoutError('slow-tool', 30000);

    expect(error).toBeInstanceOf(Error);
    expect(error.toolName).toBe('slow-tool');
    expect(error.timeout).toBe(30000);
    expect(error.message).toContain('slow-tool');
    expect(error.message).toContain('30000');
  });
});
