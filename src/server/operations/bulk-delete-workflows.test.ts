import { sleepForTesting } from '../../testing/fake-timers.ts';
/**
 * `weft.workflows.bulk.delete` operation + REST binding — behavior tests.
 */

import { describe, expect, it } from 'bun:test';

import { Engine } from '../../core/engine.ts';
import type { WorkflowContext } from '../../core/types.ts';
import { MemoryStorage } from '../../storage/memory.ts';
import { handleRequest } from '../handler.ts';
import { createOperationRegistry } from '../operation-catalog.ts';
import type { OperationFault } from '../operation-fault.ts';
import {
  bulkDeleteWorkflowsOperation,
  bulkDeleteWorkflowsRestBinding,
} from './bulk-delete-workflows.ts';

function createEngine(): Engine {
  const engine = new Engine({ storage: new MemoryStorage() });
  engine.register('echo', async function* (_ctx: WorkflowContext, input: unknown) {
    return input;
  });
  engine.register('waiting', async function* (ctx: WorkflowContext) {
    return yield* ctx.waitForSignal('release');
  });
  return engine;
}

async function waitForStatus(
  engine: Engine,
  workflowId: string,
  status: 'pending' | 'running' | 'completed' | 'failed' | 'cancelled' | 'timed-out',
  timeoutMilliseconds = 500,
): Promise<void> {
  const deadline = Date.now() + timeoutMilliseconds;
  while (Date.now() < deadline) {
    const state = await engine.get(workflowId);
    if (state?.status === status) {
      return;
    }
    await sleepForTesting(5);
  }

  throw new Error(`Workflow ${workflowId} did not reach ${status} within ${timeoutMilliseconds}ms`);
}

function request(body?: unknown): Request {
  return new Request('http://localhost/v1/workflows/bulk', {
    method: 'DELETE',
    ...(body === undefined
      ? {}
      : {
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        }),
  });
}

const registry = createOperationRegistry([bulkDeleteWorkflowsOperation]);
const bindings = [bulkDeleteWorkflowsRestBinding];

describe('weft.workflows.bulk.delete', () => {
  it('deletes matching terminal workflows', async () => {
    const engine = createEngine();

    const firstHandle = await engine.start('echo', 'first', {
      id: 'bulk-delete-selected-a',
      tags: ['selected'],
    });
    const secondHandle = await engine.start('echo', 'second', {
      id: 'bulk-delete-selected-b',
      tags: ['selected'],
    });
    await firstHandle.result();
    await secondHandle.result();

    const response = await handleRequest(request({ filter: { tags: ['selected'] } }), engine, {
      operationRegistry: registry,
      restBindings: bindings,
    });

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('application/json');
    expect(await response.json()).toEqual({ deleted: 2 });
    expect(await engine.get('bulk-delete-selected-a')).toBeNull();
    expect(await engine.get('bulk-delete-selected-b')).toBeNull();
  });

  it('returns 422 when the filter matches non-terminal workflows', async () => {
    const engine = createEngine();

    const completedHandle = await engine.start('echo', 'done', {
      id: 'bulk-delete-completed',
      tags: ['mixed'],
    });
    await completedHandle.result();

    await engine.start('waiting', undefined, {
      id: 'bulk-delete-running',
      tags: ['mixed'],
    });
    await waitForStatus(engine, 'bulk-delete-running', 'running');

    const response = await handleRequest(request({ filter: { tags: ['mixed'] } }), engine, {
      operationRegistry: registry,
      restBindings: bindings,
    });

    expect(response.status).toBe(422);
    expect(response.headers.get('content-type')).toBe('application/json');
    expect(await response.json()).toEqual({
      error: 'Bulk delete matches non-terminal workflows',
    });

    await engine.cancel('bulk-delete-running');
  });

  it('returns 400 when the bulk filter is unscoped', async () => {
    const engine = createEngine();

    const response = await handleRequest(request({ filter: {} }), engine, {
      operationRegistry: registry,
      restBindings: bindings,
    });

    expect(response.status).toBe(400);
    expect(response.headers.get('content-type')).toBe('application/json');
    expect(await response.json()).toEqual({
      error:
        'Field "filter" must include at least one of status, type, tags, attributes, tenantId, idPrefix (≥3 chars), or failureCategory paired with status',
    });
  });

  it('maps EngineFailure faults to the legacy 500 response body', async () => {
    const engine = createEngine();
    const failingOperation = {
      ...bulkDeleteWorkflowsOperation,
      invoke: async () => {
        const fault: OperationFault = {
          code: 'EngineFailure',
          message: 'delete failed',
          data: {},
        };
        throw fault;
      },
    };
    const failingRegistry = createOperationRegistry([failingOperation]);

    const response = await handleRequest(request({ filter: { tags: ['selected'] } }), engine, {
      operationRegistry: failingRegistry,
      restBindings: bindings,
    });

    expect(response.status).toBe(500);
    expect(response.headers.get('content-type')).toBe('application/json');
    expect(await response.json()).toEqual({ error: 'delete failed' });
  });
});
