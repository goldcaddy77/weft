import { describe, expect, it } from 'bun:test';

import { Engine } from '../../core/engine.ts';
import type { WorkflowContext } from '../../core/types.ts';
import { MemoryStorage } from '../../storage/memory.ts';
import { handleRequest } from '../handler.ts';
import { createOperationRegistry } from '../operation-catalog.ts';
import { forkWorkflowOperation, forkWorkflowRestBinding } from './fork-workflow.ts';

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

const registry = createOperationRegistry([forkWorkflowOperation]);
const bindings = [forkWorkflowRestBinding];

describe('weft.workflows.fork', () => {
  it('returns 201 with the forked workflow id on the happy path', async () => {
    const engine = createEngine();
    const originalFork = engine.fork.bind(engine);

    try {
      engine.fork = async (workflowId, options) => {
        expect(workflowId).toBe('workflow-123');
        expect(options).toEqual({ fromStep: 3 });
        return { id: 'forked-workflow' } as Awaited<ReturnType<Engine['fork']>>;
      };

      const response = await handleRequest(
        request('POST', '/v1/workflows/workflow-123/fork', { fromStep: 3 }),
        engine,
        { operationRegistry: registry, restBindings: bindings },
      );

      expect(response.status).toBe(201);
      expect(await response.json()).toEqual({ id: 'forked-workflow' });
    } finally {
      engine.fork = originalFork;
    }
  });

  it('returns 400 when the request body is invalid JSON', async () => {
    const engine = createEngine();

    const response = await handleRequest(
      invalidJsonRequest('POST', '/v1/workflows/workflow-123/fork', '{'),
      engine,
      { operationRegistry: registry, restBindings: bindings },
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: 'Invalid JSON body' });
  });

  it('returns 400 when the request body is not a JSON object', async () => {
    const engine = createEngine();

    const response = await handleRequest(
      request('POST', '/v1/workflows/workflow-123/fork', ['not-an-object']),
      engine,
      { operationRegistry: registry, restBindings: bindings },
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: 'Request body must be a JSON object' });
  });

  it('returns 400 when fromStep is not a non-negative safe integer', async () => {
    const engine = createEngine();

    const response = await handleRequest(
      request('POST', '/v1/workflows/workflow-123/fork', { fromStep: -1 }),
      engine,
      { operationRegistry: registry, restBindings: bindings },
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: 'Field "fromStep" must be a non-negative safe integer',
    });
  });

  it('returns 400 when the engine reports an invalid checkpoint step', async () => {
    const engine = createEngine();
    const originalFork = engine.fork.bind(engine);

    try {
      engine.fork = async () => {
        throw new Error('Checkpoint not found at step 7');
      };

      const response = await handleRequest(
        request('POST', '/v1/workflows/workflow-123/fork'),
        engine,
        { operationRegistry: registry, restBindings: bindings },
      );

      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ error: 'Checkpoint not found at step 7' });
    } finally {
      engine.fork = originalFork;
    }
  });

  it('returns 404 when the current checkpoint is missing', async () => {
    const engine = createEngine();
    const originalFork = engine.fork.bind(engine);

    try {
      engine.fork = async () => {
        throw new Error('Checkpoint not found for workflow "workflow-123"');
      };

      const response = await handleRequest(
        request('POST', '/v1/workflows/workflow-123/fork'),
        engine,
        { operationRegistry: registry, restBindings: bindings },
      );

      expect(response.status).toBe(404);
      expect(await response.json()).toEqual({
        error: 'Checkpoint not found for workflow "workflow-123"',
      });
    } finally {
      engine.fork = originalFork;
    }
  });

  it('returns 404 when the source workflow does not exist', async () => {
    const engine = createEngine();

    const response = await handleRequest(
      request('POST', '/v1/workflows/missing-workflow/fork'),
      engine,
      { operationRegistry: registry, restBindings: bindings },
    );

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: 'Workflow "missing-workflow" not found' });
  });

  it('returns the raw engine error message on unexpected failures', async () => {
    const engine = createEngine();
    const originalFork = engine.fork.bind(engine);

    try {
      engine.fork = async () => {
        throw new Error('unexpected fork failure');
      };

      const response = await handleRequest(
        request('POST', '/v1/workflows/workflow-123/fork'),
        engine,
        { operationRegistry: registry, restBindings: bindings },
      );

      expect(response.status).toBe(500);
      expect(await response.json()).toEqual({ error: 'unexpected fork failure' });
    } finally {
      engine.fork = originalFork;
    }
  });
});
