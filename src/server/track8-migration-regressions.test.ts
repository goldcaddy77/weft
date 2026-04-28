/**
 * Track 8 Wave 1 — boundary regression tests.
 *
 * Captures the REST contract (status codes, headers, body shape) for
 * each of the 5 routes migrated in Wave 1. These tests must pass against
 * BOTH the old dispatch path AND the new catalog path — the migration
 * commit is safe to revert if they stay green.
 *
 * Traceability: 8-top-7, 8d-2
 */

import { afterEach, describe, expect, it } from 'bun:test';

import type { Context } from '../core/context.ts';
import { Engine } from '../core/engine.ts';
import { tenantFromInputField } from '../core/tenant.ts';
import type { WorkflowContext } from '../core/types.ts';
import { MetricsCollector } from '../observability/metrics.ts';
import { MemoryStorage } from '../storage/memory.ts';
import { signJWT } from './authentication.ts';
import { serve, type WeftServer } from './index.ts';
import { createLiveOperationRegistry } from './rest-bindings.ts';

const TEST_SECRET = 'track-8-wave-1-test-secret-1234567890';

function createScheduleEngine(): Engine {
  const engine = new Engine({ storage: new MemoryStorage() });
  engine.register('echo', async function* (_ctx: WorkflowContext, input: unknown) {
    return input;
  });
  return engine;
}

function createTenantAwareEngine(): Engine {
  const engine = new Engine({
    storage: new MemoryStorage(),
    tenantResolver: tenantFromInputField('tenantId'),
    quotas: {
      maxConcurrentWorkflows: 2,
      maxWorkflowCreationRate: { count: 5, window: '1m' },
    },
  });
  engine.register('echo', async function* (_ctx: WorkflowContext, input: unknown) {
    return input;
  });
  return engine;
}

function createReplayEngine(): Engine {
  const engine = new Engine({
    storage: new MemoryStorage(),
    checkpointHistory: 10,
  });

  async function firstStep() {
    return { phase: 'first' as const };
  }

  async function secondStep() {
    return { phase: 'second' as const };
  }

  async function thirdStep() {
    return { phase: 'third' as const };
  }

  engine.register('three-steps', {
    version: '1.0.0',
    handler: async function* (ctx: WorkflowContext) {
      yield* (ctx as Context).run(firstStep);
      yield* (ctx as Context).run(secondStep);
      return yield* (ctx as Context).run(thirdStep);
    },
  });

  return engine;
}

async function createReplayWorkflow(
  engine: Engine,
  workflowId = 'wf-track8-replay',
): Promise<string> {
  const handle = await engine.start('three-steps', null, { id: workflowId });
  await handle.result();
  return handle.id;
}

async function issueJwt(scopes: string[], claims: Record<string, unknown> = {}): Promise<string> {
  return signJWT(
    {
      sub: 'track-8-user',
      scope: scopes.join(' '),
      ...claims,
    },
    TEST_SECRET,
  );
}

async function postJsonRpc(
  server: WeftServer,
  body: Record<string, unknown>,
  token?: string,
): Promise<Response> {
  return fetch(`${server.url}/jsonrpc`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(token !== undefined ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: crypto.randomUUID(),
      ...body,
    }),
  });
}

describe('Track 8 Wave 1 migration regressions', () => {
  const servers: WeftServer[] = [];

  afterEach(async () => {
    while (servers.length > 0) {
      await servers.pop()?.stop();
    }
  });

  it('The parity surface covers all data-driven runtime operations', () => {
    // verify the 5 new operations are in the registry
    const registry = createLiveOperationRegistry();
    const expected = [
      'weft.schedules.list',
      'weft.schedules.get',
      'weft.tenants.quota.get',
      'weft.workflows.replay',
      'weft.system.metrics',
    ];
    for (const name of expected) {
      expect(registry.get(name)).toBeDefined();
    }
  });

  it('Track 8 adds transport-neutral authorization for runtime operations', () => {
    // The 3 scoped ops use the catalog's evaluateAccess rather than inline checks
    const registry = createLiveOperationRegistry();
    const quota = registry.get('weft.tenants.quota.get');
    const replay = registry.get('weft.workflows.replay');
    const metrics = registry.get('weft.system.metrics');
    expect(quota?.access.kind).toBe('scoped');
    expect(replay?.access.kind).toBe('scoped');
    expect(metrics?.access.kind).toBe('scoped');
  });

  it('GET /v1/schedules preserves the legacy success shape', async () => {
    const engine = createScheduleEngine();
    await engine.schedule('echo', { payload: 'alpha' }, '0 * * * *', { id: 'schedule-alpha' });
    await engine.schedule('echo', { payload: 'beta' }, '30 * * * *', { id: 'schedule-beta' });

    const server = serve({ engine, port: 0 });
    servers.push(server);

    const response = await fetch(`${server.url}/v1/schedules`);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('application/json');

    const body = (await response.json()) as {
      items?: Array<{ id: string }>;
      total?: number;
      limit?: number;
      offset?: number;
    };
    expect(body.items?.map((schedule) => schedule.id).toSorted()).toEqual([
      'schedule-alpha',
      'schedule-beta',
    ]);
    expect(typeof body.total).toBe('number');
    expect(typeof body.limit).toBe('number');
    expect(typeof body.offset).toBe('number');
  });

  it('GET /v1/schedules/:id preserves the legacy success shape and 404 contract', async () => {
    const engine = createScheduleEngine();
    await engine.schedule('echo', { payload: 'alpha' }, '0 * * * *', { id: 'schedule-alpha' });

    const server = serve({ engine, port: 0 });
    servers.push(server);

    const success = await fetch(`${server.url}/v1/schedules/schedule-alpha`);
    expect(success.status).toBe(200);
    expect(success.headers.get('content-type')).toBe('application/json');
    const successBody = (await success.json()) as {
      id?: string;
      workflowType?: string;
      cronExpression?: string;
    };
    expect(successBody.id).toBe('schedule-alpha');
    expect(successBody.workflowType).toBe('echo');
    expect(successBody.cronExpression).toBe('0 * * * *');

    const missing = await fetch(`${server.url}/v1/schedules/does-not-exist`);
    expect(missing.status).toBe(404);
    expect(missing.headers.get('content-type')).toBe('application/json');
    expect(await missing.json()).toEqual({
      error: 'Schedule "does-not-exist" not found',
    });
  });

  it('GET /v1/tenants/:id/quota preserves success and auth outcomes on REST and JSON-RPC HTTP', async () => {
    const engine = createTenantAwareEngine();
    const quotaToken = await issueJwt(['quota:read'], { tenantId: 'acme' });
    const noScopeToken = await issueJwt(['workflows:read'], { tenantId: 'acme' });

    await engine.start(
      'echo',
      { tenantId: 'acme', payload: 'quota-probe' },
      { id: 'quota-probe-workflow' },
    );

    const anonymousServer = serve({ engine, port: 0 });
    const authenticatedServer = serve({
      engine,
      port: 0,
      auth: { jwt: { secret: TEST_SECRET } },
    });
    servers.push(anonymousServer, authenticatedServer);

    const anonymousRest = await fetch(`${anonymousServer.url}/v1/tenants/acme/quota`);
    expect(anonymousRest.status).toBe(401);
    expect(anonymousRest.headers.get('content-type')).toBe('application/json');

    const noScopeRest = await fetch(`${authenticatedServer.url}/v1/tenants/acme/quota`, {
      headers: { Authorization: `Bearer ${noScopeToken}` },
    });
    expect(noScopeRest.status).toBe(403);
    expect(noScopeRest.headers.get('content-type')).toBe('application/json');

    const successRest = await fetch(`${authenticatedServer.url}/v1/tenants/acme/quota`, {
      headers: { Authorization: `Bearer ${quotaToken}` },
    });
    expect(successRest.status).toBe(200);
    expect(successRest.headers.get('content-type')).toBe('application/json');
    const successRestBody = (await successRest.json()) as {
      tenantId?: string;
      workflowCreationRate?: { used?: number };
    };
    expect(successRestBody.tenantId).toBe('acme');
    expect(typeof successRestBody.workflowCreationRate?.used).toBe('number');

    const anonymousJsonRpc = await postJsonRpc(anonymousServer, {
      method: 'weft.tenants.quota.get',
      params: { tenantId: 'acme' },
    });
    expect(anonymousJsonRpc.status).toBe(200);
    const anonymousJsonRpcBody = (await anonymousJsonRpc.json()) as {
      error?: { data?: { weftCode?: string; httpStatus?: number } };
    };
    expect(anonymousJsonRpcBody.error?.data?.weftCode).toBe('Unauthorized');
    expect(anonymousJsonRpcBody.error?.data?.httpStatus).toBe(401);

    const noScopeJsonRpc = await postJsonRpc(
      authenticatedServer,
      {
        method: 'weft.tenants.quota.get',
        params: { tenantId: 'acme' },
      },
      noScopeToken,
    );
    expect(noScopeJsonRpc.status).toBe(200);
    const noScopeJsonRpcBody = (await noScopeJsonRpc.json()) as {
      error?: { data?: { weftCode?: string; httpStatus?: number } };
    };
    expect(noScopeJsonRpcBody.error?.data?.weftCode).toBe('Forbidden');
    expect(noScopeJsonRpcBody.error?.data?.httpStatus).toBe(403);

    const successJsonRpc = await postJsonRpc(
      authenticatedServer,
      {
        method: 'weft.tenants.quota.get',
        params: { tenantId: 'acme' },
      },
      quotaToken,
    );
    expect(successJsonRpc.status).toBe(200);
    const successJsonRpcBody = (await successJsonRpc.json()) as {
      result?: { tenantId?: string };
      error?: unknown;
    };
    expect(successJsonRpcBody.error).toBeUndefined();
    expect(successJsonRpcBody.result?.tenantId).toBe('acme');
  });

  it('GET /v1/workflows/:id/replay/:step preserves the legacy success, 404, and REST auth contract', async () => {
    const engine = createReplayEngine();
    const replayToken = await issueJwt(['workflows:read']);
    const noScopeToken = await issueJwt(['quota:read']);
    const workflowId = await createReplayWorkflow(engine);

    const anonymousServer = serve({ engine, port: 0 });
    const authenticatedServer = serve({
      engine,
      port: 0,
      auth: { jwt: { secret: TEST_SECRET } },
    });
    servers.push(anonymousServer, authenticatedServer);

    const anonymous = await fetch(`${anonymousServer.url}/v1/workflows/${workflowId}/replay/2`);
    expect(anonymous.status).toBe(401);
    expect(anonymous.headers.get('content-type')).toBe('application/json');

    const forbidden = await fetch(
      `${authenticatedServer.url}/v1/workflows/${workflowId}/replay/2`,
      {
        headers: { Authorization: `Bearer ${noScopeToken}` },
      },
    );
    expect(forbidden.status).toBe(403);
    expect(forbidden.headers.get('content-type')).toBe('application/json');

    const success = await fetch(`${authenticatedServer.url}/v1/workflows/${workflowId}/replay/2`, {
      headers: { Authorization: `Bearer ${replayToken}` },
    });
    expect(success.status).toBe(200);
    expect(success.headers.get('content-type')).toBe('application/json');
    const successBody = (await success.json()) as {
      checkpoint?: { step?: number };
      events?: unknown[];
      accumulatedResults?: unknown[];
    };
    expect(successBody.checkpoint?.step).toBe(2);
    expect(Array.isArray(successBody.events)).toBe(true);
    expect(Array.isArray(successBody.accumulatedResults)).toBe(true);

    const missingWorkflow = await fetch(
      `${authenticatedServer.url}/v1/workflows/does-not-exist/replay/2`,
      {
        headers: { Authorization: `Bearer ${replayToken}` },
      },
    );
    expect(missingWorkflow.status).toBe(404);
    expect(missingWorkflow.headers.get('content-type')).toBe('application/json');

    const missingReplay = await fetch(
      `${authenticatedServer.url}/v1/workflows/${workflowId}/replay/99`,
      {
        headers: { Authorization: `Bearer ${replayToken}` },
      },
    );
    expect(missingReplay.status).toBe(404);
    expect(missingReplay.headers.get('content-type')).toBe('application/json');
  });

  it('GET /v1/metrics/json preserves success and auth outcomes on REST and JSON-RPC HTTP', async () => {
    const engine = createScheduleEngine();
    const metricsCollector = new MetricsCollector();
    metricsCollector.increment('weft_test_counter', 2);

    const metricsToken = await issueJwt(['system:read']);
    const noScopeToken = await issueJwt(['workflows:read']);

    const anonymousServer = serve({ engine, port: 0, metricsCollector });
    const authenticatedServer = serve({
      engine,
      port: 0,
      metricsCollector,
      auth: { jwt: { secret: TEST_SECRET } },
    });
    servers.push(anonymousServer, authenticatedServer);

    const anonymousRest = await fetch(`${anonymousServer.url}/v1/metrics/json`);
    expect(anonymousRest.status).toBe(401);
    expect(anonymousRest.headers.get('content-type')).toBe('application/json');

    const noScopeRest = await fetch(`${authenticatedServer.url}/v1/metrics/json`, {
      headers: { Authorization: `Bearer ${noScopeToken}` },
    });
    expect(noScopeRest.status).toBe(403);
    expect(noScopeRest.headers.get('content-type')).toBe('application/json');

    const successRest = await fetch(`${authenticatedServer.url}/v1/metrics/json`, {
      headers: { Authorization: `Bearer ${metricsToken}` },
    });
    expect(successRest.status).toBe(200);
    expect(successRest.headers.get('content-type')).toBe('application/json');
    const successRestBody = (await successRest.json()) as Record<
      string,
      { type?: string; value?: number }
    >;
    expect(successRestBody['weft_test_counter']).toEqual({
      type: 'counter',
      value: 2,
    });

    const anonymousJsonRpc = await postJsonRpc(anonymousServer, {
      method: 'weft.system.metrics',
      params: {
        snapshot: {
          rpc_counter: { type: 'counter', value: 3 },
        },
      },
    });
    expect(anonymousJsonRpc.status).toBe(200);
    const anonymousJsonRpcBody = (await anonymousJsonRpc.json()) as {
      error?: { data?: { weftCode?: string; httpStatus?: number } };
    };
    expect(anonymousJsonRpcBody.error?.data?.weftCode).toBe('Unauthorized');
    expect(anonymousJsonRpcBody.error?.data?.httpStatus).toBe(401);

    const noScopeJsonRpc = await postJsonRpc(
      authenticatedServer,
      {
        method: 'weft.system.metrics',
        params: {
          snapshot: {
            rpc_counter: { type: 'counter', value: 3 },
          },
        },
      },
      noScopeToken,
    );
    expect(noScopeJsonRpc.status).toBe(200);
    const noScopeJsonRpcBody = (await noScopeJsonRpc.json()) as {
      error?: { data?: { weftCode?: string; httpStatus?: number } };
    };
    expect(noScopeJsonRpcBody.error?.data?.weftCode).toBe('Forbidden');
    expect(noScopeJsonRpcBody.error?.data?.httpStatus).toBe(403);

    const successJsonRpc = await postJsonRpc(
      authenticatedServer,
      {
        method: 'weft.system.metrics',
        params: {
          snapshot: {
            rpc_counter: { type: 'counter', value: 3 },
          },
        },
      },
      metricsToken,
    );
    expect(successJsonRpc.status).toBe(200);
    const successJsonRpcBody = (await successJsonRpc.json()) as {
      result?: Record<string, { type?: string; value?: number }>;
      error?: unknown;
    };
    expect(successJsonRpcBody.error).toBeUndefined();
    expect(successJsonRpcBody.result?.['rpc_counter']).toEqual({
      type: 'counter',
      value: 3,
    });
  });
});
