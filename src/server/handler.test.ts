import { afterEach, describe, expect, it } from 'bun:test';

import { Engine } from '../core/engine.ts';
import type { WorkflowContext } from '../core/types.ts';
import { MemoryStorage } from '../storage/memory.ts';
import { handleRequest } from './handler.ts';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Drain microtasks so fire-and-forget work completes. */
async function flush(): Promise<void> {
  await Bun.sleep(10);
}

function createEngine(): Engine {
  const storage = new MemoryStorage();
  const engine = new Engine({ storage });

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

async function json(response: Response): Promise<unknown> {
  return response.json();
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('handleRequest', () => {
  let engine: Engine;

  afterEach(() => {
    engine[Symbol.dispose]();
  });

  // 1. Health check
  it('GET /v1/health returns 200 with status ok', async () => {
    engine = createEngine();
    const response = await handleRequest(request('GET', '/v1/health'), engine);

    expect(response.status).toBe(200);
    expect(await json(response)).toEqual({ status: 'ok' });
  });

  // 2. Start workflow with valid body
  it('POST /v1/workflows with valid body returns 201 with id', async () => {
    engine = createEngine();
    const response = await handleRequest(
      request('POST', '/v1/workflows', { type: 'echo', input: 'hello' }),
      engine,
    );

    expect(response.status).toBe(201);
    const body = (await json(response)) as { id: string };
    expect(typeof body.id).toBe('string');
    expect(body.id.length).toBeGreaterThan(0);
  });

  // 3. Start workflow with missing type returns 400
  it('POST /v1/workflows with missing type returns 400', async () => {
    engine = createEngine();
    const response = await handleRequest(
      request('POST', '/v1/workflows', { input: 'hello' }),
      engine,
    );

    expect(response.status).toBe(400);
    const body = (await json(response)) as { error: string };
    expect(body.error).toBeDefined();
  });

  // 4. Get workflow state
  it('GET /v1/workflows/:id returns workflow state', async () => {
    engine = createEngine();

    // Start a workflow first
    const startResponse = await handleRequest(
      request('POST', '/v1/workflows', { type: 'echo', input: 42 }),
      engine,
    );
    const { id } = (await json(startResponse)) as { id: string };
    await flush();

    const response = await handleRequest(request('GET', `/v1/workflows/${id}`), engine);

    expect(response.status).toBe(200);
    const body = (await json(response)) as { id: string; type: string; status: string };
    expect(body.id).toBe(id);
    expect(body.type).toBe('echo');
    expect(body.status).toBe('completed');
  });

  // 5. Get workflow with unknown id returns 404
  it('GET /v1/workflows/:id with unknown id returns 404', async () => {
    engine = createEngine();
    const response = await handleRequest(request('GET', '/v1/workflows/nonexistent-id'), engine);

    expect(response.status).toBe(404);
  });

  // 6. Cancel workflow returns 204
  it('DELETE /v1/workflows/:id returns 204', async () => {
    engine = createEngine();

    // Start a workflow
    const startResponse = await handleRequest(
      request('POST', '/v1/workflows', { type: 'echo', input: 'data' }),
      engine,
    );
    const { id } = (await json(startResponse)) as { id: string };

    const response = await handleRequest(request('DELETE', `/v1/workflows/${id}`), engine);

    expect(response.status).toBe(204);
  });

  // 7. Signal workflow returns 200
  it('POST /v1/workflows/:id/signal/:name returns 200', async () => {
    engine = createEngine();

    // Start a workflow
    const startResponse = await handleRequest(
      request('POST', '/v1/workflows', { type: 'echo', input: 'data' }),
      engine,
    );
    const { id } = (await json(startResponse)) as { id: string };

    const response = await handleRequest(
      request('POST', `/v1/workflows/${id}/signal/my-signal`, { payload: 'signal-data' }),
      engine,
    );

    expect(response.status).toBe(200);
  });

  // 8. List workflows
  it('GET /v1/workflows returns list of workflows', async () => {
    engine = createEngine();

    // Start two workflows
    await handleRequest(request('POST', '/v1/workflows', { type: 'echo', input: 1 }), engine);
    await handleRequest(request('POST', '/v1/workflows', { type: 'echo', input: 2 }), engine);
    await flush();

    const response = await handleRequest(request('GET', '/v1/workflows'), engine);

    expect(response.status).toBe(200);
    const body = (await json(response)) as { items: unknown[]; total: number };
    expect(body.items.length).toBe(2);
    expect(body.total).toBe(2);
  });

  // 9. List workflows with status filter
  it('GET /v1/workflows?status=running filters by status', async () => {
    engine = createEngine();

    // Start a workflow that completes immediately
    await handleRequest(request('POST', '/v1/workflows', { type: 'echo', input: 1 }), engine);
    await flush();

    const response = await handleRequest(request('GET', '/v1/workflows?status=running'), engine);

    expect(response.status).toBe(200);
    const body = (await json(response)) as { items: unknown[]; total: number };
    // The echo workflow completes immediately, so no running workflows
    expect(body.items.length).toBe(0);
    expect(body.total).toBe(0);
  });

  // 10. Unknown route returns 404
  it('unknown route returns 404', async () => {
    engine = createEngine();
    const response = await handleRequest(request('GET', '/v1/unknown'), engine);

    expect(response.status).toBe(404);
    const body = (await json(response)) as { error: string };
    expect(body.error).toBeDefined();
  });

  // 11. Start workflow with custom id
  it('POST /v1/workflows with custom id uses that id', async () => {
    engine = createEngine();
    const customId = 'my-custom-workflow-id';

    const response = await handleRequest(
      request('POST', '/v1/workflows', { type: 'echo', input: 'data', id: customId }),
      engine,
    );

    expect(response.status).toBe(201);
    const body = (await json(response)) as { id: string };
    expect(body.id).toBe(customId);
  });

  // 12. Start workflow with executionTimeout passes it through
  it('POST /v1/workflows with executionTimeout passes it through', async () => {
    engine = createEngine();

    const response = await handleRequest(
      request('POST', '/v1/workflows', {
        type: 'echo',
        input: 'data',
        executionTimeout: 30000,
      }),
      engine,
    );

    expect(response.status).toBe(201);
    const { id } = (await json(response)) as { id: string };
    await flush();

    // Verify the workflow was created (state check)
    const stateResponse = await handleRequest(request('GET', `/v1/workflows/${id}`), engine);
    expect(stateResponse.status).toBe(200);
    const state = (await json(stateResponse)) as { executionDeadline?: number };
    expect(state.executionDeadline).toBeDefined();
  });

  // Additional edge cases
  it('POST /v1/workflows with invalid JSON returns 400', async () => {
    engine = createEngine();
    const response = await handleRequest(
      new Request('http://localhost/v1/workflows', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: 'not valid json{',
      }),
      engine,
    );

    expect(response.status).toBe(400);
  });

  it('GET /v1/workflows with limit and offset paginates results', async () => {
    engine = createEngine();

    // Start three workflows
    await handleRequest(request('POST', '/v1/workflows', { type: 'echo', input: 1 }), engine);
    await handleRequest(request('POST', '/v1/workflows', { type: 'echo', input: 2 }), engine);
    await handleRequest(request('POST', '/v1/workflows', { type: 'echo', input: 3 }), engine);
    await flush();

    const response = await handleRequest(request('GET', '/v1/workflows?limit=2&offset=1'), engine);

    expect(response.status).toBe(200);
    const body = (await json(response)) as {
      items: unknown[];
      total: number;
      offset: number;
      limit: number;
    };
    expect(body.items.length).toBe(2);
    expect(body.total).toBe(3);
    expect(body.offset).toBe(1);
    expect(body.limit).toBe(2);
  });

  it('GET /v1/workflows?type=echo filters by type', async () => {
    engine = createEngine();

    await handleRequest(request('POST', '/v1/workflows', { type: 'echo', input: 1 }), engine);
    await flush();

    const response = await handleRequest(request('GET', '/v1/workflows?type=echo'), engine);

    expect(response.status).toBe(200);
    const body = (await json(response)) as { items: unknown[]; total: number };
    expect(body.items.length).toBe(1);

    // Filter for a type that does not exist
    const emptyResponse = await handleRequest(
      request('GET', '/v1/workflows?type=nonexistent'),
      engine,
    );

    expect(emptyResponse.status).toBe(200);
    const emptyBody = (await json(emptyResponse)) as { items: unknown[]; total: number };
    expect(emptyBody.items.length).toBe(0);
  });

  it('POST /v1/workflows with unregistered type returns 400', async () => {
    engine = createEngine();

    const response = await handleRequest(
      request('POST', '/v1/workflows', { type: 'nonexistent', input: 'data' }),
      engine,
    );

    expect(response.status).toBe(400);
  });

  it('GET /v1/workflows/:id/result returns result for completed workflow', async () => {
    engine = createEngine();

    const startResponse = await handleRequest(
      request('POST', '/v1/workflows', { type: 'echo', input: 'hello' }),
      engine,
    );
    const { id } = (await json(startResponse)) as { id: string };
    await flush();

    const response = await handleRequest(request('GET', `/v1/workflows/${id}/result`), engine);

    expect(response.status).toBe(200);
    const body = (await json(response)) as { result: unknown };
    expect(body.result).toBe('hello');
  });

  // --- Additional coverage tests ---

  it('POST /v1/workflows with null body returns 400', async () => {
    engine = createEngine();
    const response = await handleRequest(
      new Request('http://localhost/v1/workflows', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(null),
      }),
      engine,
    );

    expect(response.status).toBe(400);
    const body = (await json(response)) as { error: string };
    expect(body.error).toContain('JSON object');
  });

  it('POST /v1/workflows with empty string type returns 400', async () => {
    engine = createEngine();
    const response = await handleRequest(
      request('POST', '/v1/workflows', { type: '', input: 'data' }),
      engine,
    );

    expect(response.status).toBe(400);
    const body = (await json(response)) as { error: string };
    expect(body.error).toContain('type');
  });

  it('POST /v1/workflows with duplicate id returns 409', async () => {
    engine = createEngine();

    const firstResponse = await handleRequest(
      request('POST', '/v1/workflows', { type: 'echo', input: 'first', id: 'dup-id' }),
      engine,
    );
    expect(firstResponse.status).toBe(201);

    const secondResponse = await handleRequest(
      request('POST', '/v1/workflows', { type: 'echo', input: 'second', id: 'dup-id' }),
      engine,
    );
    expect(secondResponse.status).toBe(409);
    const body = (await json(secondResponse)) as { error: string };
    expect(body.error).toContain('already exists');
  });

  it('POST /v1/workflows with engine.start error returns 500', async () => {
    engine = createEngine();

    // Register a workflow that throws a generic (non-matching) error on start
    engine.register('error-on-start', async function* () {
      throw new Error('some internal error');
    });

    // The 500 path is for errors that don't match "No workflow registered" or "already exists".
    // We can trigger it by making the engine throw something unexpected.
    // Actually, the start itself may succeed (it returns a handle) and the error happens later.
    // Let's test by overriding engine.start to throw.
    const originalStart = engine.start.bind(engine);
    engine.start = async () => {
      throw new Error('unexpected engine error');
    };

    const response = await handleRequest(
      request('POST', '/v1/workflows', { type: 'echo', input: 'data' }),
      engine,
    );

    expect(response.status).toBe(500);
    const body = (await json(response)) as { error: string };
    expect(body.error).toContain('unexpected engine error');

    // Restore original
    engine.start = originalStart;
  });

  it('POST /v1/workflows/nonexistent/signal/test signals non-existent workflow', async () => {
    engine = createEngine();

    // Signal a workflow that doesn't exist. The engine.signal doesn't throw for
    // non-existent workflows (it just writes to storage), so this should still
    // succeed with 200.
    const response = await handleRequest(
      request('POST', '/v1/workflows/nonexistent-wf/signal/test-signal', {
        payload: 'test-data',
      }),
      engine,
    );

    // engine.signal doesn't throw for non-existent workflows
    expect(response.status).toBe(200);
  });

  it('POST /v1/workflows/:id/signal/:name with invalid JSON body still works', async () => {
    engine = createEngine();

    const startResponse = await handleRequest(
      request('POST', '/v1/workflows', { type: 'echo', input: 'data' }),
      engine,
    );
    const { id } = (await json(startResponse)) as { id: string };

    // Send signal with no body (empty)
    const response = await handleRequest(
      new Request(`http://localhost/v1/workflows/${id}/signal/my-signal`, {
        method: 'POST',
      }),
      engine,
    );

    expect(response.status).toBe(200);
  });

  it('DELETE /v1/workflows/:id returns 500 when cancel throws', async () => {
    engine = createEngine();

    const originalCancel = engine.cancel.bind(engine);
    engine.cancel = async () => {
      throw new Error('cancel failed internally');
    };

    const response = await handleRequest(request('DELETE', '/v1/workflows/some-id'), engine);

    expect(response.status).toBe(500);
    const body = (await json(response)) as { error: string };
    expect(body.error).toContain('cancel failed internally');

    engine.cancel = originalCancel;
  });

  it('POST /v1/workflows/:id/signal/:name returns 404 when signal throws not found', async () => {
    engine = createEngine();

    const originalSignal = engine.signal.bind(engine);
    engine.signal = async () => {
      throw new Error('Workflow not found');
    };

    const response = await handleRequest(
      request('POST', '/v1/workflows/missing-wf/signal/test', { payload: 'data' }),
      engine,
    );

    expect(response.status).toBe(404);
    const body = (await json(response)) as { error: string };
    expect(body.error).toContain('not found');

    engine.signal = originalSignal;
  });

  it('POST /v1/workflows/:id/signal/:name returns 500 on unexpected signal error', async () => {
    engine = createEngine();

    const originalSignal = engine.signal.bind(engine);
    engine.signal = async () => {
      throw new Error('unexpected signal error');
    };

    const response = await handleRequest(
      request('POST', '/v1/workflows/wf/signal/test', { payload: 'data' }),
      engine,
    );

    expect(response.status).toBe(500);
    const body = (await json(response)) as { error: string };
    expect(body.error).toContain('unexpected signal error');

    engine.signal = originalSignal;
  });

  it('GET /v1/workflows/:id/result returns 404 for non-existent workflow', async () => {
    engine = createEngine();

    const response = await handleRequest(
      request('GET', '/v1/workflows/nonexistent/result'),
      engine,
    );

    expect(response.status).toBe(404);
  });

  it('GET /v1/workflows/:id/result returns 422 for failed workflow', async () => {
    const storage = new MemoryStorage();
    engine = new Engine({ storage });

    engine.register('echo', async function* (_ctx: WorkflowContext, input: unknown) {
      return input;
    });

    engine.register('failing', async function* () {
      throw new Error('workflow failed');
    });

    const handle = await engine.start('failing', null);
    // Wait for the failure to be recorded
    await handle.result().catch(() => {});
    await flush();

    const response = await handleRequest(
      request('GET', `/v1/workflows/${handle.id}/result`),
      engine,
    );

    expect(response.status).toBe(422);
    const body = (await json(response)) as { error: string };
    expect(body.error).toContain('failed');
  });

  it('GET /v1/workflows/:id/result returns 422 with default message for failed workflow with no error', async () => {
    const storage = new MemoryStorage();
    engine = new Engine({ storage });

    engine.register('echo', async function* (_ctx: WorkflowContext, input: unknown) {
      return input;
    });

    engine.register('failing-no-msg', async function* () {
      throw new Error('deliberate');
    });

    const handle = await engine.start('failing-no-msg', null);
    await handle.result().catch(() => {});
    await flush();

    // Manually update the stored state to remove the error field
    const { encode } = await import('../core/codec.ts');
    const { KEYS } = await import('../storage/interface.ts');
    const bytes = await storage.get(KEYS.workflow(handle.id));
    const { decode } = await import('../core/codec.ts');
    const state = decode(bytes!) as any;
    delete state.error;
    await storage.put(KEYS.workflow(handle.id), encode(state));

    const response = await handleRequest(
      request('GET', `/v1/workflows/${handle.id}/result`),
      engine,
    );

    expect(response.status).toBe(422);
    const body = (await json(response)) as { error: string };
    expect(body.error).toBe('Workflow failed');
  });

  it('GET /v1/workflows/:id/result returns 422 for cancelled workflow', async () => {
    const storage = new MemoryStorage();
    engine = new Engine({ storage });

    engine.register('echo', async function* (_ctx: WorkflowContext, input: unknown) {
      return input;
    });

    engine.register('cancellable', async function* (ctx: WorkflowContext) {
      yield* (ctx as import('../core/context.ts').Context).waitForSignal('never');
      return 'nope';
    });

    const handle = await engine.start('cancellable', null);
    const resultPromise = handle.result().catch(() => {});
    await flush();

    await engine.cancel(handle.id);
    await resultPromise;
    await flush();

    const response = await handleRequest(
      request('GET', `/v1/workflows/${handle.id}/result`),
      engine,
    );

    expect(response.status).toBe(422);
    const body = (await json(response)) as { error: string };
    expect(body.error).toContain('cancelled');
  });

  it('GET /v1/workflows/:id/result returns 408 when running workflow times out', async () => {
    engine = createEngine();

    engine.register(
      'long-running',
      async function* (ctx: import('../core/types.ts').WorkflowContext) {
        yield* (ctx as import('../core/context.ts').Context).waitForSignal('never-arrives');
        return 'done';
      },
    );

    const startResponse = await handleRequest(
      request('POST', '/v1/workflows', { type: 'long-running', input: null }),
      engine,
    );
    const { id } = (await json(startResponse)) as { id: string };
    await flush();

    // Monkey-patch the getHandle to return a handle whose result never resolves
    const originalGetHandle = engine.getHandle.bind(engine);
    engine.getHandle = (workflowId: string) => {
      const handle = originalGetHandle(workflowId);
      const originalResult = handle.result.bind(handle);
      handle.result = () => new Promise(() => {}); // never resolves
      return handle;
    };

    // Use a short timeout by intercepting the handler's Promise.race timeout
    // The handler uses a 30s timeout; we need to make it testable.
    // Instead, let's test the timeout path by making handle.result() reject with Timeout
    engine.getHandle = (workflowId: string) => {
      const handle = originalGetHandle(workflowId);
      handle.result = async () => {
        throw new Error('Timeout waiting for workflow result');
      };
      return handle;
    };

    const response = await handleRequest(request('GET', `/v1/workflows/${id}/result`), engine);

    expect(response.status).toBe(408);
    const body = (await json(response)) as { error: string };
    expect(body.error).toContain('Timeout');

    engine.getHandle = originalGetHandle;
  });

  it('GET /v1/workflows/:id/result returns 500 when running workflow result rejects', async () => {
    engine = createEngine();

    engine.register('erroring', async function* (ctx: import('../core/types.ts').WorkflowContext) {
      yield* (ctx as import('../core/context.ts').Context).waitForSignal('never');
      return 'done';
    });

    const startResponse = await handleRequest(
      request('POST', '/v1/workflows', { type: 'erroring', input: null }),
      engine,
    );
    const { id } = (await json(startResponse)) as { id: string };
    await flush();

    const originalGetHandle = engine.getHandle.bind(engine);
    engine.getHandle = (workflowId: string) => {
      const handle = originalGetHandle(workflowId);
      handle.result = async () => {
        throw new Error('some unexpected error');
      };
      return handle;
    };

    const response = await handleRequest(request('GET', `/v1/workflows/${id}/result`), engine);

    expect(response.status).toBe(500);
    const body = (await json(response)) as { error: string };
    expect(body.error).toContain('some unexpected error');

    engine.getHandle = originalGetHandle;
  });
});
