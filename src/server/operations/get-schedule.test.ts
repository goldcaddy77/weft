/**
 * `weft.schedules.get` operation + REST binding — unit tests.
 *
 * Covers:
 * - Happy path returns the schedule summary.
 * - Missing schedule returns 404.
 * - JWT principal with no tenant claim returns Forbidden (schedules require tenant scope for JWT).
 * - _resolvedTenantId mismatch with JWT tenant claim returns Forbidden.
 * - Non-JWT authenticated principal (api-key) can access without tenant check.
 * - Unauthenticated principal returns Unauthorized.
 * - EngineFailure fault shaper returns 500.
 *
 * REST tests inject an authContext with an api-key principal so the
 * `access:authenticated` check passes. JWT-specific behavior is tested
 * directly via `executeOperation`.
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
import { getScheduleOperation, getScheduleRestBinding } from './get-schedule.ts';

function createEngine(): Engine {
  const engine = new Engine({ storage: new MemoryStorage() });
  engine.register('echo', async function* (_ctx: WorkflowContext, input: unknown) {
    return input;
  });
  return engine;
}

/** AuthContext for handleRequest that satisfies the access:authenticated check via api-key. */
function apiKeyAuthContext() {
  return {
    authContext: {
      method: 'api-key' as const,
      principal: principalFromApiKey({ subject: 'test', scopes: [] }),
    },
  };
}

const registry = createOperationRegistry([getScheduleOperation]);

describe('weft.schedules.get', () => {
  let engine: Engine | undefined;

  afterEach(() => {
    engine?.[Symbol.dispose]();
  });

  it('returns the schedule summary on the happy path (api-key principal)', async () => {
    engine = createEngine();
    await engine.schedule('echo', { payload: 'alpha' }, '0 * * * *', { id: 'schedule-alpha' });

    const response = await handleRequest(
      new Request('http://localhost/v1/schedules/schedule-alpha', { method: 'GET' }),
      engine,
      {
        operationRegistry: registry,
        restBindings: [getScheduleRestBinding],
        ...apiKeyAuthContext(),
      },
    );

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('application/json');
    const body = (await response.json()) as { id?: string; workflowType?: string };
    expect(body.id).toBe('schedule-alpha');
    expect(body.workflowType).toBe('echo');
  });

  it('returns 404 when the schedule does not exist', async () => {
    engine = createEngine();

    const response = await handleRequest(
      new Request('http://localhost/v1/schedules/does-not-exist', { method: 'GET' }),
      engine,
      {
        operationRegistry: registry,
        restBindings: [getScheduleRestBinding],
        ...apiKeyAuthContext(),
      },
    );

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: 'Schedule "does-not-exist" not found' });
  });

  it('allows a non-JWT authenticated principal (api-key) without tenant scope restriction', async () => {
    engine = createEngine();
    await engine.schedule('echo', {}, '0 * * * *', { id: 'apikey-schedule' });

    const liveRegistry = createLiveOperationRegistry();
    const principal = principalFromApiKey({ subject: 'svc', scopes: [] });

    const result = await executeOperation(
      'weft.schedules.get',
      { scheduleId: 'apikey-schedule' },
      { principal, engine, transport: 'jsonRpcStdio', registry: liveRegistry },
    );

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected success');
    const schedule = result.value as { id?: string };
    expect(schedule.id).toBe('apikey-schedule');
  });

  it('rejects an unauthenticated principal with Unauthorized', async () => {
    engine = createEngine();
    await engine.schedule('echo', {}, '0 * * * *', { id: 'any-schedule' });

    const liveRegistry = createLiveOperationRegistry();
    const result = await executeOperation(
      'weft.schedules.get',
      { scheduleId: 'any-schedule' },
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
    await engine.schedule('echo', {}, '0 * * * *', { id: 'jwt-schedule' });

    // JWT principal with no tenantId claim → resolveScheduleAccessOptions returns Forbidden
    const principal = principalFromJwtClaims({ sub: 'user', scope: 'workflows:read' });
    const liveRegistry = createLiveOperationRegistry();

    const result = await executeOperation(
      'weft.schedules.get',
      { scheduleId: 'jwt-schedule' },
      { principal, engine, transport: 'jsonRpcStdio', registry: liveRegistry },
    );

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected rejection');
    expect(result.fault.code).toBe('Forbidden');
  });

  it('rejects _resolvedTenantId mismatch with JWT tenant claim with Forbidden', async () => {
    engine = createEngine();
    await engine.schedule('echo', {}, '0 * * * *', { id: 'tenant-schedule' });

    // JWT with tenantId: 'tenant-a'; _resolvedTenantId injected as 'tenant-b' — mismatch.
    const principal = principalFromJwtClaims({
      sub: 'user',
      scope: 'workflows:read',
      tenantId: 'tenant-a',
    });
    const liveRegistry = createLiveOperationRegistry();

    const result = await executeOperation(
      'weft.schedules.get',
      { scheduleId: 'tenant-schedule', _resolvedTenantId: 'tenant-b' },
      { principal, engine, transport: 'jsonRpcStdio', registry: liveRegistry },
    );

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected rejection');
    expect(result.fault.code).toBe('Forbidden');
  });

  it('a JWT with matching tenant claim passes the auth check but 404s if the schedule has no tenant', async () => {
    // When a schedule is created without a tenantResolver, it has no tenant association.
    // A JWT-scoped to tenant-a passes the Forbidden guard but gets a 404 because
    // engine.getSchedule filters by tenantId and finds no match.
    engine = createEngine();
    await engine.schedule('echo', {}, '0 * * * *', { id: 'tenant-a-schedule' });

    const principal = principalFromJwtClaims({
      sub: 'user',
      scope: 'workflows:read',
      tenantId: 'tenant-a',
    });
    const liveRegistry = createLiveOperationRegistry();

    const result = await executeOperation(
      'weft.schedules.get',
      { scheduleId: 'tenant-a-schedule' },
      { principal, engine, transport: 'jsonRpcStdio', registry: liveRegistry },
    );

    // The operation passes the Forbidden guard (tenantId matches claim),
    // but then calls e.getSchedule with { tenantId: 'tenant-a' } which
    // returns null for a non-tenant schedule → NotFound fault.
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected fault');
    expect(result.fault.code).toBe('NotFound');
  });

  it('maps EngineFailure faults to 500 with "Internal server error"', async () => {
    engine = createEngine();

    const failingOperation = {
      ...getScheduleOperation,
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
      new Request('http://localhost/v1/schedules/some-schedule', { method: 'GET' }),
      engine,
      {
        operationRegistry: createOperationRegistry([failingOperation]),
        restBindings: [getScheduleRestBinding],
        ...apiKeyAuthContext(),
      },
    );

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: 'Internal server error' });
  });

  it('shapes Unauthorized faults as 401', async () => {
    engine = createEngine();

    const unauthorizedOperation = {
      ...getScheduleOperation,
      invoke: async () => {
        throw {
          code: 'Unauthorized',
          message: 'missing credentials',
          data: { reason: 'missing credentials' },
        } satisfies OperationFault;
      },
    };

    const response = await handleRequest(
      new Request('http://localhost/v1/schedules/some-schedule', { method: 'GET' }),
      engine,
      {
        operationRegistry: createOperationRegistry([unauthorizedOperation]),
        restBindings: [getScheduleRestBinding],
        ...apiKeyAuthContext(),
      },
    );

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: 'missing credentials' });
  });

  it('uses the fallback HTTP mapper for non-special-cased faults', async () => {
    engine = createEngine();

    const conflictOperation = {
      ...getScheduleOperation,
      invoke: async () => {
        throw {
          code: 'Conflict',
          message: 'schedule conflict',
          data: { reason: 'schedule conflict' },
        } satisfies OperationFault;
      },
    };

    const response = await handleRequest(
      new Request('http://localhost/v1/schedules/some-schedule', { method: 'GET' }),
      engine,
      {
        operationRegistry: createOperationRegistry([conflictOperation]),
        restBindings: [getScheduleRestBinding],
        ...apiKeyAuthContext(),
      },
    );

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: 'schedule conflict' });
  });
});
