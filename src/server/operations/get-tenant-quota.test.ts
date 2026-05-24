/**
 * `weft.tenants.quota.get` operation + REST binding — unit tests.
 *
 * Covers:
 * - Happy path with a tenant-aware engine returns quota data.
 * - Whitespace-only tenantId is rejected with InvalidParams (400).
 * - JWT with tenant claim A accessing tenant B is rejected with Forbidden (403).
 * - JWT without tenant claim is rejected with Forbidden (403).
 * - EngineFailure fault shaper returns 500 with "Internal server error".
 *
 * A second `describe` block exercises the live cross-transport contract: the
 * data-driven runtime operations are registered and addressable, and
 * authorization (scope checks and tenant isolation) produces the same outcome
 * over REST, JSON-RPC HTTP, JSON-RPC WebSocket, and JSON-RPC stdio.
 */

import { afterEach, describe, expect, it } from 'bun:test';

import { Engine } from '../../core/engine.ts';
import { tenantFromInputField } from '../../core/tenant.ts';
import type { WorkflowContext } from '../../core/types.ts';
import { workflow } from '../../core/types.ts';
import { MemoryStorage } from '../../storage/memory.ts';
import { signJWT } from '../authentication.ts';
import { handleRequest } from '../handler.ts';
import { serve, type WeftServer } from '../index.ts';
import { createOperationRegistry, executeOperation } from '../operation-catalog.ts';
import type { OperationFault } from '../operation-fault.ts';
import { principalFromApiKey, principalFromJwtClaims } from '../principal.ts';
import { createLiveOperationRegistry } from '../rest-bindings.ts';
import { getTenantQuotaOperation, getTenantQuotaRestBinding } from './get-tenant-quota.ts';

const echoWorkflow = workflow({ name: 'echo' }).execute(async function* (
  _ctx: WorkflowContext,
  input: unknown,
) {
  return input;
});

function createEngine(): Engine {
  return new Engine({ storage: new MemoryStorage() });
}

function createTenantAwareEngine(): Engine {
  const engine = new Engine({
    storage: new MemoryStorage(),
    tenantResolver: tenantFromInputField('tenantId'),
    quotas: {
      maxConcurrentWorkflows: 5,
      maxWorkflowCreationRate: { count: 10, window: '1m' },
    },
  });
  engine.register(echoWorkflow);
  return engine;
}

/** AuthContext for handleRequest that satisfies the quota:read scope requirement. */
function quotaAuthContext() {
  return {
    authContext: {
      method: 'api-key' as const,
      principal: principalFromApiKey({ subject: 'test', scopes: ['quota:read'] }),
    },
  };
}

const registry = createOperationRegistry([getTenantQuotaOperation]);

describe('weft.tenants.quota.get', () => {
  let engine: Engine | undefined;

  afterEach(() => {
    engine?.[Symbol.dispose]();
  });

  it('returns quota usage on the happy path (anonymous engine)', async () => {
    engine = createEngine();

    const response = await handleRequest(
      new Request('http://localhost/v1/tenants/acme/quota', { method: 'GET' }),
      engine,
      {
        operationRegistry: registry,
        restBindings: [getTenantQuotaRestBinding],
        ...quotaAuthContext(),
      },
    );

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('application/json');
    const body = (await response.json()) as { tenantId?: string };
    expect(body.tenantId).toBe('acme');
  });

  it('returns quota data with a tenant-aware engine', async () => {
    engine = createTenantAwareEngine();
    await engine.start('echo', { tenantId: 'acme', x: 1 }, { id: 'wf-quota-unit' });

    const response = await handleRequest(
      new Request('http://localhost/v1/tenants/acme/quota', { method: 'GET' }),
      engine,
      {
        operationRegistry: registry,
        restBindings: [getTenantQuotaRestBinding],
        ...quotaAuthContext(),
      },
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      tenantId?: string;
      workflowCreationRate?: { used?: number };
    };
    expect(body.tenantId).toBe('acme');
    expect(typeof body.workflowCreationRate?.used).toBe('number');
  });

  it('rejects whitespace-only tenantId with 400', async () => {
    engine = createEngine();

    // Zod min(1) rejects tenantId composed entirely of spaces.
    // URL-encode spaces as %20 — the router decodes them.
    const response = await handleRequest(
      new Request('http://localhost/v1/tenants/%20%20/quota', { method: 'GET' }),
      engine,
      {
        operationRegistry: registry,
        restBindings: [getTenantQuotaRestBinding],
        ...quotaAuthContext(),
      },
    );

    // Zod min(1) rejects blank paths; the fault shaper maps InvalidParams → 400.
    expect(response.status).toBe(400);
  });

  it('rejects a JWT whose tenant claim does not match the requested tenantId with Forbidden', async () => {
    engine = createTenantAwareEngine();

    const principal = principalFromJwtClaims({
      sub: 'user-a',
      scope: 'quota:read',
      tenantId: 'tenant-a',
    });
    const liveRegistry = createLiveOperationRegistry();

    const result = await executeOperation(
      'weft.tenants.quota.get',
      { tenantId: 'tenant-b' },
      { principal, engine, transport: 'jsonRpcStdio', registry: liveRegistry },
    );

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected rejection');
    expect(result.fault.code).toBe('Forbidden');
  });

  it('rejects a JWT with no tenant claim when accessing any tenantId with Forbidden', async () => {
    engine = createTenantAwareEngine();

    const principal = principalFromJwtClaims({ sub: 'user-a', scope: 'quota:read' });
    const liveRegistry = createLiveOperationRegistry();

    const result = await executeOperation(
      'weft.tenants.quota.get',
      { tenantId: 'any-tenant' },
      { principal, engine, transport: 'jsonRpcStdio', registry: liveRegistry },
    );

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected rejection');
    expect(result.fault.code).toBe('Forbidden');
  });

  it('allows a JWT whose tenant claim matches the requested tenantId', async () => {
    engine = createTenantAwareEngine();

    const principal = principalFromJwtClaims({
      sub: 'user-a',
      scope: 'quota:read',
      tenantId: 'acme',
    });
    const liveRegistry = createLiveOperationRegistry();

    const result = await executeOperation(
      'weft.tenants.quota.get',
      { tenantId: 'acme' },
      { principal, engine, transport: 'jsonRpcStdio', registry: liveRegistry },
    );

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected success');
    const quota = result.value as { tenantId?: string };
    expect(quota.tenantId).toBe('acme');
  });

  it('maps EngineFailure faults to 500 with "Internal server error"', async () => {
    engine = createEngine();

    const failingOperation = {
      ...getTenantQuotaOperation,
      invoke: async () => {
        const fault: OperationFault = {
          code: 'EngineFailure',
          message: 'secret internal detail',
          data: {},
        };
        throw fault;
      },
    };

    const response = await handleRequest(
      new Request('http://localhost/v1/tenants/acme/quota', { method: 'GET' }),
      engine,
      {
        operationRegistry: createOperationRegistry([failingOperation]),
        restBindings: [getTenantQuotaRestBinding],
        ...quotaAuthContext(),
      },
    );

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: 'Internal server error' });
  });

  it('uses the fallback HTTP mapper for non-special-cased faults', async () => {
    engine = createEngine();

    const conflictOperation = {
      ...getTenantQuotaOperation,
      invoke: async () => {
        throw {
          code: 'Conflict',
          message: 'quota conflict',
          data: { reason: 'quota conflict' },
        } satisfies OperationFault;
      },
    };

    const response = await handleRequest(
      new Request('http://localhost/v1/tenants/acme/quota', { method: 'GET' }),
      engine,
      {
        operationRegistry: createOperationRegistry([conflictOperation]),
        restBindings: [getTenantQuotaRestBinding],
        ...quotaAuthContext(),
      },
    );

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: 'quota conflict' });
  });
});

const QUOTA_TEST_SECRET = 'get-tenant-quota-cross-transport-test-secret-1234567890';

async function issueQuotaJwt(
  scopes: string[],
  claims: Record<string, unknown> = {},
): Promise<string> {
  return signJWT(
    {
      sub: 'quota-test-user',
      scope: scopes.join(' '),
      ...claims,
    },
    QUOTA_TEST_SECRET,
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

function waitForMessage(
  ws: WebSocket,
  predicate: (parsed: unknown) => boolean,
  timeoutMs = 3_000,
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      ws.removeEventListener('message', handler);
      reject(new Error('waitForMessage timed out'));
    }, timeoutMs);

    function handler(event: MessageEvent) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(String(event.data));
      } catch {
        return;
      }

      if (predicate(parsed)) {
        clearTimeout(timer);
        ws.removeEventListener('message', handler);
        resolve(parsed);
      }
    }

    ws.addEventListener('message', handler);
  });
}

function openWebSocket(url: string, token?: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const socket: WebSocket =
      token === undefined
        ? new WebSocket(url)
        : Reflect.construct(WebSocket, [url, { headers: { authorization: `Bearer ${token}` } }]);
    socket.addEventListener('open', () => resolve(socket));
    socket.addEventListener('error', (event: Event) => reject(event));
  });
}

describe('runtime operation cross-transport contract', () => {
  const servers: WeftServer[] = [];
  const liveEngines: Engine[] = [];

  afterEach(async () => {
    while (servers.length > 0) {
      await servers.pop()?.stop();
    }
    while (liveEngines.length > 0) {
      liveEngines.pop()?.[Symbol.dispose]();
    }
  });

  it('registers all data-driven runtime operations and serves them identically over REST and JSON-RPC', async () => {
    // The data-driven runtime operations are all present in the live registry.
    const liveRegistry = createLiveOperationRegistry();
    const expected = [
      'weft.schedules.list',
      'weft.schedules.get',
      'weft.tenants.quota.get',
      'weft.workflows.replay',
      'weft.system.metrics',
    ];
    for (const name of expected) {
      expect(liveRegistry.get(name)).toBeDefined();
    }

    // `weft.tenants.quota.get` is addressable over both REST and JSON-RPC HTTP
    // and both transports reach the same engine result with the same shape.
    const engine = createTenantAwareEngine();
    liveEngines.push(engine);
    const server = serve({
      engine,
      port: 0,
      auth: { jwt: { secret: QUOTA_TEST_SECRET } },
    });
    servers.push(server);

    const token = await issueQuotaJwt(['quota:read'], { tenantId: 'acme' });

    const restResponse = await fetch(`${server.url}/v1/tenants/acme/quota`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(restResponse.status).toBe(200);
    const restBody = (await restResponse.json()) as Record<string, unknown>;

    const jsonRpcResponse = await postJsonRpc(
      server,
      { method: 'weft.tenants.quota.get', params: { tenantId: 'acme' } },
      token,
    );
    expect(jsonRpcResponse.status).toBe(200);
    const jsonRpcBody = (await jsonRpcResponse.json()) as { result: Record<string, unknown> };

    expect(jsonRpcBody.result).toEqual(restBody);
  });

  it('enforces scope-based authorization identically over REST, JSON-RPC HTTP, WebSocket, and stdio', async () => {
    // The scoped runtime operations declare scoped access in the live registry.
    const liveRegistry = createLiveOperationRegistry();
    expect(liveRegistry.get('weft.tenants.quota.get')?.access.kind).toBe('scoped');
    expect(liveRegistry.get('weft.workflows.replay')?.access.kind).toBe('scoped');
    expect(liveRegistry.get('weft.system.metrics')?.access.kind).toBe('scoped');

    const engine = createTenantAwareEngine();
    liveEngines.push(engine);
    const server = serve({
      engine,
      port: 0,
      auth: { jwt: { secret: QUOTA_TEST_SECRET } },
    });
    servers.push(server);

    // A principal authenticated with the wrong scope is rejected Forbidden on
    // every transport.
    const wrongScopeToken = await issueQuotaJwt(['workflows:read'], { tenantId: 'acme' });

    // REST — Forbidden
    const restResponse = await fetch(`${server.url}/v1/tenants/acme/quota`, {
      headers: { Authorization: `Bearer ${wrongScopeToken}` },
    });
    expect(restResponse.status).toBe(403);

    // JSON-RPC HTTP — Forbidden surfaced in the JSON-RPC error payload
    const jsonRpcResponse = await postJsonRpc(
      server,
      { method: 'weft.tenants.quota.get', params: { tenantId: 'acme' } },
      wrongScopeToken,
    );
    expect(jsonRpcResponse.status).toBe(200);
    const jsonRpcBody = (await jsonRpcResponse.json()) as {
      error?: { data?: { weftCode?: string; httpStatus?: number } };
    };
    expect(jsonRpcBody.error?.data?.weftCode).toBe('Forbidden');
    expect(jsonRpcBody.error?.data?.httpStatus).toBe(403);

    // JSON-RPC WebSocket — Forbidden, principal bound at upgrade
    const wsUrl = server.url.replace(/^http/, 'ws') + '/jsonrpc';
    const ws = await openWebSocket(wsUrl, wrongScopeToken);
    try {
      const wsId = crypto.randomUUID();
      const wsResponsePromise = waitForMessage(
        ws,
        (parsed) =>
          typeof parsed === 'object' &&
          parsed !== null &&
          'id' in parsed &&
          (parsed as { id: unknown }).id === wsId,
      );
      ws.send(
        JSON.stringify({
          jsonrpc: '2.0',
          id: wsId,
          method: 'weft.tenants.quota.get',
          params: { tenantId: 'acme' },
        }),
      );
      const wsResponse = (await wsResponsePromise) as {
        error?: { data?: { weftCode?: string } };
      };
      expect(wsResponse.error?.data?.weftCode).toBe('Forbidden');
    } finally {
      ws.close();
    }

    // stdio — Forbidden via the same operation policy hook
    const stdioPrincipal = principalFromJwtClaims({
      sub: 'quota-test-user',
      scope: 'workflows:read',
      tenantId: 'acme',
    });
    const stdioResult = await executeOperation(
      'weft.tenants.quota.get',
      { tenantId: 'acme' },
      {
        engine,
        registry: liveRegistry,
        principal: stdioPrincipal,
        transport: 'jsonRpcStdio',
      },
    );
    expect(stdioResult.ok).toBe(false);
    if (!stdioResult.ok) {
      expect(stdioResult.fault.code).toBe('Forbidden');
    }
  });

  it('rejects a JWT for tenant A reading tenant B with Forbidden on all four transports', async () => {
    const engine = createTenantAwareEngine();
    liveEngines.push(engine);
    // A token for tenant-a with quota:read — must not be able to read tenant-b.
    const tenantAToken = await issueQuotaJwt(['quota:read'], { tenantId: 'tenant-a' });

    const server = serve({
      engine,
      port: 0,
      auth: { jwt: { secret: QUOTA_TEST_SECRET } },
    });
    servers.push(server);

    // REST — 403
    const restResponse = await fetch(`${server.url}/v1/tenants/tenant-b/quota`, {
      headers: { Authorization: `Bearer ${tenantAToken}` },
    });
    expect(restResponse.status).toBe(403);

    // JSON-RPC HTTP — Forbidden
    const jsonRpcResponse = await postJsonRpc(
      server,
      { method: 'weft.tenants.quota.get', params: { tenantId: 'tenant-b' } },
      tenantAToken,
    );
    expect(jsonRpcResponse.status).toBe(200);
    const jsonRpcBody = (await jsonRpcResponse.json()) as {
      error?: { data?: { weftCode?: string; httpStatus?: number } };
    };
    expect(jsonRpcBody.error?.data?.weftCode).toBe('Forbidden');
    expect(jsonRpcBody.error?.data?.httpStatus).toBe(403);

    // JSON-RPC WebSocket — Forbidden
    const wsUrl = `${server.url.replace('http://', 'ws://')}/jsonrpc`;
    const ws = await openWebSocket(wsUrl, tenantAToken);
    const wsResponsePromise = waitForMessage(
      ws,
      (parsed) =>
        typeof parsed === 'object' &&
        parsed !== null &&
        (parsed as { id?: string }).id === 'idor-ws',
    );
    ws.send(
      JSON.stringify({
        jsonrpc: '2.0',
        id: 'idor-ws',
        method: 'weft.tenants.quota.get',
        params: { tenantId: 'tenant-b' },
      }),
    );
    const wsResponse = (await wsResponsePromise) as {
      error?: { data?: { weftCode?: string; httpStatus?: number } };
    };
    expect(wsResponse.error?.data?.weftCode).toBe('Forbidden');
    expect(wsResponse.error?.data?.httpStatus).toBe(403);
    ws.close();

    // stdio — executeOperation with the decoded JWT principal
    const tenantAPrincipal = principalFromJwtClaims({
      sub: 'user-a',
      scope: 'quota:read',
      tenantId: 'tenant-a',
    });
    const liveRegistry = createLiveOperationRegistry();
    const stdioResult = await executeOperation(
      'weft.tenants.quota.get',
      { tenantId: 'tenant-b' },
      { principal: tenantAPrincipal, engine, transport: 'jsonRpcStdio', registry: liveRegistry },
    );
    expect(stdioResult.ok).toBe(false);
    if (stdioResult.ok) throw new Error('expected Forbidden');
    expect(stdioResult.fault.code).toBe('Forbidden');
  });
});
