import { describe, expect, it } from 'bun:test';

import { Engine } from '../../core/engine.ts';
import { tenantFromInputField } from '../../core/tenant.ts';
import type { WorkflowContext } from '../../core/types.ts';
import { workflow } from '../../core/types.ts';
import { MemoryStorage } from '../../storage/memory.ts';
import { handleRequest, type HandlerOptions } from '../handler.ts';
import { createOperationRegistry } from '../operation-catalog.ts';
import { cancelScheduleOperation, cancelScheduleRestBinding } from './cancel-schedule.ts';

const echoWorkflow = workflow({ name: 'echo' }).execute(async function* (
  _ctx: WorkflowContext,
  input: unknown,
) {
  return input;
});

function createEngine(): Engine {
  const storage = new MemoryStorage();
  const engine = new Engine({ storage });
  engine.register(echoWorkflow);
  return engine;
}

function createTenantAwareEngine(): Engine {
  const engine = new Engine({
    storage: new MemoryStorage(),
    tenantResolver: tenantFromInputField('tenantId'),
  });
  engine.register(echoWorkflow);
  return engine;
}

const registry = createOperationRegistry([cancelScheduleOperation]);
const bindings = [cancelScheduleRestBinding];

describe('weft.schedules.cancel', () => {
  it('cancels a schedule and returns 204', async () => {
    const engine = createEngine();
    await engine.schedule('echo', 'payload', '0 * * * *', { id: 'schedule-cancel-success' });

    const response = await handleRequest(
      new Request('http://localhost/v1/schedules/schedule-cancel-success', {
        method: 'DELETE',
      }),
      engine,
      {
        operationRegistry: registry,
        restBindings: bindings,
      },
    );

    expect(response.status).toBe(204);
    expect(await engine.getSchedule('schedule-cancel-success')).toEqual(
      expect.objectContaining({ status: 'cancelled' }),
    );
  });

  it('returns 404 when the schedule does not exist', async () => {
    const engine = createEngine();

    const response = await handleRequest(
      new Request('http://localhost/v1/schedules/does-not-exist', { method: 'DELETE' }),
      engine,
      {
        operationRegistry: registry,
        restBindings: bindings,
      },
    );

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: 'Schedule "does-not-exist" not found' });
  });

  it('returns 403 when a JWT-authenticated request is missing a tenant claim', async () => {
    const engine = createTenantAwareEngine();
    const options: HandlerOptions = {
      authContext: { method: 'jwt', claims: { sub: 'user-123' } },
      operationRegistry: registry,
      restBindings: bindings,
    };

    const response = await handleRequest(
      new Request('http://localhost/v1/schedules/schedule-1', { method: 'DELETE' }),
      engine,
      options,
    );

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({
      error: 'JWT-authenticated schedule requests require a tenantId, tenant_id, or tenant claim',
    });
  });

  it('returns 404 when a JWT-authenticated caller cancels another tenant’s schedule', async () => {
    const engine = createTenantAwareEngine();
    await engine.schedule('echo', { tenantId: 'globex' }, '0 * * * *', { id: 'schedule-globex' });

    const response = await handleRequest(
      new Request('http://localhost/v1/schedules/schedule-globex', { method: 'DELETE' }),
      engine,
      {
        authContext: { method: 'jwt', claims: { tenantId: 'acme' } },
        operationRegistry: registry,
        restBindings: bindings,
      },
    );

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: 'Schedule "schedule-globex" not found' });
    expect(await engine.getSchedule('schedule-globex', { tenantId: 'globex' })).toEqual(
      expect.objectContaining({ status: 'active' }),
    );
  });

  it('maps authenticated-tenant errors to 403', async () => {
    const engine = createEngine();
    const originalCancelSchedule = engine.cancelSchedule.bind(engine);
    engine.cancelSchedule = async () => {
      throw new Error('Authenticated tenant cannot access this schedule');
    };

    try {
      const response = await handleRequest(
        new Request('http://localhost/v1/schedules/schedule-1', { method: 'DELETE' }),
        engine,
        {
          operationRegistry: registry,
          restBindings: bindings,
        },
      );

      expect(response.status).toBe(403);
      expect(await response.json()).toEqual({
        error: 'Authenticated tenant cannot access this schedule',
      });
    } finally {
      engine.cancelSchedule = originalCancelSchedule;
    }
  });

  it('masks unexpected engine failures to a 500 generic error body', async () => {
    const engine = createEngine();
    const originalCancelSchedule = engine.cancelSchedule.bind(engine);
    engine.cancelSchedule = async () => {
      throw new Error('exploded');
    };

    try {
      const response = await handleRequest(
        new Request('http://localhost/v1/schedules/schedule-1', { method: 'DELETE' }),
        engine,
        {
          operationRegistry: registry,
          restBindings: bindings,
        },
      );

      expect(response.status).toBe(500);
      expect(await response.json()).toEqual({ error: 'Internal server error' });
    } finally {
      engine.cancelSchedule = originalCancelSchedule;
    }
  });
});
