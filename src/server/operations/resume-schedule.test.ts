import { describe, expect, it } from 'bun:test';

import { Engine } from '../../core/engine.ts';
import { tenantFromInputField } from '../../core/tenant.ts';
import type { WorkflowContext } from '../../core/types.ts';
import { workflow } from '../../core/types.ts';
import { MemoryStorage } from '../../storage/memory.ts';
import { handleRequest, type HandlerOptions } from '../handler.ts';
import { createOperationRegistry } from '../operation-catalog.ts';
import { resumeScheduleOperation, resumeScheduleRestBinding } from './resume-schedule.ts';

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

const registry = createOperationRegistry([resumeScheduleOperation]);
const bindings = [resumeScheduleRestBinding];

describe('weft.schedules.resume', () => {
  it('resumes a paused schedule and returns 204', async () => {
    const engine = createEngine();
    await engine.schedule('echo', 'payload', '0 * * * *', { id: 'schedule-resume-success' });
    await engine.pauseSchedule('schedule-resume-success');

    const response = await handleRequest(
      new Request('http://localhost/v1/schedules/schedule-resume-success/resume', {
        method: 'POST',
      }),
      engine,
      {
        operationRegistry: registry,
        restBindings: bindings,
      },
    );

    expect(response.status).toBe(204);
    expect(await engine.getSchedule('schedule-resume-success')).toEqual(
      expect.objectContaining({ status: 'active' }),
    );
  });

  it('returns 404 when the schedule does not exist', async () => {
    const engine = createEngine();

    const response = await handleRequest(
      new Request('http://localhost/v1/schedules/does-not-exist/resume', { method: 'POST' }),
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
      new Request('http://localhost/v1/schedules/schedule-1/resume', { method: 'POST' }),
      engine,
      options,
    );

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({
      error: 'JWT-authenticated schedule requests require a tenantId, tenant_id, or tenant claim',
    });
  });

  it('returns 404 when a JWT-authenticated caller resumes another tenant’s schedule', async () => {
    const engine = createTenantAwareEngine();
    await engine.schedule('echo', { tenantId: 'globex' }, '0 * * * *', { id: 'schedule-globex' });
    await engine.pauseSchedule('schedule-globex', { tenantId: 'globex' });

    const response = await handleRequest(
      new Request('http://localhost/v1/schedules/schedule-globex/resume', { method: 'POST' }),
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
      expect.objectContaining({ status: 'paused' }),
    );
  });

  it('maps resumability conflicts to 409', async () => {
    const engine = createEngine();
    const originalResumeSchedule = engine.resumeSchedule.bind(engine);
    engine.resumeSchedule = async () => {
      throw new Error('Schedule cannot be resumed after cancellation');
    };

    try {
      const response = await handleRequest(
        new Request('http://localhost/v1/schedules/schedule-1/resume', { method: 'POST' }),
        engine,
        {
          operationRegistry: registry,
          restBindings: bindings,
        },
      );

      expect(response.status).toBe(409);
      expect(await response.json()).toEqual({
        error: 'Schedule cannot be resumed after cancellation',
      });
    } finally {
      engine.resumeSchedule = originalResumeSchedule;
    }
  });

  it('masks unexpected engine failures to a 500 generic error body', async () => {
    const engine = createEngine();
    const originalResumeSchedule = engine.resumeSchedule.bind(engine);
    engine.resumeSchedule = async () => {
      throw new Error('exploded');
    };

    try {
      const response = await handleRequest(
        new Request('http://localhost/v1/schedules/schedule-1/resume', { method: 'POST' }),
        engine,
        {
          operationRegistry: registry,
          restBindings: bindings,
        },
      );

      expect(response.status).toBe(500);
      expect(await response.json()).toEqual({ error: 'Internal server error' });
    } finally {
      engine.resumeSchedule = originalResumeSchedule;
    }
  });
});
