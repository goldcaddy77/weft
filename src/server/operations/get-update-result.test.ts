import { afterEach, describe, expect, it } from 'bun:test';

import { Engine } from '../../core/engine.ts';
import { UpdateCoordinator } from '../../core/updates.ts';
import { MemoryStorage } from '../../storage/memory.ts';
import { handleRequest } from '../handler.ts';
import { createOperationRegistry } from '../operation-catalog.ts';
import type { OperationFault } from '../operation-fault.ts';
import { getUpdateResultOperation, getUpdateResultRestBinding } from './get-update-result.ts';

function createEngineWithStorage(): { engine: Engine; storage: MemoryStorage } {
  const storage = new MemoryStorage();
  return { engine: new Engine({ storage }), storage };
}

const registry = createOperationRegistry([getUpdateResultOperation]);

describe('weft.updates.result.get', () => {
  let engine: Engine | undefined;

  afterEach(() => {
    engine?.[Symbol.dispose]();
  });

  it('returns 202 pending when the update result is not ready yet', async () => {
    const setup = createEngineWithStorage();
    engine = setup.engine;
    const coordinator = new UpdateCoordinator(setup.storage);
    const updateId = await coordinator.createRequest('wf-update-pending', 'setName', {
      name: 'Alice',
    });

    const response = await handleRequest(
      new Request(`http://localhost/v1/updates/${updateId}`, { method: 'GET' }),
      engine,
      {
        operationRegistry: registry,
        restBindings: [getUpdateResultRestBinding],
      },
    );

    expect(response.status).toBe(202);
    expect(response.headers.get('content-type')).toBe('application/json');
    expect(await response.json()).toEqual({ status: 'pending' });
  });

  it('returns the completed update result payload', async () => {
    const setup = createEngineWithStorage();
    engine = setup.engine;
    const coordinator = new UpdateCoordinator(setup.storage);
    const updateId = await coordinator.createRequest('wf-update-completed', 'setName', {
      name: 'Alice',
    });

    await setup.storage.batch(
      coordinator.buildResponseOperations(
        updateId,
        'wf-update-completed',
        { accepted: true },
        'minor issue',
      ),
    );

    const response = await handleRequest(
      new Request(`http://localhost/v1/updates/${updateId}`, { method: 'GET' }),
      engine,
      {
        operationRegistry: registry,
        restBindings: [getUpdateResultRestBinding],
      },
    );

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('application/json');
    expect(await response.json()).toEqual({
      status: 'completed',
      result: { accepted: true },
      error: 'minor issue',
    });
  });

  it('maps EngineFailure faults to the legacy 500 response body', async () => {
    const setup = createEngineWithStorage();
    engine = setup.engine;

    const failingOperation = {
      ...getUpdateResultOperation,
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
      new Request('http://localhost/v1/updates/any-update-id', { method: 'GET' }),
      engine,
      {
        operationRegistry: createOperationRegistry([failingOperation]),
        restBindings: [getUpdateResultRestBinding],
      },
    );

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: 'Internal server error' });
  });
});
