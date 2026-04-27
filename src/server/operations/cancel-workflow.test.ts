import { describe, expect, it } from 'bun:test';

import type { Context } from '../../core/context.ts';
import { Engine } from '../../core/engine.ts';
import type { WorkflowContext } from '../../core/types.ts';
import { MemoryStorage } from '../../storage/memory.ts';
import { handleRequest } from '../handler.ts';
import { createOperationRegistry } from '../operation-catalog.ts';
import { cancelWorkflowOperation, cancelWorkflowRestBinding } from './cancel-workflow.ts';

function createEngine(): Engine {
  const storage = new MemoryStorage();
  const engine = new Engine({ storage });
  engine.register('hold', async function* (ctx: WorkflowContext) {
    return yield* (ctx as Context).waitForSignal<string>('release');
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
    await Bun.sleep(5);
  }

  throw new Error(`Workflow ${workflowId} did not reach ${status} within ${timeoutMilliseconds}ms`);
}

const registry = createOperationRegistry([cancelWorkflowOperation]);
const bindings = [cancelWorkflowRestBinding];

describe('weft.workflows.cancel', () => {
  it('cancels a workflow and returns 204', async () => {
    const engine = createEngine();
    const handle = await engine.start('hold', null, { id: 'cancel-success' });
    await waitForStatus(engine, handle.id, 'running');

    const resultPromise = handle.result().catch(() => undefined);
    const response = await handleRequest(
      new Request(`http://localhost/v1/workflows/${handle.id}`, { method: 'DELETE' }),
      engine,
      {
        operationRegistry: registry,
        restBindings: bindings,
      },
    );

    expect(response.status).toBe(204);
    await resultPromise;
    await waitForStatus(engine, handle.id, 'cancelled');
  });

  it('returns 404 when the engine reports that the workflow was not found', async () => {
    const engine = createEngine();
    const originalCancel = engine.cancel.bind(engine);
    engine.cancel = async () => {
      throw new Error('workflow not found');
    };

    try {
      const response = await handleRequest(
        new Request('http://localhost/v1/workflows/missing', { method: 'DELETE' }),
        engine,
        {
          operationRegistry: registry,
          restBindings: bindings,
        },
      );

      expect(response.status).toBe(404);
      expect(await response.json()).toEqual({ error: 'workflow not found' });
    } finally {
      engine.cancel = originalCancel;
    }
  });

  it('returns the raw engine message for unexpected 500 failures', async () => {
    const engine = createEngine();
    const originalCancel = engine.cancel.bind(engine);
    engine.cancel = async () => {
      throw new Error('cancel failed internally');
    };

    try {
      const response = await handleRequest(
        new Request('http://localhost/v1/workflows/wf-1', { method: 'DELETE' }),
        engine,
        {
          operationRegistry: registry,
          restBindings: bindings,
        },
      );

      expect(response.status).toBe(500);
      expect(await response.json()).toEqual({ error: 'cancel failed internally' });
    } finally {
      engine.cancel = originalCancel;
    }
  });
});
