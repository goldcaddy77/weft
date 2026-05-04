import { describe, expect, it } from 'bun:test';

import { Engine } from '../core/engine.ts';
import { handleRequest } from '../server/handler.ts';
import { principalFromApiKey } from '../server/principal.ts';
import { HTTPStorage } from './http.ts';
import { MemoryStorage } from './memory.ts';

function encode(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

function decode(value: Uint8Array | null): string | null {
  return value === null ? null : new TextDecoder().decode(value);
}

async function collect<T>(iterable: AsyncIterable<T>): Promise<T[]> {
  const results: T[] = [];
  for await (const value of iterable) results.push(value);
  return results;
}

function base64(value: string): string {
  return btoa(value);
}

type FetchHandler = (...args: Parameters<typeof fetch>) => ReturnType<typeof fetch>;

function installFetch(handler: FetchHandler): () => void {
  const previousFetch = globalThis.fetch;
  globalThis.fetch = Object.assign(handler, { preconnect: previousFetch.preconnect });
  return () => {
    globalThis.fetch = previousFetch;
  };
}

function fetchInputUrl(input: Parameters<typeof fetch>[0]): string {
  if (input instanceof Request) return input.url;
  if (input instanceof URL) return input.href;
  return input;
}

function adminStorageOptions() {
  return {
    authContext: {
      method: 'api-key' as const,
      principal: principalFromApiKey({
        subject: 'http-storage-test',
        scopes: ['storage:read', 'storage:write', 'storage:admin'],
      }),
    },
  };
}

function tenantStorageOptions() {
  return {
    authContext: {
      method: 'api-key' as const,
      principal: principalFromApiKey({
        subject: 'http-storage-tenant-test',
        tenantId: 'acme',
        scopes: ['storage:read', 'storage:write'],
      }),
    },
  };
}

describe('HTTPStorage', () => {
  it('reads bytes and maps 404 to null', async () => {
    const restoreFetch = installFetch(async (input) => {
      const url = new URL(fetchInputUrl(input));
      if (url.pathname.endsWith('/missing')) return new Response(null, { status: 404 });
      return new Response(encode('value'), { status: 200 });
    });
    try {
      const storage = new HTTPStorage({ baseUrl: 'https://example.test/api/' });

      expect(decode(await storage.get('key'))).toBe('value');
      expect(await storage.get('missing')).toBeNull();
    } finally {
      restoreFetch();
    }
  });

  it('encodes batch operations as JSON with base64 values', async () => {
    const requests: Request[] = [];
    const restoreFetch = installFetch(async (input, init) => {
      const request = new Request(input, init);
      requests.push(request);
      return new Response(null, { status: 204 });
    });
    try {
      const storage = new HTTPStorage({
        baseUrl: 'https://example.test/weft/',
        headers: { authorization: 'Bearer token' },
      });
      await storage.batch([
        { type: 'put', key: 'a', value: encode('one') },
        { type: 'delete', key: 'b' },
      ]);

      expect(requests[0]?.url).toBe('https://example.test/weft/v1/storage/batch');
      expect(requests[0]?.headers.get('authorization')).toBe('Bearer token');
      expect(await requests[0]?.json()).toEqual({
        operations: [
          { type: 'put', key: 'a', value: base64('one') },
          { type: 'delete', key: 'b' },
        ],
      });
    } finally {
      restoreFetch();
    }
  });

  it('streams scan results from NDJSON', async () => {
    const restoreFetch = installFetch(
      async () =>
        new Response(
          `${JSON.stringify({ key: 'wf:a', value: base64('a') })}\n${JSON.stringify({
            key: 'wf:b',
            value: base64('b'),
          })}\n`,
          { status: 200, headers: { 'content-type': 'application/x-ndjson' } },
        ),
    );
    try {
      const storage = new HTTPStorage({ baseUrl: 'https://example.test' });
      const entries = await collect(storage.scan('wf:'));

      expect(entries.map(([key, value]) => [key, decode(value)])).toEqual([
        ['wf:a', 'a'],
        ['wf:b', 'b'],
      ]);
    } finally {
      restoreFetch();
    }
  });

  it('streams scan results incrementally from response chunks', async () => {
    let releaseSecondChunk!: () => void;
    const secondChunkGate = new Promise<void>((resolve) => {
      releaseSecondChunk = resolve;
    });
    const restoreFetch = installFetch(
      async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(
                encode(`${JSON.stringify({ key: 'wf:a', value: base64('a') })}\n`),
              );
            },
            async pull(controller) {
              await secondChunkGate;
              controller.enqueue(
                encode(`${JSON.stringify({ key: 'wf:b', value: base64('b') })}\n`),
              );
              controller.close();
            },
          }),
          { status: 200, headers: { 'content-type': 'application/x-ndjson' } },
        ),
    );
    try {
      const storage = new HTTPStorage({ baseUrl: 'https://example.test' });
      const iterator = storage.scan('wf:')[Symbol.asyncIterator]();

      const first = await iterator.next();
      expect(first.done).toBe(false);
      expect(first.value?.[0]).toBe('wf:a');

      releaseSecondChunk();
      const second = await iterator.next();
      expect(second.done).toBe(false);
      expect(second.value?.[0]).toBe('wf:b');
    } finally {
      restoreFetch();
    }
  });

  it('returns the conditional batch result', async () => {
    const restoreFetch = installFetch(async () =>
      Response.json({
        applied: false,
      }),
    );
    try {
      const storage = new HTTPStorage({ baseUrl: 'https://example.test' });

      expect(
        await storage.conditionalBatch?.(
          [{ key: 'a', expectedValue: encode('old') }],
          [{ type: 'put', key: 'a', value: encode('new') }],
        ),
      ).toBe(false);
    } finally {
      restoreFetch();
    }
  });

  it('talks to the real storage REST handlers end to end', async () => {
    const rawStorage = new MemoryStorage();
    const engine = new Engine({ storage: rawStorage });
    const restoreFetch = installFetch((input, init) =>
      handleRequest(new Request(input, init), engine, adminStorageOptions()),
    );
    try {
      const storage = new HTTPStorage({ baseUrl: 'http://localhost' });

      await storage.put('wf:a', encode('a'));
      await storage.batch([
        { type: 'put', key: 'wf:b', value: encode('b') },
        { type: 'delete', key: 'missing' },
      ]);

      expect(decode(await storage.get('wf:a'))).toBe('a');
      const scannedEntries = await collect(storage.scan('wf:'));
      expect(scannedEntries.map(([key, value]) => [key, decode(value)])).toEqual([
        ['wf:a', 'a'],
        ['wf:b', 'b'],
      ]);
      expect(
        await storage.conditionalBatch?.(
          [{ key: 'wf:b', expectedValue: encode('b') }],
          [
            { type: 'put', key: 'wf:c', value: encode('c') },
            { type: 'delete', key: 'wf:a' },
          ],
        ),
      ).toBe(true);
      expect(await storage.get('wf:a')).toBeNull();
      expect(decode(await storage.get('wf:c'))).toBe('c');
    } finally {
      restoreFetch();
    }
  });

  it('talks to tenant-scoped REST handlers end to end', async () => {
    const rawStorage = new MemoryStorage();
    await rawStorage.put('wf:raw', encode('raw'));
    await rawStorage.put('tenant:acme:wf:visible', encode('visible'));
    await rawStorage.put('tenant:other:wf:hidden', encode('hidden'));
    const engine = new Engine({ storage: rawStorage });
    const restoreFetch = installFetch((input, init) =>
      handleRequest(new Request(input, init), engine, tenantStorageOptions()),
    );
    try {
      const storage = new HTTPStorage({ baseUrl: 'http://localhost' });

      await storage.put('wf:new', encode('new'));

      expect(await storage.get('wf:raw')).toBeNull();
      expect(decode(await storage.get('wf:visible'))).toBe('visible');
      expect(decode(await rawStorage.get('tenant:acme:wf:new'))).toBe('new');
      expect(decode(await rawStorage.get('wf:raw'))).toBe('raw');
      const scannedEntries = await collect(storage.scan('wf:'));
      expect(scannedEntries.map(([key, value]) => [key, decode(value)])).toEqual([
        ['wf:new', 'new'],
        ['wf:visible', 'visible'],
      ]);
    } finally {
      restoreFetch();
    }
  });

  it('surfaces 403 for unscoped non-admin REST storage access', async () => {
    const engine = new Engine({ storage: new MemoryStorage() });
    const restoreFetch = installFetch((input, init) =>
      handleRequest(new Request(input, init), engine, {
        authContext: {
          method: 'api-key' as const,
          principal: principalFromApiKey({
            subject: 'http-storage-unscoped-test',
            scopes: ['storage:read'],
          }),
        },
      }),
    );
    try {
      const storage = new HTTPStorage({ baseUrl: 'http://localhost' });

      await expect(storage.get('wf:key')).rejects.toThrow('returned 403');
    } finally {
      restoreFetch();
    }
  });
});
