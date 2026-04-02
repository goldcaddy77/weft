import { afterEach, describe, expect, it } from 'bun:test';

import { MCPTransportError } from './transport';
import { HttpSseTransport } from './transport-http-sse';

// ---------------------------------------------------------------------------
// Helpers: mock fetch that simulates an SSE server
// ---------------------------------------------------------------------------

const originalFetch = globalThis.fetch;

function mockFetch(implementation: (...args: any[]) => Promise<Response>): void {
  const mock = Object.assign(implementation, { preconnect: (_url: string) => {} });
  globalThis.fetch = mock as typeof fetch;
}

afterEach(() => {
  globalThis.fetch = originalFetch;
});

/**
 * Create a mock SSE + JSON-RPC server.
 *
 * Returns a controller that lets tests push SSE events for specific request IDs.
 */
function createMockSseServer() {
  let sseController: ReadableStreamDefaultController<Uint8Array> | null = null;
  const encoder = new TextEncoder();

  const sseStream = new ReadableStream<Uint8Array>({
    start(controller) {
      sseController = controller;
    },
  });

  function pushSseEvent(data: unknown): void {
    if (!sseController) throw new Error('SSE stream not started');
    const eventText = `data: ${JSON.stringify(data)}\n\n`;
    sseController.enqueue(encoder.encode(eventText));
  }

  function closeSseStream(): void {
    if (sseController) {
      try {
        sseController.close();
      } catch {
        // Already closed
      }
    }
  }

  mockFetch(async (input: any, init: any) => {
    const url = typeof input === 'string' ? input : input.url;

    if (url.endsWith('/sse')) {
      return new Response(sseStream, {
        status: 200,
        headers: { 'Content-Type': 'text/event-stream' },
      });
    }

    if (url.endsWith('/jsonrpc')) {
      const body = JSON.parse(init?.body);
      // Simulate server processing: push response via SSE after a short delay
      setTimeout(() => {
        pushSseEvent({
          jsonrpc: '2.0',
          id: body.id,
          result: { method: body.method, params: body.params },
        });
      }, 10);
      return new Response('', { status: 202 });
    }

    if (url.endsWith('/health')) {
      return new Response('OK', { status: 200 });
    }

    return new Response('Not Found', { status: 404 });
  });

  return { pushSseEvent, closeSseStream };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('HttpSseTransport', () => {
  const transports: HttpSseTransport[] = [];

  afterEach(() => {
    for (const transport of transports) {
      transport[Symbol.dispose]();
    }
    transports.length = 0;
  });

  function track(transport: HttpSseTransport): HttpSseTransport {
    transports.push(transport);
    return transport;
  }

  it('sends requests via POST and receives responses via SSE', async () => {
    createMockSseServer();
    const transport = track(new HttpSseTransport({ serverUrl: 'https://mcp.example.com' }));

    const response = await transport.send({ method: 'tools/list', params: { q: 'all' } });

    expect(response.result).toEqual({
      method: 'tools/list',
      params: { q: 'all' },
    });
  });

  it('correlates concurrent requests by id', async () => {
    createMockSseServer();
    const transport = track(new HttpSseTransport({ serverUrl: 'https://mcp.example.com' }));

    const [r1, r2, r3] = await Promise.all([
      transport.send({ method: 'first' }),
      transport.send({ method: 'second' }),
      transport.send({ method: 'third' }),
    ]);

    expect((r1.result as any).method).toBe('first');
    expect((r2.result as any).method).toBe('second');
    expect((r3.result as any).method).toBe('third');
  });

  it('includes custom headers in requests', async () => {
    let capturedSseHeaders: Headers | undefined;
    let capturedPostHeaders: Headers | undefined;
    let postArrived!: () => void;
    const postReady = new Promise<void>((resolve) => {
      postArrived = resolve;
    });

    mockFetch(async (input: any, init: any) => {
      const url = typeof input === 'string' ? input : input.url;
      const headers = new Headers(init?.headers);

      if (url.endsWith('/sse')) {
        capturedSseHeaders = headers;
        return new Response(new ReadableStream({ start() {} }), {
          status: 200,
          headers: { 'Content-Type': 'text/event-stream' },
        });
      }

      if (url.endsWith('/jsonrpc')) {
        capturedPostHeaders = headers;
        postArrived();
        return new Response('', { status: 202 });
      }

      return new Response('OK', { status: 200 });
    });

    const transport = track(
      new HttpSseTransport({
        serverUrl: 'https://mcp.example.com',
        headers: { Authorization: 'Bearer test-token' },
        timeout: 5000,
      }),
    );

    // Fire send but don't await — it will wait for SSE response that never comes
    transport.send({ method: 'test' }).catch(() => {});
    // Wait for POST to arrive (event-driven, no sleep)
    await postReady;

    expect(capturedSseHeaders!.get('Authorization')).toBe('Bearer test-token');
    expect(capturedPostHeaders!.get('Authorization')).toBe('Bearer test-token');
  });

  it('throws MCPTransportError when POST returns non-ok', async () => {
    mockFetch(async (input: any) => {
      const url = typeof input === 'string' ? input : input.url;

      if (url.endsWith('/sse')) {
        return new Response(new ReadableStream({ start() {} }), {
          status: 200,
          headers: { 'Content-Type': 'text/event-stream' },
        });
      }

      return new Response('Server Error', { status: 500 });
    });

    const transport = track(new HttpSseTransport({ serverUrl: 'https://mcp.example.com' }));

    await expect(transport.send({ method: 'test' })).rejects.toThrow(MCPTransportError);
  });

  it('throws MCPTransportError when SSE connection fails', async () => {
    mockFetch(async () => {
      return new Response('Service Unavailable', { status: 503 });
    });

    const transport = track(new HttpSseTransport({ serverUrl: 'https://mcp.example.com' }));

    await expect(transport.send({ method: 'test' })).rejects.toThrow(MCPTransportError);
  });

  it('times out when server does not respond via SSE', async () => {
    mockFetch(async (input: any) => {
      const url = typeof input === 'string' ? input : input.url;

      if (url.endsWith('/sse')) {
        return new Response(new ReadableStream({ start() {} }), {
          status: 200,
          headers: { 'Content-Type': 'text/event-stream' },
        });
      }

      // Accept the POST but never push an SSE response
      return new Response('', { status: 202 });
    });

    const transport = track(
      new HttpSseTransport({ serverUrl: 'https://mcp.example.com', timeout: 100 }),
    );

    await expect(transport.send({ method: 'test' })).rejects.toThrow(MCPTransportError);
  });

  it('respects external abort signal', async () => {
    let sseEstablished = false;
    let postArrived!: () => void;
    const postReady = new Promise<void>((resolve) => {
      postArrived = resolve;
    });

    mockFetch(async (input: any) => {
      const url = typeof input === 'string' ? input : input.url;

      if (url.endsWith('/sse')) {
        sseEstablished = true;
        return new Response(new ReadableStream({ start() {} }), {
          status: 200,
          headers: { 'Content-Type': 'text/event-stream' },
        });
      }

      if (url.endsWith('/jsonrpc')) {
        postArrived();
        return new Response('', { status: 202 });
      }

      return new Response('OK', { status: 200 });
    });

    const transport = track(
      new HttpSseTransport({ serverUrl: 'https://mcp.example.com', timeout: 5000 }),
    );

    const controller = new AbortController();
    const promise = transport.send({ method: 'test' }, controller.signal);

    // Wait for POST to arrive (event-driven), then abort
    await postReady;
    controller.abort();

    await expect(promise).rejects.toThrow(DOMException);
    expect(sseEstablished).toBe(true);
  });

  it('throws when transport is disposed', async () => {
    const transport = new HttpSseTransport({
      serverUrl: 'https://mcp.example.com',
    });
    transport[Symbol.dispose]();

    await expect(transport.send({ method: 'test' })).rejects.toThrow(MCPTransportError);
  });

  describe('healthCheck', () => {
    it('returns true when server responds ok', async () => {
      createMockSseServer();
      const transport = track(new HttpSseTransport({ serverUrl: 'https://mcp.example.com' }));

      expect(await transport.healthCheck()).toBe(true);
    });

    it('returns false when health check fails', async () => {
      mockFetch(async () => {
        return new Response('Service Unavailable', { status: 503 });
      });

      const transport = track(new HttpSseTransport({ serverUrl: 'https://mcp.example.com' }));

      expect(await transport.healthCheck()).toBe(false);
    });
  });

  describe('SSE event handling', () => {
    it('handles error responses from server', async () => {
      let sseController: ReadableStreamDefaultController<Uint8Array> | null = null;
      const encoder = new TextEncoder();
      let requestId = 0;

      mockFetch(async (input: any, init: any) => {
        const url = typeof input === 'string' ? input : input.url;

        if (url.endsWith('/sse')) {
          return new Response(
            new ReadableStream<Uint8Array>({
              start(controller) {
                sseController = controller;
              },
            }),
            { status: 200, headers: { 'Content-Type': 'text/event-stream' } },
          );
        }

        if (url.endsWith('/jsonrpc')) {
          const body = JSON.parse(init?.body ?? '{}');
          requestId = body.id;
          // Push error response via SSE
          setTimeout(() => {
            if (sseController) {
              const event = `data: ${JSON.stringify({
                jsonrpc: '2.0',
                id: requestId,
                error: { code: -32600, message: 'Invalid Request' },
              })}\n\n`;
              sseController.enqueue(encoder.encode(event));
            }
          }, 10);
          return new Response('', { status: 202 });
        }

        return new Response('OK', { status: 200 });
      });

      const transport = track(new HttpSseTransport({ serverUrl: 'https://mcp.example.com' }));

      const response = await transport.send({ method: 'bad-request' });
      expect(response.error).toEqual({ code: -32600, message: 'Invalid Request' });
    });
  });
});
