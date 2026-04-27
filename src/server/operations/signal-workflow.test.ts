import { describe, expect, it } from 'bun:test';

import type { Context } from '../../core/context.ts';
import { Engine } from '../../core/engine.ts';
import type { WorkflowContext } from '../../core/types.ts';
import { MemoryStorage } from '../../storage/memory.ts';
import { handleRequest } from '../handler.ts';
import { createOperationRegistry } from '../operation-catalog.ts';
import { signalWorkflowOperation, signalWorkflowRestBinding } from './signal-workflow.ts';

function createEngine(): Engine {
  const storage = new MemoryStorage();
  const engine = new Engine({ storage });
  engine.register('hold', async function* (ctx: WorkflowContext) {
    return yield* (ctx as Context).waitForSignal('release');
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

const registry = createOperationRegistry([signalWorkflowOperation]);
const bindings = [signalWorkflowRestBinding];

describe('weft.workflows.signal', () => {
  it('signals a workflow and returns the legacy ok response', async () => {
    const engine = createEngine();
    const handle = await engine.start('hold', null, { id: 'signal-success' });
    await waitForStatus(engine, handle.id, 'running');

    const response = await handleRequest(
      new Request(`http://localhost/v1/workflows/${handle.id}/signal/release`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ payload: { approved: true } }),
      }),
      engine,
      {
        operationRegistry: registry,
        restBindings: bindings,
      },
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
    expect(await handle.result()).toEqual({ approved: true });
  });

  it('tolerates an invalid or missing JSON body and treats the payload as optional', async () => {
    const engine = createEngine();
    const handle = await engine.start('hold', null, { id: 'signal-invalid-json' });
    await waitForStatus(engine, handle.id, 'running');

    const response = await handleRequest(
      new Request(`http://localhost/v1/workflows/${handle.id}/signal/release`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{',
      }),
      engine,
      {
        operationRegistry: registry,
        restBindings: bindings,
      },
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
    expect(await handle.result()).toBeUndefined();
  });

  it('returns 404 when the engine reports that the workflow was not found', async () => {
    const engine = createEngine();
    const originalSignal = engine.signal.bind(engine);
    engine.signal = async () => {
      throw new Error('Workflow not found');
    };

    try {
      const response = await handleRequest(
        request('POST', '/v1/workflows/missing/signal/release', { payload: 'hello' }),
        engine,
        {
          operationRegistry: registry,
          restBindings: bindings,
        },
      );

      expect(response.status).toBe(404);
      expect(await response.json()).toEqual({ error: 'Workflow not found' });
    } finally {
      engine.signal = originalSignal;
    }
  });

  it('returns the raw engine message for unexpected 500 failures', async () => {
    const engine = createEngine();
    const originalSignal = engine.signal.bind(engine);
    engine.signal = async () => {
      throw new Error('unexpected signal error');
    };

    try {
      const response = await handleRequest(
        request('POST', '/v1/workflows/wf-1/signal/release', { payload: 'hello' }),
        engine,
        {
          operationRegistry: registry,
          restBindings: bindings,
        },
      );

      expect(response.status).toBe(500);
      expect(await response.json()).toEqual({ error: 'unexpected signal error' });
    } finally {
      engine.signal = originalSignal;
    }
  });
});

function request(method: string, path: string, body?: unknown): Request {
  const init: RequestInit = { method };
  if (body !== undefined) {
    init.headers = { 'Content-Type': 'application/json' };
    init.body = JSON.stringify(body);
  }
  return new Request(`http://localhost${path}`, init);
}
