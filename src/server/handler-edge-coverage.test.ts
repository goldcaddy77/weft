import { describe, expect, it } from 'bun:test';

import { Engine } from '../core/engine.ts';
import { StartWorkflowValidationError } from '../core/start-workflow-validation.ts';
import { tenantFromInputField } from '../core/tenant.ts';
import type { WorkflowContext } from '../core/types.ts';
import { MemoryStorage } from '../storage/memory.ts';
import { handleRequest, type HandlerOptions } from './handler.ts';

function createEngine(): Engine {
  const engine = new Engine({
    storage: new MemoryStorage(),
    tenantResolver: tenantFromInputField('tenantId'),
  });

  engine.register('echo', async function* (_ctx: WorkflowContext, input: unknown) {
    return input;
  });

  return engine;
}

function request(method: string, path: string, body?: unknown): Request {
  const init: RequestInit = {
    method,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  };
  if (body !== undefined) {
    init.headers = { 'Content-Type': 'application/json' };
  }

  return new Request(`http://localhost${path}`, init);
}

async function json(response: Response): Promise<unknown> {
  return response.json();
}

describe('handleRequest edge coverage', () => {
  it('returns 400 when a route parameter cannot be decoded', async () => {
    const engine = createEngine();

    const response = await handleRequest(request('GET', '/v1/workflows/%E0%A4%A'), engine);

    expect(response.status).toBe(400);
    expect(await json(response)).toEqual({ error: 'Malformed route parameter encoding' });
  });

  it('accepts purge body filters with array statuses, numeric bounds, and attribute arrays', async () => {
    const engine = createEngine();
    let capturedFilter: unknown;
    engine.purge = async (filter) => {
      capturedFilter = filter;
      return { deleted: 0 };
    };

    const response = await handleRequest(
      request('POST', '/v1/workflows/purge', {
        filter: {
          status: ['running', 'failed'],
          type: 'echo',
          tags: ['alpha', 'beta'],
          limit: 2.9,
          offset: 1.2,
          attributes: [
            { key: 'priority', value: ['high', 'urgent'] },
            { key: 'attempt', gte: 1 },
          ],
        },
      }),
      engine,
    );

    expect(response.status).toBe(200);
    expect(capturedFilter).toEqual({
      status: ['running', 'failed'],
      type: 'echo',
      tags: ['alpha', 'beta'],
      limit: 2,
      offset: 1,
      attributes: [
        { key: 'priority', value: ['high', 'urgent'] },
        { key: 'attempt', gte: 1 },
      ],
    });
  });

  it('rejects invalid purge filters and malformed list tag query parameters', async () => {
    const engine = createEngine();

    const invalidBodies = [
      [{ filter: 'bad' }, 'Field "filter" must be an object'],
      [
        { filter: { status: 123 } },
        'Field "filter.status" must be a string or an array of strings',
      ],
      [{ filter: { type: 123 } }, 'Field "filter.type" must be a string'],
      [{ filter: { limit: 'a lot' } }, 'Field "filter.limit" must be a non-negative number'],
      [{ filter: { attributes: 'bad' } }, 'Field "filter.attributes" must be an array'],
      [{ filter: { attributes: [null] } }, 'Field "filter.attributes[0]" must be an object'],
      [
        { filter: { attributes: [{ key: '' }] } },
        'Field "filter.attributes[0].key" must be a non-empty string',
      ],
      [
        { filter: { attributes: [{ key: 'priority', value: { nested: true } }] } },
        'Field "filter.attributes[0].value" must be a string, number, boolean, or string array',
      ],
    ] as const;

    for (const [body, message] of invalidBodies) {
      const response = await handleRequest(request('POST', '/v1/workflows/purge', body), engine);
      expect(response.status).toBe(400);
      expect(await json(response)).toEqual({ error: message });
    }

    const malformedTagResponse = await handleRequest(request('GET', '/v1/workflows?tag='), engine);
    expect(malformedTagResponse.status).toBe(400);
    expect(await json(malformedTagResponse)).toEqual({
      error: 'Query parameter "tag" must not contain empty tags',
    });
  });

  it('maps addTags and removeTags failures to 404, 400, and 500 responses', async () => {
    const engine = createEngine();

    engine.addTags = async () => {
      throw new Error('workflow not found');
    };
    let response = await handleRequest(
      request('POST', '/v1/workflows/wf-1/tags', { tags: ['alpha'] }),
      engine,
    );
    expect(response.status).toBe(404);

    engine.addTags = async () => {
      throw new StartWorkflowValidationError('Invalid tags');
    };
    response = await handleRequest(
      request('POST', '/v1/workflows/wf-1/tags', { tags: ['alpha'] }),
      engine,
    );
    expect(response.status).toBe(400);

    engine.addTags = async () => {
      throw new Error('boom');
    };
    response = await handleRequest(
      request('POST', '/v1/workflows/wf-1/tags', { tags: ['alpha'] }),
      engine,
    );
    expect(response.status).toBe(500);

    engine.removeTags = async () => {
      throw new Error('workflow not found');
    };
    response = await handleRequest(
      request('DELETE', '/v1/workflows/wf-1/tags', { tags: ['alpha'] }),
      engine,
    );
    expect(response.status).toBe(404);

    engine.removeTags = async () => {
      throw new StartWorkflowValidationError('Invalid tags');
    };
    response = await handleRequest(
      request('DELETE', '/v1/workflows/wf-1/tags', { tags: ['alpha'] }),
      engine,
    );
    expect(response.status).toBe(400);

    engine.removeTags = async () => {
      throw new Error('boom');
    };
    response = await handleRequest(
      request('DELETE', '/v1/workflows/wf-1/tags', { tags: ['alpha'] }),
      engine,
    );
    expect(response.status).toBe(500);
  });

  it('accepts a fallback tenant claim when tenant_id is blank and surfaces fork failures distinctly', async () => {
    const engine = createEngine();
    const options: HandlerOptions = {
      authContext: {
        method: 'jwt',
        claims: { tenant_id: '   ', tenant: 'acme' },
      },
    };

    let response = await handleRequest(request('GET', '/v1/tenants/acme/quota'), engine, options);
    expect(response.status).toBe(200);

    engine.fork = async () => {
      throw new Error('workflow not found');
    };
    response = await handleRequest(request('POST', '/v1/workflows/wf-1/fork'), engine);
    expect(response.status).toBe(404);

    engine.fork = async () => {
      throw new Error('fork exploded');
    };
    response = await handleRequest(request('POST', '/v1/workflows/wf-1/fork'), engine);
    expect(response.status).toBe(500);
  });
});
