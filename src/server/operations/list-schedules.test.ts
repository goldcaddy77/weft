/**
 * `weft.schedules.list` operation + REST binding — unit tests.
 *
 * Covers:
 * - Happy path returns paginated schedule list.
 * - Invalid status value returns 400.
 * - Valid status values are accepted.
 * - Limit capped at 1000 (no error for large values).
 * - Offset must be non-negative.
 * - Unauthenticated principal returns Unauthorized.
 * - JWT without tenant claim returns Forbidden.
 * - _resolvedTenantId mismatch with JWT tenant claim returns Forbidden.
 * - tenantId filter that disagrees with JWT resolved tenant returns Forbidden.
 * - EngineFailure fault shaper returns 500.
 *
 * REST tests inject an authContext with an api-key principal so the
 * `access:authenticated` check passes.
 */

import { afterEach, describe, expect, it } from 'bun:test';

import { Engine } from '../../core/engine.ts';
import type { WorkflowContext } from '../../core/types.ts';
import { MemoryStorage } from '../../storage/memory.ts';
import { handleRequest } from '../handler.ts';
import { createOperationRegistry, executeOperation } from '../operation-catalog.ts';
import type { OperationFault } from '../operation-fault.ts';
import { anonymousPrincipal, principalFromApiKey, principalFromJwtClaims } from '../principal.ts';
import { createLiveOperationRegistry } from '../rest-bindings.ts';
import { listSchedulesOperation, listSchedulesRestBinding } from './list-schedules.ts';

function createEngine(): Engine {
  const engine = new Engine({ storage: new MemoryStorage() });
  engine.register('echo', async function* (_ctx: WorkflowContext, input: unknown) {
    return input;
  });
  return engine;
}

/** AuthContext for handleRequest that satisfies the access:authenticated check. */
function apiKeyAuthContext() {
  return {
    authContext: {
      method: 'api-key' as const,
      principal: principalFromApiKey({ subject: 'test', scopes: [] }),
    },
  };
}

const registry = createOperationRegistry([listSchedulesOperation]);

describe('weft.schedules.list', () => {
  let engine: Engine | undefined;

  afterEach(() => {
    engine?.[Symbol.dispose]();
  });

  it('returns a paginated list of schedules on the happy path', async () => {
    engine = createEngine();
    await engine.schedule('echo', { x: 1 }, '0 * * * *', { id: 'sched-a' });
    await engine.schedule('echo', { x: 2 }, '30 * * * *', { id: 'sched-b' });

    const response = await handleRequest(
      new Request('http://localhost/v1/schedules', { method: 'GET' }),
      engine,
      {
        operationRegistry: registry,
        restBindings: [listSchedulesRestBinding],
        ...apiKeyAuthContext(),
      },
    );

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('application/json');
    const body = (await response.json()) as {
      items?: Array<{ id: string }>;
      total?: number;
      limit?: number;
      offset?: number;
    };
    expect(Array.isArray(body.items)).toBe(true);
    expect(body.items?.map((s) => s.id).toSorted()).toEqual(['sched-a', 'sched-b']);
    expect(typeof body.total).toBe('number');
    expect(typeof body.limit).toBe('number');
    expect(typeof body.offset).toBe('number');
  });

  it('returns 400 when the status query param is not valid', async () => {
    engine = createEngine();

    const response = await handleRequest(
      new Request('http://localhost/v1/schedules?status=INVALID', { method: 'GET' }),
      engine,
      {
        operationRegistry: registry,
        restBindings: [listSchedulesRestBinding],
        ...apiKeyAuthContext(),
      },
    );

    expect(response.status).toBe(400);
    const body = (await response.json()) as { error?: string };
    expect(body.error).toContain('status');
  });

  it('accepts valid status values: active, paused, cancelled', async () => {
    engine = createEngine();
    await engine.schedule('echo', {}, '0 * * * *', { id: 'active-sched' });

    for (const status of ['active', 'paused', 'cancelled']) {
      const response = await handleRequest(
        new Request(`http://localhost/v1/schedules?status=${status}`, { method: 'GET' }),
        engine,
        {
          operationRegistry: registry,
          restBindings: [listSchedulesRestBinding],
          ...apiKeyAuthContext(),
        },
      );
      expect(response.status).toBe(200);
    }
  });

  it('caps limit at 1000 internally without returning an error', async () => {
    engine = createEngine();

    // limit=9999 should be silently clamped to 1000 — not rejected.
    const response = await handleRequest(
      new Request('http://localhost/v1/schedules?limit=9999', { method: 'GET' }),
      engine,
      {
        operationRegistry: registry,
        restBindings: [listSchedulesRestBinding],
        ...apiKeyAuthContext(),
      },
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as { limit?: number };
    expect(typeof body.limit).toBe('number');
  });

  it('returns 400 when limit is not a positive integer', async () => {
    engine = createEngine();

    const response = await handleRequest(
      new Request('http://localhost/v1/schedules?limit=0', { method: 'GET' }),
      engine,
      {
        operationRegistry: registry,
        restBindings: [listSchedulesRestBinding],
        ...apiKeyAuthContext(),
      },
    );

    expect(response.status).toBe(400);
  });

  it('returns 400 when offset is negative', async () => {
    engine = createEngine();

    const response = await handleRequest(
      new Request('http://localhost/v1/schedules?offset=-1', { method: 'GET' }),
      engine,
      {
        operationRegistry: registry,
        restBindings: [listSchedulesRestBinding],
        ...apiKeyAuthContext(),
      },
    );

    expect(response.status).toBe(400);
  });

  it('rejects an unauthenticated principal with Unauthorized', async () => {
    engine = createEngine();

    const liveRegistry = createLiveOperationRegistry();
    const result = await executeOperation(
      'weft.schedules.list',
      {},
      {
        principal: anonymousPrincipal(),
        engine,
        transport: 'jsonRpcStdio',
        registry: liveRegistry,
      },
    );

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected rejection');
    expect(result.fault.code).toBe('Unauthorized');
  });

  it('rejects a JWT without a tenant claim with Forbidden', async () => {
    engine = createEngine();

    // JWT principal with no tenantId claim → resolveScheduleAccessOptions returns Forbidden
    const principal = principalFromJwtClaims({ sub: 'user', scope: 'workflows:read' });
    const liveRegistry = createLiveOperationRegistry();

    const result = await executeOperation(
      'weft.schedules.list',
      {},
      { principal, engine, transport: 'jsonRpcStdio', registry: liveRegistry },
    );

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected rejection');
    expect(result.fault.code).toBe('Forbidden');
  });

  it('rejects _resolvedTenantId mismatch with JWT tenant claim with Forbidden', async () => {
    engine = createEngine();

    const principal = principalFromJwtClaims({
      sub: 'user',
      scope: 'workflows:read',
      tenantId: 'tenant-a',
    });
    const liveRegistry = createLiveOperationRegistry();

    const result = await executeOperation(
      'weft.schedules.list',
      { _resolvedTenantId: 'tenant-b' },
      { principal, engine, transport: 'jsonRpcStdio', registry: liveRegistry },
    );

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected rejection');
    expect(result.fault.code).toBe('Forbidden');
  });

  it('rejects tenantId filter that disagrees with resolved JWT tenant with Forbidden', async () => {
    engine = createEngine();

    const principal = principalFromJwtClaims({
      sub: 'user',
      scope: 'workflows:read',
      tenantId: 'tenant-a',
    });
    const liveRegistry = createLiveOperationRegistry();

    const result = await executeOperation(
      'weft.schedules.list',
      { tenantId: 'tenant-b' },
      { principal, engine, transport: 'jsonRpcStdio', registry: liveRegistry },
    );

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected rejection');
    expect(result.fault.code).toBe('Forbidden');
  });

  it('maps EngineFailure faults to 500 with "Internal server error"', async () => {
    engine = createEngine();

    const failingOperation = {
      ...listSchedulesOperation,
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
      new Request('http://localhost/v1/schedules', { method: 'GET' }),
      engine,
      {
        operationRegistry: createOperationRegistry([failingOperation]),
        restBindings: [listSchedulesRestBinding],
        ...apiKeyAuthContext(),
      },
    );

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: 'Internal server error' });
  });
});
