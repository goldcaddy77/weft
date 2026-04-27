import { afterEach, describe, expect, it } from 'bun:test';

import { Engine } from '../../core/engine.ts';
import { MemoryStorage } from '../../storage/memory.ts';
import { handleRequest } from '../handler.ts';
import { createOperationRegistry } from '../operation-catalog.ts';
import type { OperationFault } from '../operation-fault.ts';
import { getBudgetPolicyOperation, getBudgetPolicyRestBinding } from './get-budget-policy.ts';

function createEngine(): Engine {
  return new Engine({ storage: new MemoryStorage() });
}

const registry = createOperationRegistry([getBudgetPolicyOperation]);

describe('weft.budget.get', () => {
  let engine: Engine | undefined;

  afterEach(() => {
    engine?.[Symbol.dispose]();
  });

  it('returns the budget policy on the happy path', async () => {
    engine = createEngine();
    await engine.setBudgetPolicy({ namespace: 'org-1', daily: { maxCost: 50 } });

    const response = await handleRequest(
      new Request('http://localhost/v1/budget-policy/org-1', { method: 'GET' }),
      engine,
      {
        operationRegistry: registry,
        restBindings: [getBudgetPolicyRestBinding],
      },
    );

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('application/json');
    expect(await response.json()).toEqual({
      namespace: 'org-1',
      daily: { maxCost: 50 },
    });
  });

  it('returns 404 with the legacy error body when the namespace is missing', async () => {
    engine = createEngine();

    const response = await handleRequest(
      new Request('http://localhost/v1/budget-policy/missing', { method: 'GET' }),
      engine,
      {
        operationRegistry: registry,
        restBindings: [getBudgetPolicyRestBinding],
      },
    );

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({
      error: 'Budget policy for namespace "missing" not found',
    });
  });

  it('maps EngineFailure faults to the legacy 500 response body', async () => {
    engine = createEngine();

    const failingOperation = {
      ...getBudgetPolicyOperation,
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
      new Request('http://localhost/v1/budget-policy/org-1', { method: 'GET' }),
      engine,
      {
        operationRegistry: createOperationRegistry([failingOperation]),
        restBindings: [getBudgetPolicyRestBinding],
      },
    );

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: 'Internal server error' });
  });
});
