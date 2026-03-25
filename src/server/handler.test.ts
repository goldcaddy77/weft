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
});
