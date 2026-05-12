/**
 * `weft.workers.list` operation + REST binding — unit tests.
 *
 * Covers:
 * - REST GET succeeds with `system:read` and returns sorted-by-id workers,
 *   each with `availableCapacity`, `heartbeatAgeMs` derived from the
 *   injected clock, and a top-level `routingPolicy`.
 * - Authorization: 401 unauthenticated, 403 missing scope, 200 with scope.
 * - Discovery-only registry: `invoke` throws so a misconfigured server
 *   surfaces the error instead of silently returning bogus data.
 * - The operation reads the clock exactly once per request — proving the
 *   single-snapshot invariant.
 * - Unknown HTTP query keys are stripped without raising InvalidParams.
 */

import { afterEach, describe, expect, it } from 'bun:test';

import { Engine } from '../../core/engine.ts';
import { MemoryStorage } from '../../storage/memory.ts';
import { WorkerRegistry } from '../../worker/registry.ts';
import { handleRequest } from '../handler.ts';
import { createOperationRegistry, executeOperation } from '../operation-catalog.ts';
import { principalFromApiKey, principalFromJwtClaims } from '../principal.ts';
import { createLiveOperationRegistry } from '../rest-bindings.ts';
import {
  createListWorkersOperation,
  createListWorkersRestBinding,
  listWorkersOperation,
} from './list-workers.ts';

function createEngine(): Engine {
  return new Engine({ storage: new MemoryStorage() });
}

function systemReadAuthContext() {
  return {
    authContext: {
      method: 'api-key' as const,
      principal: principalFromApiKey({ subject: 'test', scopes: ['system:read'] }),
    },
  };
}

const binding = createListWorkersRestBinding();

describe('weft.workers.list — REST GET /v1/workers', () => {
  let engine: Engine | undefined;

  afterEach(() => {
    engine?.[Symbol.dispose]();
    engine = undefined;
  });

  it('returns a sorted-by-id list with derived capacity and heartbeat age', async () => {
    engine = createEngine();
    const workerRegistry = new WorkerRegistry();
    workerRegistry.register({
      id: 'charlie',
      queue: 'default',
      activities: ['process'],
      concurrency: 3,
    });
    workerRegistry.register({
      id: 'alpha',
      queue: 'mail',
      activities: ['send'],
      concurrency: 2,
    });
    // Pin lastHeartbeat so the assertion against the injected clock is exact.
    workerRegistry.getWorker('alpha')!.lastHeartbeat = 1000;
    workerRegistry.getWorker('charlie')!.lastHeartbeat = 2500;
    workerRegistry.assignTask('charlie', 'op-1', 30_000);

    const FIXED_NOW = 5000;
    const operation = createListWorkersOperation({
      workerRegistry,
      clock: () => FIXED_NOW,
    });

    const response = await handleRequest(
      new Request('http://localhost/v1/workers', { method: 'GET' }),
      engine,
      {
        operationRegistry: createOperationRegistry([operation]),
        restBindings: [binding],
        ...systemReadAuthContext(),
      },
    );

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('application/json');
    const body = (await response.json()) as {
      items: Array<Record<string, unknown>>;
      routingPolicy: string;
    };
    expect(body.routingPolicy).toBe('least-loaded');
    expect(body.items.map((item) => item['id'])).toEqual(['alpha', 'charlie']);
    expect(body.items[0]).toMatchObject({
      id: 'alpha',
      queue: 'mail',
      activities: ['send'],
      concurrency: 2,
      inFlight: 0,
      availableCapacity: 2,
      lastHeartbeatAt: 1000,
      heartbeatAgeMs: 4000,
    });
    expect(body.items[1]).toMatchObject({
      id: 'charlie',
      inFlight: 1,
      availableCapacity: 2,
      heartbeatAgeMs: 2500,
    });
  });

  it('strips unknown query keys without raising InvalidParams', async () => {
    engine = createEngine();
    const workerRegistry = new WorkerRegistry();

    const response = await handleRequest(
      new Request('http://localhost/v1/workers?weird=true&extra=value', { method: 'GET' }),
      engine,
      {
        operationRegistry: createOperationRegistry([
          createListWorkersOperation({ workerRegistry, clock: () => 0 }),
        ]),
        restBindings: [binding],
        ...systemReadAuthContext(),
      },
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as { items: unknown[] };
    expect(body.items).toEqual([]);
  });

  it('rejects unauthenticated callers with 401', async () => {
    engine = createEngine();
    const workerRegistry = new WorkerRegistry();

    const result = await executeOperation(
      'weft.workers.list',
      {},
      {
        principal: { method: 'unauthenticated' },
        engine,
        transport: 'jsonRpcStdio',
        registry: createLiveOperationRegistry({ workerRegistry, taskQueue: undefined! }),
      },
    );

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected rejection');
    expect(result.fault.code).toBe('Unauthorized');
  });

  it('rejects callers without system:read with 403', async () => {
    engine = createEngine();
    const workerRegistry = new WorkerRegistry();

    const result = await executeOperation(
      'weft.workers.list',
      {},
      {
        principal: principalFromJwtClaims({ sub: 'user', scope: 'workflows:read' }),
        engine,
        transport: 'jsonRpcStdio',
        registry: createLiveOperationRegistry({ workerRegistry, taskQueue: undefined! }),
      },
    );

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected rejection');
    expect(result.fault.code).toBe('Forbidden');
  });
});

describe('weft.workers.list — operation behavior', () => {
  it('invokes the clock exactly once per request, applying the same now to every worker', async () => {
    const workerRegistry = new WorkerRegistry();
    workerRegistry.register({ id: 'a', queue: 'q', activities: ['x'], concurrency: 1 });
    workerRegistry.register({ id: 'b', queue: 'q', activities: ['x'], concurrency: 1 });
    workerRegistry.getWorker('a')!.lastHeartbeat = 10;
    workerRegistry.getWorker('b')!.lastHeartbeat = 20;

    let calls = 0;
    const operation = createListWorkersOperation({
      workerRegistry,
      clock: () => {
        calls += 1;
        return 100;
      },
    });
    const engine = createEngine();
    try {
      const result = await executeOperation(
        'weft.workers.list',
        {},
        {
          principal: principalFromApiKey({ subject: 'test', scopes: ['system:read'] }),
          engine,
          transport: 'jsonRpcStdio',
          registry: createOperationRegistry([operation]),
        },
      );

      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error('expected success');
      expect(calls).toBe(1);
      const items = (result.value as { items: Array<{ heartbeatAgeMs: number }> }).items;
      expect(items.map((item) => item.heartbeatAgeMs)).toEqual([90, 80]);
    } finally {
      engine[Symbol.dispose]();
    }
  });

  it('throws when invoked from a discovery-only registry (no WorkerRegistry wired in)', async () => {
    const engine = createEngine();
    try {
      const result = await executeOperation(
        'weft.workers.list',
        {},
        {
          principal: principalFromApiKey({ subject: 'test', scopes: ['system:read'] }),
          engine,
          transport: 'jsonRpcStdio',
          registry: createOperationRegistry([listWorkersOperation]),
        },
      );

      expect(result.ok).toBe(false);
      if (result.ok) throw new Error('expected rejection');
      expect(result.fault.code).toBe('EngineFailure');
    } finally {
      engine[Symbol.dispose]();
    }
  });
});
