import { afterEach, describe, expect, it } from 'bun:test';

import { decode } from '../../core/codec.ts';
import type { Context } from '../../core/context.ts';
import { Engine } from '../../core/engine.ts';
import type { WorkflowContext } from '../../core/types.ts';
import { MemoryStorage } from '../../storage/memory.ts';
import { handleRequest } from '../handler.ts';
import { createOperationRegistry } from '../operation-catalog.ts';
import type { OperationFault } from '../operation-fault.ts';
import { listCheckpointsOperation, listCheckpointsRestBinding } from './list-checkpoints.ts';

const noop = async () => null;

function createEngine(): Engine {
  const engine = new Engine({ storage: new MemoryStorage(), checkpointHistory: 10 });
  engine.register('steps-then-wait', async function* (ctx: WorkflowContext) {
    yield* (ctx as Context).run(noop);
    yield* (ctx as Context).run(noop);
    yield* (ctx as Context).waitForSignal('release');
    return 'done';
  });
  return engine;
}

async function waitForWorkflowStatus(
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
    await Bun.sleep(5);
  }
  throw new Error(`Workflow ${workflowId} did not reach ${status} within ${timeoutMilliseconds}ms`);
}

const registry = createOperationRegistry([listCheckpointsOperation]);

describe('weft.workflows.checkpoints.list', () => {
  let engine: Engine | undefined;

  afterEach(() => {
    engine?.[Symbol.dispose]();
  });

  it('returns checkpoint summaries on the happy path', async () => {
    engine = createEngine();
    const handle = await engine.start('steps-then-wait', null, { id: 'wf-list-checkpoints' });
    await waitForWorkflowStatus(engine, handle.id, 'running');
    const expected = await engine.listCheckpoints(handle.id);

    const response = await handleRequest(
      new Request(`http://localhost/v1/workflows/${handle.id}/checkpoints`, { method: 'GET' }),
      engine,
      {
        operationRegistry: registry,
        restBindings: [listCheckpointsRestBinding],
      },
    );

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('application/json');
    expect(await response.json()).toEqual(expected);
  });

  it('returns msgpack when the Accept header requests it', async () => {
    engine = createEngine();
    const handle = await engine.start('steps-then-wait', null, {
      id: 'wf-list-checkpoints-msgpack',
    });
    await waitForWorkflowStatus(engine, handle.id, 'running');
    const expected = await engine.listCheckpoints(handle.id);

    const response = await handleRequest(
      new Request(`http://localhost/v1/workflows/${handle.id}/checkpoints`, {
        method: 'GET',
        headers: { Accept: 'application/msgpack' },
      }),
      engine,
      {
        operationRegistry: registry,
        restBindings: [listCheckpointsRestBinding],
      },
    );

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('application/msgpack');
    const decoded = decode(new Uint8Array(await response.arrayBuffer()));
    expect(decoded).toEqual(expected);
  });

  it('maps EngineFailure faults to the legacy 500 response body', async () => {
    engine = createEngine();

    const failingOperation = {
      ...listCheckpointsOperation,
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
      new Request('http://localhost/v1/workflows/wf-list-checkpoints/checkpoints', {
        method: 'GET',
      }),
      engine,
      {
        operationRegistry: createOperationRegistry([failingOperation]),
        restBindings: [listCheckpointsRestBinding],
      },
    );

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: 'Internal server error' });
  });
});
