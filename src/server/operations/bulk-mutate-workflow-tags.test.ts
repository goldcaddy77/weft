/**
 * `weft.workflows.bulk.tags` operation + REST binding — behavior tests.
 */

import { describe, expect, it } from 'bun:test';

import { Engine } from '../../core/engine.ts';
import type { WorkflowContext } from '../../core/types.ts';
import { MemoryStorage } from '../../storage/memory.ts';
import { handleRequest } from '../handler.ts';
import { createOperationRegistry } from '../operation-catalog.ts';
import type { OperationFault } from '../operation-fault.ts';
import {
  bulkMutateWorkflowTagsOperation,
  bulkMutateWorkflowTagsRestBinding,
} from './bulk-mutate-workflow-tags.ts';

function createEngine(): Engine {
  const engine = new Engine({ storage: new MemoryStorage() });
  engine.register('echo', async function* (_ctx: WorkflowContext, input: unknown) {
    return input;
  });
  return engine;
}

function request(body?: unknown): Request {
  return new Request('http://localhost/v1/workflows/bulk/tags', {
    method: 'PATCH',
    ...(body === undefined
      ? {}
      : {
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        }),
  });
}

const registry = createOperationRegistry([bulkMutateWorkflowTagsOperation]);
const bindings = [bulkMutateWorkflowTagsRestBinding];

describe('weft.workflows.bulk.tags', () => {
  it('adds and removes tags on matching workflows', async () => {
    const engine = createEngine();

    const firstHandle = await engine.start('echo', 'first', {
      id: 'bulk-tags-selected-a',
      tags: ['selected'],
    });
    const secondHandle = await engine.start('echo', 'second', {
      id: 'bulk-tags-selected-b',
      tags: ['selected'],
    });
    await firstHandle.result();
    await secondHandle.result();

    let response = await handleRequest(
      request({
        filter: { tags: ['selected'] },
        tags: ['bulk'],
        operation: 'add',
      }),
      engine,
      { operationRegistry: registry, restBindings: bindings },
    );

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('application/json');
    expect(await response.json()).toEqual({ modified: 2 });
    const firstAddedTagsState = await engine.get('bulk-tags-selected-a');
    const secondAddedTagsState = await engine.get('bulk-tags-selected-b');
    expect(firstAddedTagsState?.tags).toEqual(['bulk', 'selected']);
    expect(secondAddedTagsState?.tags).toEqual(['bulk', 'selected']);

    response = await handleRequest(
      request({
        filter: { tags: ['bulk'] },
        tags: ['selected'],
        operation: 'remove',
      }),
      engine,
      { operationRegistry: registry, restBindings: bindings },
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ modified: 2 });
    const firstRemovedTagsState = await engine.get('bulk-tags-selected-a');
    const secondRemovedTagsState = await engine.get('bulk-tags-selected-b');
    expect(firstRemovedTagsState?.tags).toEqual(['bulk']);
    expect(secondRemovedTagsState?.tags).toEqual(['bulk']);
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

  it('returns 400 for invalid tag mutation input', async () => {
    const engine = createEngine();

    let response = await handleRequest(
      request({
        filter: {},
        tags: ['bulk'],
        operation: 'add',
      }),
      engine,
      {
        operationRegistry: registry,
        restBindings: bindings,
      },
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error:
        'Field "filter" must include at least one of status, type, tags, attributes, tenantId, idPrefix (≥3 chars), or failureCategory paired with status',
    });

    response = await handleRequest(
      request({
        filter: { tags: ['selected'] },
        tags: ['bulk'],
        operation: 'rename',
      }),
      engine,
      {
        operationRegistry: registry,
        restBindings: bindings,
      },
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: 'Field "operation" must be "add" or "remove"',
    });
  });

  it('maps EngineFailure faults to the legacy 500 response body', async () => {
    const engine = createEngine();
    const failingOperation = {
      ...bulkMutateWorkflowTagsOperation,
      invoke: async () => {
        const fault: OperationFault = {
          code: 'EngineFailure',
          message: 'tag failed',
          data: {},
        };
        throw fault;
      },
    };
    const failingRegistry = createOperationRegistry([failingOperation]);

    const response = await handleRequest(
      request({
        filter: { tags: ['selected'] },
        tags: ['bulk'],
        operation: 'add',
      }),
      engine,
      {
        operationRegistry: failingRegistry,
        restBindings: bindings,
      },
    );

    expect(response.status).toBe(500);
    expect(response.headers.get('content-type')).toBe('application/json');
    expect(await response.json()).toEqual({ error: 'tag failed' });
  });
});
