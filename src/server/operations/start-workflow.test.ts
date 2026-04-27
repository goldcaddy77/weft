import { describe, expect, it } from 'bun:test';

import { Engine } from '../../core/engine.ts';
import { StartWorkflowValidationError } from '../../core/start-workflow-validation.ts';
import { QuotaExceededError } from '../../core/tenant-quotas.ts';
import type { WorkflowContext } from '../../core/types.ts';
import { MemoryStorage } from '../../storage/memory.ts';
import { handleRequest } from '../handler.ts';
import { createOperationRegistry } from '../operation-catalog.ts';
import { startWorkflowOperation, startWorkflowRestBinding } from './start-workflow.ts';

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

const registry = createOperationRegistry([startWorkflowOperation]);
const bindings = [startWorkflowRestBinding];

describe('weft.workflows.start', () => {
  it('returns 201 with the started workflow id on the happy path', async () => {
    const engine = createEngine();

    const response = await handleRequest(
      request('POST', '/v1/workflows', {
        type: 'echo',
        input: { hello: 'world' },
        id: 'start-workflow-success',
        startAfter: '1s',
        tags: ['alpha'],
      }),
      engine,
      { operationRegistry: registry, restBindings: bindings },
    );

    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({ id: 'start-workflow-success' });
  });

  it('returns 400 when the request body is invalid JSON', async () => {
    const engine = createEngine();

    const response = await handleRequest(invalidJsonRequest('POST', '/v1/workflows', '{'), engine, {
      operationRegistry: registry,
      restBindings: bindings,
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: 'Invalid JSON body' });
  });

  it('returns 400 when the request body is not a JSON object', async () => {
    const engine = createEngine();

    const response = await handleRequest(
      request('POST', '/v1/workflows', ['not-an-object']),
      engine,
      { operationRegistry: registry, restBindings: bindings },
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: 'Request body must be a JSON object' });
  });

  it('returns 400 when startAt and startAfter are both provided', async () => {
    const engine = createEngine();

    const response = await handleRequest(
      request('POST', '/v1/workflows', {
        type: 'echo',
        startAt: Date.now(),
        startAfter: '1s',
      }),
      engine,
      { operationRegistry: registry, restBindings: bindings },
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: 'Provide only one of startAt or startAfter' });
  });

  it('returns 400 when engine.start throws StartWorkflowValidationError', async () => {
    const engine = createEngine();
    const originalStart = engine.start.bind(engine);

    try {
      engine.start = async () => {
        throw new StartWorkflowValidationError('Field "id" must be a string');
      };

      const response = await handleRequest(
        request('POST', '/v1/workflows', { type: 'echo' }),
        engine,
        { operationRegistry: registry, restBindings: bindings },
      );

      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ error: 'Field "id" must be a string' });
    } finally {
      engine.start = originalStart;
    }
  });

  it('returns 429 when engine.start throws QuotaExceededError', async () => {
    const engine = createEngine();
    const originalStart = engine.start.bind(engine);

    try {
      engine.start = async () => {
        throw new QuotaExceededError({
          tenantId: 'acme',
          quota: 'maxConcurrentWorkflows',
          currentUsage: 2,
          limit: 1,
        });
      };

      const response = await handleRequest(
        request('POST', '/v1/workflows', { type: 'echo' }),
        engine,
        { operationRegistry: registry, restBindings: bindings },
      );

      expect(response.status).toBe(429);
      expect((await response.json()) as { error: string }).toEqual(
        expect.objectContaining({
          error: expect.stringContaining('Tenant quota exceeded'),
        }),
      );
    } finally {
      engine.start = originalStart;
    }
  });

  it('returns 400 when the workflow type is not registered', async () => {
    const engine = createEngine();

    const response = await handleRequest(
      request('POST', '/v1/workflows', { type: 'missing-workflow' }),
      engine,
      { operationRegistry: registry, restBindings: bindings },
    );

    expect(response.status).toBe(400);
    expect((await response.json()) as { error: string }).toEqual(
      expect.objectContaining({
        error: expect.stringContaining('No workflow registered'),
      }),
    );
  });

  it('returns 409 when the workflow id already exists', async () => {
    const engine = createEngine();

    const firstResponse = await handleRequest(
      request('POST', '/v1/workflows', { type: 'echo', id: 'duplicate-workflow-id' }),
      engine,
      { operationRegistry: registry, restBindings: bindings },
    );
    expect(firstResponse.status).toBe(201);

    const secondResponse = await handleRequest(
      request('POST', '/v1/workflows', { type: 'echo', id: 'duplicate-workflow-id' }),
      engine,
      { operationRegistry: registry, restBindings: bindings },
    );

    expect(secondResponse.status).toBe(409);
    expect((await secondResponse.json()) as { error: string }).toEqual(
      expect.objectContaining({
        error: expect.stringContaining('already exists'),
      }),
    );
  });

  it('returns the raw engine error message on unexpected failures', async () => {
    const engine = createEngine();
    const originalStart = engine.start.bind(engine);

    try {
      engine.start = async () => {
        throw new Error('unexpected engine error');
      };

      const response = await handleRequest(
        request('POST', '/v1/workflows', { type: 'echo' }),
        engine,
        { operationRegistry: registry, restBindings: bindings },
      );

      expect(response.status).toBe(500);
      expect(await response.json()).toEqual({ error: 'unexpected engine error' });
    } finally {
      engine.start = originalStart;
    }
  });
});
