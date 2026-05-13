import { afterEach, describe, expect, it, mock } from 'bun:test';

import { ApiClient, type ReviewDecision } from './api-client.ts';

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

  it('reads workflow list filters and serializes scalar query parameters', async () => {
    let requestedUrl = '';

    globalThis.fetch = (async (input: RequestInfo | URL) => {
      requestedUrl = requestInputToUrl(input);
      return Response.json({ items: [], total: 0, offset: 2, limit: 10 });
    }) as typeof fetch;

    const client = new ApiClient();
    await client.listWorkflows({
      status: 'running',
      type: 'echo',
      tags: ['nightly', 'v2'],
      limit: 10,
      offset: 2,
    });

    expect(requestedUrl).toContain('/v1/workflows?');
    expect(requestedUrl).toContain('status=running');
    expect(requestedUrl).toContain('type=echo');
    expect(requestedUrl).toContain('tag=nightly');
    expect(requestedUrl).toContain('tag=v2');
    expect(requestedUrl).toContain('limit=10');
    expect(requestedUrl).toContain('offset=2');
  });

  it('requests the plain workflow list path when no filters are provided', async () => {
    let requestedUrl = '';

    globalThis.fetch = (async (input: RequestInfo | URL) => {
      requestedUrl = requestInputToUrl(input);
      return Response.json({ items: [], total: 0, offset: 0, limit: 20 });
    }) as typeof fetch;

    const client = new ApiClient();
    await client.listWorkflows();

    expect(requestedUrl).toBe('/v1/workflows');
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

  it('covers the remaining client endpoints and request shaping', async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    const decision: ReviewDecision = {
      decision: 'approved',
      reviewer: 'Ada',
      feedback: 'Looks good',
    };

    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = requestInputToUrl(input);
      requests.push(init === undefined ? { url } : { url, init });

      if (url === '/v1/workflows/workflow%20id' && init?.method === 'DELETE') {
        return new Response(null, { status: 204 });
      }

      if (url === '/v1/workflows/workflow%20id') {
        return Response.json({
          id: 'workflow id',
          type: 'echo',
          status: 'running',
          input: { ok: true },
          version: '1.0.0',
          createdAt: 1,
          updatedAt: 2,
        });
      }

      if (url === '/v1/workflows/workflow%20id/signal/approve%2Fdeny') {
        return new Response(null, { status: 204 });
      }

      if (url === '/v1/workflows/workflow%20id/events') {
        return Response.json({
          events: [{ type: 'workflow.started', timestamp: 1, data: { step: 1 } }],
        });
      }

      if (url === '/v1/workflows/workflow%20id/attributes') {
        return Response.json({ tenant: 'acme' });
      }

      if (url === '/v1/reviews') {
        return Response.json({
          items: [
            {
              reviewId: 'review-1',
              workflowId: 'workflow id',
              artifact: { type: 'diff' },
              reviewType: 'approval',
              reviewers: ['Ada'],
              createdAt: 1,
            },
          ],
        });
      }

      if (url === '/v1/tenants/acme%2Fwest/quota') {
        return Response.json({
          workflowCreationRate: { used: 1, limit: 5, windowMilliseconds: 60_000 },
          memory: { used: 1024, limit: 4096 },
          storage: { used: 2048, limit: 8192 },
        });
      }

      if (url === '/v1/reviews/review%2F1/decision') {
        return new Response(null, { status: 204 });
      }

      if (url === '/v1/health') {
        return Response.json({ status: 'ok' });
      }

      throw new Error(`Unexpected URL: ${url}`);
    }) as typeof fetch;

    const client = new ApiClient();
    expect(await client.getWorkflow('workflow id')).toEqual(
      expect.objectContaining({ id: 'workflow id', status: 'running' }),
    );
    await client.cancelWorkflow('workflow id');
    await client.signalWorkflow('workflow id', 'approve/deny', { ok: true });
    expect(await client.getWorkflowEvents('workflow id')).toEqual([
      { type: 'workflow.started', timestamp: 1, data: { step: 1 } },
    ]);
    expect(await client.getWorkflowAttributes('workflow id')).toEqual({ tenant: 'acme' });
    expect(await client.listPendingReviews()).toEqual([
      expect.objectContaining({ reviewId: 'review-1' }),
    ]);
    expect(await client.getTenantQuotaUsage('acme/west')).toEqual(
      expect.objectContaining({
        workflowCreationRate: expect.objectContaining({ used: 1 }),
      }),
    );
    await client.submitReviewDecision('review/1', 'workflow id', decision);
    expect(await client.checkHealth()).toEqual({ status: 'ok' });

    expect(requests.map((entry) => entry.url)).toEqual([
      '/v1/workflows/workflow%20id',
      '/v1/workflows/workflow%20id',
      '/v1/workflows/workflow%20id/signal/approve%2Fdeny',
      '/v1/workflows/workflow%20id/events',
      '/v1/workflows/workflow%20id/attributes',
      '/v1/reviews',
      '/v1/tenants/acme%2Fwest/quota',
      '/v1/reviews/review%2F1/decision',
      '/v1/health',
    ]);

    expect(requests[1]?.init?.method).toBe('DELETE');
    expect(requests[2]?.init?.method).toBe('POST');
    expect(requests[2]?.init?.headers).toBeDefined();
    expect(requests[2]?.init?.body).toBe(JSON.stringify({ payload: { ok: true } }));
    expect(requests[7]?.init?.method).toBe('POST');
    expect(requests[7]?.init?.body).toBe(
      JSON.stringify({ ...decision, workflowId: 'workflow id' }),
    );
  });

  it('fetches workflow timeline and replay data for dashboard time-travel views', async () => {
    const requests: string[] = [];

    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = requestInputToUrl(input);
      requests.push(url);

      if (url === '/v1/workflows/workflow%20id/timeline') {
        return Response.json([
          {
            step: 1,
            operationType: 'activity',
            operationLabel: 'loadOrder',
            inputSummary: '{"orderId":"order-1"}',
            outputSummary: '{"total":42}',
            duration: 8,
            timestamp: 1_000,
            status: 'completed',
          },
        ]);
      }

      if (url === '/v1/workflows/workflow%20id/replay/2') {
        return Response.json({
          checkpoint: {
            step: 2,
            locals: { approved: true },
            searchAttributes: { status: 'approved' },
            version: '1.0.0',
            createdAt: 2_000,
          },
          accumulatedResults: [[1, { total: 42 }]],
          events: [{ type: 'workflow:checkpoint', timestamp: 2_000, data: { step: 2 } }],
        });
      }

      throw new Error(`Unexpected URL: ${url}`);
    }) as typeof fetch;

    const client = new ApiClient();
    const timeline = await client.getWorkflowTimeline('workflow id');
    const replay = await client.replayWorkflowTo('workflow id', 2);

    expect(timeline).toHaveLength(1);
    expect(timeline[0]?.operationLabel).toBe('loadOrder');
    expect(replay?.checkpoint.step).toBe(2);
    expect(replay?.checkpoint.locals).toEqual({ approved: true });
    expect(requests).toEqual([
      '/v1/workflows/workflow%20id/timeline',
      '/v1/workflows/workflow%20id/replay/2',
    ]);
  });

  it('returns null when workflow replay checkpoint data is not retained', async () => {
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = requestInputToUrl(input);

      if (url === '/v1/workflows/workflow%20id/replay/3') {
        return Response.json(
          { error: 'Replay not found at step 3 for workflow workflow id' },
          {
            status: 404,
            statusText: 'Not Found',
          },
        );
      }

      throw new Error(`Unexpected URL: ${url}`);
    }) as typeof fetch;

    const client = new ApiClient();
    await expect(client.replayWorkflowTo('workflow id', 3)).resolves.toBeNull();
  });

  it('fetches task diagnostics with encoded filters for workflow detail evidence', async () => {
    let requestedUrl = '';

    globalThis.fetch = (async (input: RequestInfo | URL) => {
      requestedUrl = requestInputToUrl(input);
      return Response.json({
        items: [
          {
            kind: 'stale-inflight',
            operationId: 'operation-1',
            workflowId: 'workflow id',
            activityName: 'charge',
            queue: 'payments',
            state: 'inflight',
            workerId: 'worker-1',
            retryCount: 2,
            requeueCount: 1,
            heartbeatAgeMs: 5_000,
            evidence: ['worker worker-1 heartbeat is stale'],
          },
        ],
        summary: {
          stuckQueued: 0,
          staleInflight: 1,
          retryStorms: 0,
          allWorkersAtCapacity: 0,
        },
        limit: 25,
      });
    }) as typeof fetch;

    const client = new ApiClient();
    const diagnostics = await client.getTaskDiagnostics({
      workflowId: 'workflow id',
      queue: 'payments',
      limit: 25,
    });

    expect(requestedUrl).toBe(
      '/v1/tasks/diagnostics?workflowId=workflow+id&queue=payments&limit=25',
    );
    expect(diagnostics.items[0]?.operationId).toBe('operation-1');
    expect(diagnostics.items[0]?.queue).toBe('payments');
  });

  it('prefers API error payloads and falls back to status text when parsing fails', async () => {
    let callCount = 0;

    globalThis.fetch = (async () => {
      callCount += 1;
      if (callCount === 1) {
        return new Response(JSON.stringify({ error: 'workflow exploded' }), {
          status: 500,
          statusText: 'Internal Server Error',
          headers: { 'Content-Type': 'application/json' },
        });
      }

      return new Response('not-json', {
        status: 502,
        statusText: 'Bad Gateway',
        headers: { 'Content-Type': 'text/plain' },
      });
    }) as unknown as typeof fetch;

    const client = new ApiClient();

    await expect(client.getWorkflow('bad')).rejects.toMatchObject({
      name: 'ApiError',
      status: 500,
      message: 'workflow exploded',
    });
    await expect(client.getWorkflow('still-bad')).rejects.toMatchObject({
      name: 'ApiError',
      status: 502,
      message: 'Bad Gateway',
    });
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

  it('fetches connected workers from GET /v1/workers with the routing policy', async () => {
    const requestedUrls: string[] = [];

    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = requestInputToUrl(input);
      requestedUrls.push(url);

      if (url === '/v1/workers') {
        return Response.json({
          items: [
            {
              id: 'worker-1',
              queue: 'default',
              activities: ['process'],
              concurrency: 4,
              inFlight: 1,
              availableCapacity: 3,
              connectedAt: 1_000,
              lastHeartbeatAt: 2_000,
              heartbeatAgeMs: 500,
              deploymentName: 'payments',
              buildId: 'build-1',
              runtimeVersion: 'bun-1.2.13',
              gitSha: 'abc',
              startedAt: 900,
              capabilities: { region: 'us-west' },
              health: 'active',
            },
          ],
          deployments: [
            {
              deploymentName: 'payments',
              buildId: 'build-1',
              runtimeVersion: 'bun-1.2.13',
              gitSha: 'abc',
              health: 'active',
              workers: 1,
              activeWorkers: 1,
              drainingWorkers: 0,
              drainedWorkers: 0,
              inFlight: 1,
              oldestStartedAt: 900,
            },
          ],
          routingPolicy: 'least-loaded',
        });
      }

      throw new Error(`Unexpected URL: ${url}`);
    }) as typeof fetch;

    const client = new ApiClient();
    const response = await client.listWorkers();

    expect(requestedUrls).toEqual(['/v1/workers']);
    expect(response.routingPolicy).toBe('least-loaded');
    expect(response.deployments[0]?.deploymentName).toBe('payments');
    expect(response.items).toEqual([
      expect.objectContaining({
        id: 'worker-1',
        availableCapacity: 3,
        heartbeatAgeMs: 500,
        deploymentName: 'payments',
        health: 'active',
      }),
    ]);
  });

  it('calls worker and deployment drain mutation endpoints', async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = [];

    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = requestInputToUrl(input);
      requests.push(init === undefined ? { url } : { url, init });
      return Response.json({
        target: url.includes('worker-deployments') ? 'deployment' : 'worker',
        affectedWorkers: 1,
        inFlight: 0,
        health: 'drained',
      });
    }) as typeof fetch;

    const client = new ApiClient();
    await client.drainWorker('worker/1', 'maintenance');
    await client.clearWorkerDrain('worker/1');
    await client.drainDeployment('payments/canary', 'rollback');
    await client.clearDeploymentDrain('payments/canary');

    expect(requests.map((entry) => entry.url)).toEqual([
      '/v1/workers/worker%2F1/drain',
      '/v1/workers/worker%2F1/drain',
      '/v1/worker-deployments/payments%2Fcanary/drain',
      '/v1/worker-deployments/payments%2Fcanary/drain',
    ]);
    expect(requests[0]?.init?.method).toBe('POST');
    expect(requests[0]?.init?.body).toBe(JSON.stringify({ reason: 'maintenance' }));
    expect(requests[1]?.init?.method).toBe('DELETE');
    expect(requests[2]?.init?.method).toBe('POST');
    expect(requests[2]?.init?.body).toBe(JSON.stringify({ reason: 'rollback' }));
    expect(requests[3]?.init?.method).toBe('DELETE');
  });

  it('fetches per-queue health from GET /v1/task-queues', async () => {
    const requestedUrls: string[] = [];

    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = requestInputToUrl(input);
      requestedUrls.push(url);

      if (url === '/v1/task-queues') {
        return Response.json({
          items: [
            {
              queue: 'queue-a',
              backlog: 2,
              oldestEnqueuedAt: 100,
              oldestQueuedAgeMs: 900,
              waitingPollers: 0,
              schedulingPolicy: 'priority',
              inFlight: 1,
              connectedWorkers: 1,
            },
          ],
        });
      }

      throw new Error(`Unexpected URL: ${url}`);
    }) as typeof fetch;

    const client = new ApiClient();
    const response = await client.listTaskQueues();

    expect(requestedUrls).toEqual(['/v1/task-queues']);
    expect(response.items).toEqual([
      expect.objectContaining({ queue: 'queue-a', backlog: 2, oldestQueuedAgeMs: 900 }),
    ]);
  });
});
