import { afterEach, describe, expect, it } from 'bun:test';

import { ApiClient } from './api-client.ts';

function requestInputToUrl(input: RequestInfo | URL): string {
  if (typeof input === 'string') {
    return input;
  }

  if (input instanceof URL) {
    return input.href;
  }

  return input.url;
}

describe('ApiClient', () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('serializes dashboard workflow tag filters as repeated tag query parameters', async () => {
    let requestedUrl = '';

    globalThis.fetch = (async (input: RequestInfo | URL) => {
      requestedUrl = requestInputToUrl(input);
      return new Response(
        JSON.stringify({
          items: [],
          total: 0,
          offset: 0,
          limit: 20,
        }),
        {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        },
      );
    }) as typeof fetch;

    const client = new ApiClient();
    await client.listWorkflows({ tags: ['nightly', 'v2'] });

    expect(requestedUrl).toContain('/v1/workflows?');
    expect(requestedUrl).toContain('tag=nightly');
    expect(requestedUrl).toContain('tag=v2');
  });
});
