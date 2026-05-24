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
 * Cross-transport behavior shared by all data-driven operations (registry
 * membership, transport-neutral authorization, tenant isolation) lives in
 * `cross-transport-contract.test.ts`.
 */

import { afterEach, describe, expect, it } from 'bun:test';

import { Engine } from '../../core/engine.ts';
import { tenantFromInputField } from '../../core/tenant.ts';
import type { WorkflowContext } from '../../core/types.ts';
import { workflow } from '../../core/types.ts';
import { MemoryStorage } from '../../storage/memory.ts';
import { handleRequest } from '../handler.ts';
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
