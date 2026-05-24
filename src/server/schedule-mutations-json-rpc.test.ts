/**
 * Cross-transport coverage for schedule mutation tenant scoping.
 *
 * The REST path is exercised in `handler.test.ts` and the colocated
 * operation tests. Tenant scope is forwarded at the `invoke` level via the
 * dispatched {@link Principal}, so it is transport-neutral — but the three
 * mutation operations also declare JSON-RPC transports. This suite dispatches
 * pause/resume/cancel through `dispatchJsonRpc` with a JWT principal to pin
 * that the scope is honored over JSON-RPC too: own-tenant calls succeed,
 * cross-tenant calls are masked as NotFound, and a JWT principal missing the
 * tenant claim is rejected as Forbidden.
 */

import { afterEach, describe, expect, it } from 'bun:test';

import { Engine } from '../core/engine.ts';
import { tenantFromInputField } from '../core/tenant.ts';
import type { WorkflowContext } from '../core/types.ts';
import { workflow } from '../core/types.ts';
import { MemoryStorage } from '../storage/memory.ts';
import { dispatchJsonRpc } from './json-rpc-dispatch.ts';
import { createOperationRegistry } from './operation-catalog.ts';
import { cancelScheduleOperation } from './operations/cancel-schedule.ts';
import { pauseScheduleOperation } from './operations/pause-schedule.ts';
import { resumeScheduleOperation } from './operations/resume-schedule.ts';
import { principalFromJwtClaims } from './principal.ts';

// JSON-RPC error codes (src/server/operation-fault.ts).
const FORBIDDEN_CODE = -32011;
const NOT_FOUND_CODE = -32020;

const echoWorkflow = workflow({ name: 'echo' }).execute(async function* (
  _ctx: WorkflowContext,
  input: unknown,
) {
  return input;
});

function createTenantAwareEngine(): Engine {
  const engine = new Engine({
    storage: new MemoryStorage(),
    tenantResolver: tenantFromInputField('tenantId'),
  });
  engine.register(echoWorkflow);
  return engine;
}

const registry = createOperationRegistry([
  pauseScheduleOperation,
  resumeScheduleOperation,
  cancelScheduleOperation,
]);

function call(engine: Engine, method: string, scheduleId: string, tenantId?: string) {
  const principal =
    tenantId === undefined
      ? principalFromJwtClaims({ sub: 'user-123' })
      : principalFromJwtClaims({ tenantId });
  return dispatchJsonRpc(
    JSON.stringify({ jsonrpc: '2.0', method, params: { scheduleId }, id: 1 }),
    { principal, engine, transport: 'jsonRpcHttp', registry },
  );
}

describe('schedule mutations forward JWT tenant scope over JSON-RPC', () => {
  let engine: Engine | undefined;

  afterEach(() => {
    engine?.[Symbol.dispose]();
    engine = undefined;
  });

  it('honors the JWT tenant claim for an own-tenant pause/resume/cancel', async () => {
    engine = createTenantAwareEngine();
    await engine.schedule('echo', { tenantId: 'acme' }, '0 * * * *', { id: 'schedule-acme' });
    await engine.schedule('echo', { tenantId: 'acme' }, '0 * * * *', {
      id: 'schedule-acme-cancel',
    });

    const paused = await call(engine, 'weft.schedules.pause', 'schedule-acme', 'acme');
    if (paused.kind !== 'single' || 'error' in paused.response) {
      throw new Error('expected pause success');
    }
    expect(await engine.getSchedule('schedule-acme', { tenantId: 'acme' })).toEqual(
      expect.objectContaining({ status: 'paused' }),
    );

    const resumed = await call(engine, 'weft.schedules.resume', 'schedule-acme', 'acme');
    if (resumed.kind !== 'single' || 'error' in resumed.response) {
      throw new Error('expected resume success');
    }
    expect(await engine.getSchedule('schedule-acme', { tenantId: 'acme' })).toEqual(
      expect.objectContaining({ status: 'active' }),
    );

    const cancelled = await call(engine, 'weft.schedules.cancel', 'schedule-acme-cancel', 'acme');
    if (cancelled.kind !== 'single' || 'error' in cancelled.response) {
      throw new Error('expected cancel success');
    }
    expect(await engine.getSchedule('schedule-acme-cancel', { tenantId: 'acme' })).toEqual(
      expect.objectContaining({ status: 'cancelled' }),
    );
  });

  it('masks cross-tenant mutation as NotFound, indistinguishable from a missing schedule, and never mutates', async () => {
    engine = createTenantAwareEngine();
    // A dedicated globex schedule per method so each denied call is checked in
    // isolation — a broken impl that round-trips pause→resume back to `active`
    // cannot hide behind a single end-of-test assertion.
    await engine.schedule('echo', { tenantId: 'globex' }, '0 * * * *', {
      id: 'globex-pause',
    });
    await engine.schedule('echo', { tenantId: 'globex' }, '0 * * * *', {
      id: 'globex-resume',
    });
    await engine.pauseSchedule('globex-resume', { tenantId: 'globex' });
    await engine.schedule('echo', { tenantId: 'globex' }, '0 * * * *', {
      id: 'globex-cancel',
    });

    const cases = [
      { method: 'weft.schedules.pause', id: 'globex-pause', remains: 'active' },
      { method: 'weft.schedules.resume', id: 'globex-resume', remains: 'paused' },
      { method: 'weft.schedules.cancel', id: 'globex-cancel', remains: 'active' },
    ] as const;

    for (const { method, id, remains } of cases) {
      const result = await call(engine, method, id, 'acme');
      if (result.kind !== 'single' || !('error' in result.response)) {
        throw new Error(`expected error response for ${method}`);
      }
      expect(result.response.error.code).toBe(NOT_FOUND_CODE);
      // Cross-tenant denial is masked with the same message a genuinely-missing
      // schedule would produce — no message/data oracle distinguishing
      // "exists but not yours" from "does not exist".
      expect(result.response.error.message).toBe(`Schedule "${id}" not found`);

      // Assert the denied call did not mutate the schedule before moving on.
      expect(await engine.getSchedule(id, { tenantId: 'globex' })).toEqual(
        expect.objectContaining({ status: remains, cronExpression: '0 * * * *' }),
      );
    }

    // A genuinely-missing id returns the identical NotFound code + message
    // shape, confirming there is no existence oracle over JSON-RPC.
    const missing = await call(engine, 'weft.schedules.pause', 'globex-nonexistent', 'acme');
    if (missing.kind !== 'single' || !('error' in missing.response)) {
      throw new Error('expected error response for missing schedule');
    }
    expect(missing.response.error.code).toBe(NOT_FOUND_CODE);
    expect(missing.response.error.message).toBe('Schedule "globex-nonexistent" not found');
  });

  it('rejects a JWT principal missing the tenant claim as Forbidden', async () => {
    engine = createTenantAwareEngine();
    await engine.schedule('echo', { tenantId: 'acme' }, '0 * * * *', { id: 'schedule-acme' });

    for (const method of [
      'weft.schedules.pause',
      'weft.schedules.resume',
      'weft.schedules.cancel',
    ]) {
      const result = await call(engine, method, 'schedule-acme');
      if (result.kind !== 'single' || !('error' in result.response)) {
        throw new Error(`expected error response for ${method}`);
      }
      expect(result.response.error.code).toBe(FORBIDDEN_CODE);
    }

    // The missing-claim rejection short-circuits before the engine, so the
    // schedule is never touched.
    expect(await engine.getSchedule('schedule-acme', { tenantId: 'acme' })).toEqual(
      expect.objectContaining({ status: 'active' }),
    );
  });
});
