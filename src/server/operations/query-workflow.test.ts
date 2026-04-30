import { sleepForTesting } from '../../testing/fake-timers.ts';
/**
 * `weft.workflows.query` operation + REST binding — behavior tests.
 */

import { describe, expect, it } from 'bun:test';

import type { Context } from '../../core/context.ts';
import { Engine } from '../../core/engine.ts';
import type { WorkflowContext } from '../../core/types.ts';
import { MemoryStorage } from '../../storage/memory.ts';
import { handleRequest } from '../handler.ts';
import { createOperationRegistry } from '../operation-catalog.ts';
import type { OperationFault } from '../operation-fault.ts';
import { queryWorkflowOperation, queryWorkflowRestBinding } from './query-workflow.ts';

function createEngine(): Engine {
  const storage = new MemoryStorage();
  const engine = new Engine({ storage });
  engine.register('queryable', async function* (ctx: WorkflowContext) {
    const context = ctx as Context;
    context.expose({ counter: () => 42 });
    yield* context.waitForSignal('done');
    return 42;
  });
  return engine;
}

async function waitForStatus(
  engine: Engine,
  workflowId: string,
  status: 'running' | 'completed' | 'failed' | 'cancelled' | 'timed-out',
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

const registry = createOperationRegistry([queryWorkflowOperation]);
const bindings = [queryWorkflowRestBinding];

describe('weft.workflows.query', () => {
  it('returns the query result on the happy path', async () => {
    const engine = createEngine();
    const handle = await engine.start('queryable', null, { id: 'query-workflow-success' });
    await waitForStatus(engine, handle.id, 'running');

    const response = await handleRequest(
      new Request(`http://localhost/v1/workflows/${handle.id}/query/counter`, {
        method: 'GET',
      }),
      engine,
      {
        operationRegistry: registry,
        restBindings: bindings,
      },
    );

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('application/json');
    expect(await response.json()).toEqual({ result: 42 });
  });

  it('returns 501 with the legacy error body when queries are not supported', async () => {
    const engine = createEngine();
    const originalQuery = engine.query.bind(engine);
    engine.query = async () => {
      throw new Error('query not supported for this workflow');
    };

    try {
      const response = await handleRequest(
        new Request('http://localhost/v1/workflows/wf-query/query/counter', { method: 'GET' }),
        engine,
        {
          operationRegistry: registry,
          restBindings: bindings,
        },
      );

      expect(response.status).toBe(501);
      expect(response.headers.get('content-type')).toBe('application/json');
      expect(await response.json()).toEqual({
        error: 'query not supported for this workflow',
      });
    } finally {
      engine.query = originalQuery;
    }
  });

  it('returns null when the query accessor does not exist', async () => {
    const engine = createEngine();
    const handle = await engine.start('queryable', null, { id: 'query-workflow-null' });
    await waitForStatus(engine, handle.id, 'running');

    const response = await handleRequest(
      new Request(`http://localhost/v1/workflows/${handle.id}/query/missing`, {
        method: 'GET',
      }),
      engine,
      {
        operationRegistry: registry,
        restBindings: bindings,
      },
    );

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('application/json');
    expect(await response.json()).toEqual({ result: null });
  });

  it('maps EngineFailure faults to the legacy 500 response body', async () => {
    const engine = createEngine();
    const failingOperation = {
      ...queryWorkflowOperation,
      invoke: async () => {
        const fault: OperationFault = {
          code: 'EngineFailure',
          message: 'secret internal detail',
          data: {},
        };
        throw fault;
      },
    };
    const failingRegistry = createOperationRegistry([failingOperation]);

    const response = await handleRequest(
      new Request('http://localhost/v1/workflows/whatever/query/counter', { method: 'GET' }),
      engine,
      {
        operationRegistry: failingRegistry,
        restBindings: bindings,
      },
    );

    // Legacy `handleQueryWorkflow` echoed the raw engine error
    // string into the 500 body via `errorResponse(message, 500)`.
    // The migrated path preserves that byte-for-byte. Sanitizing
    // internal errors is a deliberate behavior shift that lands in
    // a follow-up PR.
    expect(response.status).toBe(500);
    expect(response.headers.get('content-type')).toBe('application/json');
    expect(await response.json()).toEqual({ error: 'secret internal detail' });
  });
});
