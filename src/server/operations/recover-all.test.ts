import { afterEach, describe, expect, it } from 'bun:test';

import { Engine } from '../../core/engine.ts';
import type { WorkflowContext } from '../../core/types.ts';
import { MemoryStorage } from '../../storage/memory.ts';
import { handleRequest } from '../handler.ts';
import { createOperationRegistry } from '../operation-catalog.ts';
import { recoverAllOperation, recoverAllRestBinding } from './recover-all.ts';

function createEngine(): Engine {
  const engine = new Engine({ storage: new MemoryStorage() });
  engine.register('echo', async function* (_ctx: WorkflowContext, input: unknown) {
    return input;
  });
  return engine;
}

function request(method: string, path: string): Request {
  return new Request(`http://localhost${path}`, { method });
}

const registry = createOperationRegistry([recoverAllOperation]);
const bindings = [recoverAllRestBinding];

describe('weft.recover.all', () => {
  let engine: Engine | undefined;

  afterEach(() => {
    engine?.[Symbol.dispose]();
    engine = undefined;
  });

  it('returns 200 with the recovered workflow ids on the happy path', async () => {
    engine = createEngine();
    const originalRecoverAll = engine.recoverAll.bind(engine);

    try {
      engine.recoverAll = async () =>
        [{ id: 'wf-recovered-1' }, { id: 'wf-recovered-2' }] as Awaited<
          ReturnType<Engine['recoverAll']>
        >;

      const response = await handleRequest(request('POST', '/v1/recover'), engine, {
        operationRegistry: registry,
        restBindings: bindings,
      });

      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({
        recovered: ['wf-recovered-1', 'wf-recovered-2'],
      });
    } finally {
      engine.recoverAll = originalRecoverAll;
    }
  });

  it('masks unexpected engine failures to a generic 500 (no raw message leak)', async () => {
    engine = createEngine();
    const originalRecoverAll = engine.recoverAll.bind(engine);

    try {
      engine.recoverAll = async () => {
        throw new Error('recover all exploded');
      };

      const response = await handleRequest(request('POST', '/v1/recover'), engine, {
        operationRegistry: registry,
        restBindings: bindings,
      });

      expect(response.status).toBe(500);
      expect(await response.json()).toEqual({ error: 'Internal server error' });
      expect(response.headers.get('Content-Type')).toContain('application/json');
    } finally {
      engine.recoverAll = originalRecoverAll;
    }
  });
});
