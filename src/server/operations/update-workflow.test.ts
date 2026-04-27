import { describe, expect, it } from 'bun:test';

import { Engine } from '../../core/engine.ts';
import type { WorkflowContext } from '../../core/types.ts';
import { UpdateTimeoutError, WorkflowTerminalError } from '../../core/updates.ts';
import { MemoryStorage } from '../../storage/memory.ts';
import { handleRequest } from '../handler.ts';
import { createOperationRegistry } from '../operation-catalog.ts';
import { updateWorkflowOperation, updateWorkflowRestBinding } from './update-workflow.ts';

function createEngine(): Engine {
  const engine = new Engine({ storage: new MemoryStorage() });
  engine.register('echo', async function* (_ctx: WorkflowContext, input: unknown) {
    return input;
  });
  return engine;
}

function request(method: string, path: string, body?: unknown): Request {
  const options: RequestInit = { method };
  if (body !== undefined) {
    options.headers = { 'Content-Type': 'application/json' };
    options.body = JSON.stringify(body);
  }
  return new Request(`http://localhost${path}`, options);
}

function invalidJsonRequest(method: string, path: string, rawBody: string): Request {
  return new Request(`http://localhost${path}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: rawBody,
  });
}

const registry = createOperationRegistry([updateWorkflowOperation]);
const bindings = [updateWorkflowRestBinding];

describe('weft.workflows.update', () => {
  it('returns 200 with the update result on the happy path', async () => {
    const engine = createEngine();
    const originalSubmit = engine.submitCoordinatedUpdate.bind(engine);

    try {
      engine.submitCoordinatedUpdate = async (workflowId, updateName, payload, options) => {
        expect(workflowId).toBe('workflow-123');
        expect(updateName).toBe('rename');
        expect(payload).toEqual({ name: 'Alice' });
        expect(options).toEqual({ timeout: 2_000, idempotencyKey: 'update-1' });
        return {
          updateId: 'update-123',
          result: { ok: true },
        } as Awaited<ReturnType<Engine['submitCoordinatedUpdate']>>;
      };

      const response = await handleRequest(
        request('POST', '/v1/workflows/workflow-123/update/rename', {
          payload: { name: 'Alice' },
          timeout: 2_000,
          idempotencyKey: 'update-1',
        }),
        engine,
        { operationRegistry: registry, restBindings: bindings },
      );

      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({
        updateId: 'update-123',
        result: { ok: true },
      });
    } finally {
      engine.submitCoordinatedUpdate = originalSubmit;
    }
  });

  it('silently ignores invalid JSON bodies and uses the default timeout', async () => {
    const engine = createEngine();
    const originalSubmit = engine.submitCoordinatedUpdate.bind(engine);

    try {
      engine.submitCoordinatedUpdate = async (_workflowId, _updateName, payload, options) => {
        expect(payload).toBeUndefined();
        expect(options).toEqual({ timeout: 30_000 });
        return {
          updateId: 'update-invalid-json',
          result: null,
        } as Awaited<ReturnType<Engine['submitCoordinatedUpdate']>>;
      };

      const response = await handleRequest(
        invalidJsonRequest('POST', '/v1/workflows/workflow-123/update/rename', '{'),
        engine,
        { operationRegistry: registry, restBindings: bindings },
      );

      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ updateId: 'update-invalid-json', result: null });
    } finally {
      engine.submitCoordinatedUpdate = originalSubmit;
    }
  });

  it('returns 422 when the coordinated update result contains an error string', async () => {
    const engine = createEngine();
    const originalSubmit = engine.submitCoordinatedUpdate.bind(engine);

    try {
      engine.submitCoordinatedUpdate = async () =>
        ({
          updateId: 'update-error',
          error: 'workflow rejected update',
        }) as Awaited<ReturnType<Engine['submitCoordinatedUpdate']>>;

      const response = await handleRequest(
        request('POST', '/v1/workflows/workflow-123/update/rename', { payload: {} }),
        engine,
        { operationRegistry: registry, restBindings: bindings },
      );

      expect(response.status).toBe(422);
      expect(await response.json()).toEqual({ error: 'workflow rejected update' });
    } finally {
      engine.submitCoordinatedUpdate = originalSubmit;
    }
  });

  it('returns 422 when the workflow is already terminal', async () => {
    const engine = createEngine();
    const originalSubmit = engine.submitCoordinatedUpdate.bind(engine);

    try {
      engine.submitCoordinatedUpdate = async () => {
        throw new WorkflowTerminalError('workflow-123', 'completed');
      };

      const response = await handleRequest(
        request('POST', '/v1/workflows/workflow-123/update/rename', { payload: {} }),
        engine,
        { operationRegistry: registry, restBindings: bindings },
      );

      expect(response.status).toBe(422);
      expect(await response.json()).toEqual({
        error:
          'Cannot send update to workflow "workflow-123": workflow is in terminal state "completed"',
      });
    } finally {
      engine.submitCoordinatedUpdate = originalSubmit;
    }
  });

  it('returns 408 when the coordinated update times out', async () => {
    const engine = createEngine();
    const originalSubmit = engine.submitCoordinatedUpdate.bind(engine);

    try {
      engine.submitCoordinatedUpdate = async () => {
        throw new UpdateTimeoutError('update-123', 2_000);
      };

      const response = await handleRequest(
        request('POST', '/v1/workflows/workflow-123/update/rename', { payload: {} }),
        engine,
        { operationRegistry: registry, restBindings: bindings },
      );

      expect(response.status).toBe(408);
      expect((await response.json()) as { error: string }).toEqual(
        expect.objectContaining({
          error: expect.stringContaining('timed out'),
        }),
      );
    } finally {
      engine.submitCoordinatedUpdate = originalSubmit;
    }
  });

  it('returns the raw engine error message on unexpected failures', async () => {
    const engine = createEngine();
    const originalSubmit = engine.submitCoordinatedUpdate.bind(engine);

    try {
      engine.submitCoordinatedUpdate = async () => {
        throw new Error('update exploded');
      };

      const response = await handleRequest(
        request('POST', '/v1/workflows/workflow-123/update/rename', { payload: {} }),
        engine,
        { operationRegistry: registry, restBindings: bindings },
      );

      expect(response.status).toBe(500);
      expect(await response.json()).toEqual({ error: 'update exploded' });
    } finally {
      engine.submitCoordinatedUpdate = originalSubmit;
    }
  });
});
