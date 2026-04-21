import { afterEach, describe, expect, it, mock } from 'bun:test';

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

  it('serializes schedule filters and returns parsed schedule summaries', async () => {
    let requestedUrl = '';

    globalThis.fetch = (async (input: RequestInfo | URL) => {
      requestedUrl = requestInputToUrl(input);
      return new Response(
        JSON.stringify({
          items: [
            {
              id: 'nightly-maintenance',
              workflowType: 'echo',
              cronExpression: '0 * * * *',
              status: 'active',
              overlap: 'queue',
              backfill: true,
              createdAt: 1,
              updatedAt: 2,
              lastFireAt: 3,
              nextFireAt: 4,
              queuedRuns: 0,
            },
          ],
          total: 1,
          offset: 0,
          limit: 10,
        }),
        {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        },
      );
    }) as typeof fetch;

    const client = new ApiClient();
    const schedules = await client.listSchedules({
      status: ['active', 'paused'],
      workflowType: 'echo',
      tenantId: 'acme',
      limit: 10,
      offset: 20,
    });

    expect(requestedUrl).toContain('/v1/schedules?');
    expect(requestedUrl).toContain('status=active');
    expect(requestedUrl).toContain('status=paused');
    expect(requestedUrl).toContain('workflowType=echo');
    expect(requestedUrl).toContain('tenantId=acme');
    expect(requestedUrl).toContain('limit=10');
    expect(requestedUrl).toContain('offset=20');
    expect(schedules.items).toEqual([
      expect.objectContaining({
        id: 'nightly-maintenance',
        lastFireAt: 3,
        nextFireAt: 4,
      }),
    ]);
  });
});
