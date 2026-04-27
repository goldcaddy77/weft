import { describe, expect, it } from 'bun:test';

import { Engine } from '../../core/engine.ts';
import { MemoryStorage } from '../../storage/memory.ts';
import { handleRequest } from '../handler.ts';
import { createOperationRegistry } from '../operation-catalog.ts';
import { setBudgetPolicyOperation, setBudgetPolicyRestBinding } from './set-budget-policy.ts';

function createEngine(): Engine {
  const storage = new MemoryStorage();
  return new Engine({ storage });
}

const registry = createOperationRegistry([setBudgetPolicyOperation]);
const bindings = [setBudgetPolicyRestBinding];

describe('weft.budget.set', () => {
  it('sets a budget policy and returns the legacy ok response', async () => {
    const engine = createEngine();

    const response = await handleRequest(
      request('PUT', '/v1/budget-policy', {
        namespace: 'org-1',
        daily: { maxCost: 10 },
        monthly: { maxCost: 100 },
      }),
      engine,
      {
        operationRegistry: registry,
        restBindings: bindings,
      },
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
    expect(await engine.getBudgetPolicy('org-1')).toEqual({
      namespace: 'org-1',
      daily: { maxCost: 10 },
      monthly: { maxCost: 100 },
    });
  });

  it('returns 400 when validation fails', async () => {
    const engine = createEngine();

    const response = await handleRequest(
      request('PUT', '/v1/budget-policy', {
        daily: { maxCost: 10 },
      }),
      engine,
      {
        operationRegistry: registry,
        restBindings: bindings,
      },
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: 'Missing required field: namespace' });
  });

  it('returns 400 when the body is not a JSON object', async () => {
    const engine = createEngine();

    const response = await handleRequest(
      new Request('http://localhost/v1/budget-policy', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: 'null',
      }),
      engine,
      {
        operationRegistry: registry,
        restBindings: bindings,
      },
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: 'Request body must be a JSON object' });
  });

  it('returns the raw engine message for unexpected 500 failures', async () => {
    const engine = createEngine();
    const originalSetBudgetPolicy = engine.setBudgetPolicy.bind(engine);
    engine.setBudgetPolicy = async () => {
      throw new Error('budget policy write failed');
    };

    try {
      const response = await handleRequest(
        request('PUT', '/v1/budget-policy', { namespace: 'org-1' }),
        engine,
        {
          operationRegistry: registry,
          restBindings: bindings,
        },
      );

      expect(response.status).toBe(500);
      expect(await response.json()).toEqual({ error: 'budget policy write failed' });
    } finally {
      engine.setBudgetPolicy = originalSetBudgetPolicy;
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
