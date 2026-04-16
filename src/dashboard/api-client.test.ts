import { afterEach, describe, expect, it, mock } from 'bun:test';

import { ApiClient } from './api-client.ts';

describe('dashboard ApiClient retention overview', () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('calls /v1/retention and returns the parsed overview', async () => {
    const fetchMock = mock(async (input: RequestInfo | URL) => {
      const url =
        typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      expect(url).toBe('/v1/retention');

      return new Response(
        JSON.stringify({
          sweepIntervalMs: 300_000,
          sweepBatchSize: 1000,
          nextSweepAt: 123_456,
          defaultRetention: { completed: 300_000 },
          workflowTypes: [
            {
              type: 'echo',
              source: 'engine',
              retention: { completed: 300_000 },
            },
          ],
        }),
        {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        },
      );
    });

    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const client = new ApiClient();
    const overview = await client.getRetentionOverview();

    expect(overview.nextSweepAt).toBe(123_456);
    expect(overview.workflowTypes).toEqual([
      expect.objectContaining({
        type: 'echo',
        source: 'engine',
      }),
    ]);
  });
});
