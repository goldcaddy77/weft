import { sleepForTesting } from '../../testing/fake-timers.ts';
/**
 * `weft.workflows.bulk.signal` operation + REST binding — behavior tests.
 */

import { describe, expect, it } from 'bun:test';

import type { Context } from '../../core/context.ts';
import { Engine } from '../../core/engine.ts';
import type { WorkflowContext } from '../../core/types.ts';
import { MemoryStorage } from '../../storage/memory.ts';
import { handleRequest } from '../handler.ts';
import { createOperationRegistry } from '../operation-catalog.ts';
import type { OperationFault } from '../operation-fault.ts';
import {
  bulkSignalWorkflowsOperation,
  bulkSignalWorkflowsRestBinding,
} from './bulk-signal-workflows.ts';

function createEngine(): Engine {
  const engine = new Engine({ storage: new MemoryStorage() });
  engine.register('waiting', async function* (ctx: WorkflowContext, input: unknown) {
    const payload = yield* (ctx as Context).waitForSignal<string>('continue');
    return `${String(input)}:${payload}`;
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
  return new Request('http://localhost/v1/workflows/bulk/signal', {
    method: 'POST',
    ...(body === undefined
      ? {}
      : {
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        }),
  });
}

const registry = createOperationRegistry([bulkSignalWorkflowsOperation]);
const bindings = [bulkSignalWorkflowsRestBinding];

describe('weft.workflows.bulk.signal', () => {
  it('returns signal counts and signals matching workflows', async () => {
    const engine = createEngine();

    const firstHandle = await engine.start('waiting', 'first', {
      id: 'bulk-signal-selected-a',
      tags: ['selected'],
    });
    const secondHandle = await engine.start('waiting', 'second', {
      id: 'bulk-signal-selected-b',
      tags: ['selected'],
    });
    const otherHandle = await engine.start('waiting', 'other', {
      id: 'bulk-signal-other',
      tags: ['other'],
    });

    await Promise.all([
      waitForStatus(engine, firstHandle.id, 'running'),
      waitForStatus(engine, secondHandle.id, 'running'),
      waitForStatus(engine, otherHandle.id, 'running'),
    ]);

    const response = await handleRequest(
      request({
        filter: { tags: ['selected'] },
        name: 'continue',
        payload: 'released',
      }),
      engine,
      { operationRegistry: registry, restBindings: bindings },
    );

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('application/json');
    expect(await response.json()).toEqual({ signalled: 2, failed: 0 });
    await expect(firstHandle.result()).resolves.toBe('first:released');
    await expect(secondHandle.result()).resolves.toBe('second:released');
    const untouchedState = await engine.get(otherHandle.id);
    expect(untouchedState?.status).toBe('running');

    await engine.signal(otherHandle.id, 'continue', 'cleanup');
    await otherHandle.result();
  });

  it('returns 400 when the request body is not a JSON object', async () => {
    const engine = createEngine();

    const response = await handleRequest(request(['not-an-object']), engine, {
      operationRegistry: registry,
      restBindings: bindings,
    });

    expect(response.status).toBe(400);
    expect(response.headers.get('content-type')).toBe('application/json');
    expect(await response.json()).toEqual({ error: 'Request body must be a JSON object' });
  });

  it('returns 400 for missing required fields and unscoped filters', async () => {
    const engine = createEngine();

    let response = await handleRequest(request({ filter: {}, name: 'continue' }), engine, {
      operationRegistry: registry,
      restBindings: bindings,
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: 'Field "filter" must include at least one of status, type, tags, or attributes',
    });

    response = await handleRequest(
      request({
        filter: { tags: ['selected'] },
        name: '',
      }),
      engine,
      {
        operationRegistry: registry,
        restBindings: bindings,
      },
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: 'Field "name" must be a non-empty string',
    });
  });

  it('maps EngineFailure faults to the legacy 500 response body', async () => {
    const engine = createEngine();
    const failingOperation = {
      ...bulkSignalWorkflowsOperation,
      invoke: async () => {
        const fault: OperationFault = {
          code: 'EngineFailure',
          message: 'signal failed',
          data: {},
        };
        throw fault;
      },
    };
    const failingRegistry = createOperationRegistry([failingOperation]);

    const response = await handleRequest(
      request({
        filter: { tags: ['selected'] },
        name: 'continue',
      }),
      engine,
      {
        operationRegistry: failingRegistry,
        restBindings: bindings,
      },
    );

    expect(response.status).toBe(500);
    expect(response.headers.get('content-type')).toBe('application/json');
    expect(await response.json()).toEqual({ error: 'signal failed' });
  });
});
