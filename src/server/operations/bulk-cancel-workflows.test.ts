import { sleepForTesting } from '../../testing/fake-timers.ts';
/**
 * `weft.workflows.bulk.cancel` operation + REST binding — behavior tests.
 */

import { describe, expect, it } from 'bun:test';

import { Engine } from '../../core/engine.ts';
import type { WorkflowContext } from '../../core/types.ts';
import { MemoryStorage } from '../../storage/memory.ts';
import { handleRequest } from '../handler.ts';
import { createOperationRegistry } from '../operation-catalog.ts';
import type { OperationFault } from '../operation-fault.ts';
import {
  bulkCancelWorkflowsOperation,
  bulkCancelWorkflowsRestBinding,
} from './bulk-cancel-workflows.ts';

function createEngine(): Engine {
  const engine = new Engine({ storage: new MemoryStorage() });
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

function request(path: string, body?: unknown): Request {
  return new Request(`http://localhost${path}`, {
    method: 'POST',
    ...(body === undefined
      ? {}
      : {
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        }),
  });
}

const registry = createOperationRegistry([bulkCancelWorkflowsOperation]);
const bindings = [bulkCancelWorkflowsRestBinding];

describe('weft.workflows.bulk.cancel', () => {
  it('returns cancellation counts and cancels matching workflows', async () => {
    const engine = createEngine();

    await engine.start('waiting', undefined, {
      id: 'bulk-cancel-selected-a',
      tags: ['selected'],
    });
    await engine.start('waiting', undefined, {
      id: 'bulk-cancel-selected-b',
      tags: ['selected'],
    });
    await engine.start('waiting', undefined, {
      id: 'bulk-cancel-other',
      tags: ['other'],
    });

    await Promise.all([
      waitForStatus(engine, 'bulk-cancel-selected-a', 'running'),
      waitForStatus(engine, 'bulk-cancel-selected-b', 'running'),
      waitForStatus(engine, 'bulk-cancel-other', 'running'),
    ]);

    const response = await handleRequest(
      request('/v1/workflows/bulk/cancel', { filter: { tags: ['selected'] } }),
      engine,
      { operationRegistry: registry, restBindings: bindings },
    );

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('application/json');
    expect(await response.json()).toEqual({
      cancelled: 2,
      failed: 0,
      errors: [],
    });
    const firstCancelledState = await engine.get('bulk-cancel-selected-a');
    const secondCancelledState = await engine.get('bulk-cancel-selected-b');
    const untouchedState = await engine.get('bulk-cancel-other');
    expect(firstCancelledState?.status).toBe('cancelled');
    expect(secondCancelledState?.status).toBe('cancelled');
    expect(untouchedState?.status).toBe('running');

    await engine.cancel('bulk-cancel-other');
  });

  it('returns 400 when the bulk filter is unscoped', async () => {
    const engine = createEngine();

    const response = await handleRequest(request('/v1/workflows/bulk/cancel', {}), engine, {
      operationRegistry: registry,
      restBindings: bindings,
    });

    expect(response.status).toBe(400);
    expect(response.headers.get('content-type')).toBe('application/json');
    expect(await response.json()).toEqual({
      error: 'Field "filter" must include at least one of status, type, tags, or attributes',
    });
  });

  it('returns 400 for invalid filter bodies before dispatching', async () => {
    const engine = createEngine();

    const response = await handleRequest(
      request('/v1/workflows/bulk/cancel', {
        filter: {
          attributes: [{ key: '' }],
        },
      }),
      engine,
      { operationRegistry: registry, restBindings: bindings },
    );

    expect(response.status).toBe(400);
    expect(response.headers.get('content-type')).toBe('application/json');
    expect(await response.json()).toEqual({
      error: 'Field "filter.attributes[0].key" must be a non-empty string',
    });
  });

  it('maps EngineFailure faults to the legacy 500 response body', async () => {
    const engine = createEngine();
    const failingOperation = {
      ...bulkCancelWorkflowsOperation,
      invoke: async () => {
        const fault: OperationFault = {
          code: 'EngineFailure',
          message: 'cancel failed',
          data: {},
        };
        throw fault;
      },
    };
    const failingRegistry = createOperationRegistry([failingOperation]);

    const response = await handleRequest(
      request('/v1/workflows/bulk/cancel', { filter: { tags: ['selected'] } }),
      engine,
      {
        operationRegistry: failingRegistry,
        restBindings: bindings,
      },
    );

    expect(response.status).toBe(500);
    expect(response.headers.get('content-type')).toBe('application/json');
    expect(await response.json()).toEqual({ error: 'cancel failed' });
  });
});
