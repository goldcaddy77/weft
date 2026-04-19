import { afterEach, describe, expect, it } from 'bun:test';

import {
  KEYS,
  type BatchOperation,
  type ConditionalBatchCondition,
  type Storage as WeftStorage,
} from '../storage/interface.ts';
import { MemoryStorage } from '../storage/memory.ts';
import { encode } from './codec.ts';
import { Context } from './context.ts';
import { Engine } from './engine.ts';
import { buildTimerBatchOperations } from './scheduler.ts';
import { QuotaExceededError, TenantQuotaManager } from './tenant-quotas.ts';
import { tenantFromInputField } from './tenant.ts';
import type { TenantQuotaOptions, WorkflowContext } from './types.ts';

const storageByteEncoder = new TextEncoder();

class BarrierConditionalBatchMemoryStorage extends MemoryStorage {
  failedConditionalBatches = 0;
  conditionalBatchCalls = 0;
  readonly #barrierKeys: Set<string>;
  readonly #barrierState = new Map<
    string,
    { active: boolean; waiters: number; release: (() => void) | null }
  >();

  constructor(barrierKeys: Iterable<string>) {
    super();
    this.#barrierKeys = new Set(barrierKeys);
  }

  override async get(key: string): Promise<Uint8Array | null> {
    if (this.#barrierKeys.has(key)) {
      await this.#waitForBarrier(`get:${key}`);
    }

    return super.get(key);
  }

  override async *scan(
    prefix: string,
    options?: Parameters<MemoryStorage['scan']>[1],
  ): AsyncIterable<[string, Uint8Array]> {
    if (prefix === 'wf:') {
      await this.#waitForBarrier('scan:wf:');
    }

    for await (const entry of super.scan(prefix, options)) {
      yield entry;
    }
  }

  override async conditionalBatch(
    conditions: ConditionalBatchCondition[],
    operations: BatchOperation[],
  ): Promise<boolean> {
    this.conditionalBatchCalls++;

    const committed = await super.conditionalBatch(conditions, operations);
    if (!committed) {
      this.failedConditionalBatches++;
    }
    return committed;
  }

  async #waitForBarrier(name: string): Promise<void> {
    const state = this.#barrierState.get(name) ?? {
      active: true,
      waiters: 0,
      release: null,
    };
    if (!state.active) {
      return;
    }

    state.waiters++;
    this.#barrierState.set(name, state);

    if (state.waiters === 2) {
      state.active = false;
      state.release?.();
      state.release = null;
      return;
    }

    await new Promise<void>((resolve) => {
      state.release = resolve;
    });
  }
}

function measureStoredRecordBytes(key: string, value: Uint8Array): number {
  return storageByteEncoder.encode(key).byteLength + value.byteLength;
}

function createEngine(parameters?: {
  now?: () => number;
  quotas?: TenantQuotaOptions;
  storage?: WeftStorage;
}): Engine {
  const engineOptions: NonNullable<ConstructorParameters<typeof Engine>[0]> = {
    storage: parameters?.storage ?? new MemoryStorage(),
    tenantResolver: tenantFromInputField('tenantId'),
  };
  if (parameters?.now) {
    engineOptions.getNow = parameters.now;
  }
  if (parameters?.quotas) {
    engineOptions.quotas = parameters.quotas;
  }

  const engine = new Engine(engineOptions);

  engine.register('hold', async function* (context: WorkflowContext, input: unknown) {
    const payload =
      input !== null && typeof input === 'object' && 'payload' in input
        ? (input as { payload?: string }).payload
        : undefined;
    yield* (context as Context).waitForSignal('release');
    return payload ?? 'released';
  });

  engine.register('echo', async function* (_context: WorkflowContext, input: unknown) {
    return input;
  });

  engine.register('explode', async function* () {
    throw new Error('workflow exploded');
  });

  return engine;
}

describe('tenant resource quotas', () => {
  const disposables: Engine[] = [];

  afterEach(() => {
    for (const engine of disposables.splice(0)) {
      engine[Symbol.dispose]();
    }
  });

  it('rejects starts that exceed maxConcurrentWorkflows for the same tenant', async () => {
    const engine = createEngine({ quotas: { maxConcurrentWorkflows: 1 } });
    disposables.push(engine);

    const firstHandle = await engine.start('hold', { tenantId: 'acme' });

    const error = await engine.start('hold', { tenantId: 'acme' }).catch((value: unknown) => value);

    expect(error).toBeInstanceOf(QuotaExceededError);
    expect(error).toMatchObject({
      tenantId: 'acme',
      quota: 'maxConcurrentWorkflows',
      currentUsage: 2,
      limit: 1,
      windowMilliseconds: null,
    } satisfies Partial<QuotaExceededError>);

    await engine.signal(firstHandle.id, 'release');
    await firstHandle.result();
  });

  it('checks concurrent workflow quotas atomically across admissions that share storage', async () => {
    const storage = new BarrierConditionalBatchMemoryStorage([KEYS.quotaActive('acme')]);
    const firstWorkflowState = encode({
      id: 'quota-active-1',
      status: 'pending',
      tenant: { id: 'acme' },
    });
    const secondWorkflowState = encode({
      id: 'quota-active-2',
      status: 'pending',
      tenant: { id: 'acme' },
    });
    const firstQuotaManager = new TenantQuotaManager(storage, Date.now, {
      maxConcurrentWorkflows: 1,
    });
    const secondQuotaManager = new TenantQuotaManager(storage, Date.now, {
      maxConcurrentWorkflows: 1,
    });

    const results = await Promise.allSettled([
      firstQuotaManager.commitStartAdmission({
        tenantId: 'acme',
        workflowId: 'quota-active-1',
        startOperations: [
          {
            type: 'put',
            key: KEYS.workflow('quota-active-1'),
            value: firstWorkflowState,
          },
        ],
        estimatedStorageBytes: 0,
      }),
      secondQuotaManager.commitStartAdmission({
        tenantId: 'acme',
        workflowId: 'quota-active-2',
        startOperations: [
          {
            type: 'put',
            key: KEYS.workflow('quota-active-2'),
            value: secondWorkflowState,
          },
        ],
        estimatedStorageBytes: 0,
      }),
    ]);

    const fulfilled = results.filter(
      (result): result is PromiseFulfilledResult<void> => result.status === 'fulfilled',
    );
    const rejected = results.filter(
      (result): result is PromiseRejectedResult => result.status === 'rejected',
    );

    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(storage.conditionalBatchCalls).toBe(2);
    expect(storage.failedConditionalBatches).toBe(1);
    expect(rejected[0]!.reason).toMatchObject({
      tenantId: 'acme',
      quota: 'maxConcurrentWorkflows',
      currentUsage: 2,
      limit: 1,
      windowMilliseconds: null,
    } satisfies Partial<QuotaExceededError>);
  });

  it('checks storage byte quotas atomically across admissions that share storage', async () => {
    const storage = new BarrierConditionalBatchMemoryStorage([KEYS.quotaStorage('acme')]);

    const buildStartOperation = (workflowId: string) => {
      const workflowState = encode({
        id: workflowId,
        status: 'pending',
        tenant: { id: 'acme' },
      });
      const workflowKey = KEYS.workflow(workflowId);

      return {
        estimatedStorageBytes: measureStoredRecordBytes(workflowKey, workflowState),
        operations: [
          {
            type: 'put' as const,
            key: workflowKey,
            value: workflowState,
          },
        ],
      };
    };

    const firstStart = buildStartOperation('quota-storage-1');
    const secondStart = buildStartOperation('quota-storage-2');
    const limit = Math.max(firstStart.estimatedStorageBytes, secondStart.estimatedStorageBytes);

    const firstLimitedManager = new TenantQuotaManager(storage, Date.now, {
      maxStorageBytes: limit,
    });
    const secondLimitedManager = new TenantQuotaManager(storage, Date.now, {
      maxStorageBytes: limit,
    });

    const results = await Promise.allSettled([
      firstLimitedManager.commitStartAdmission({
        tenantId: 'acme',
        workflowId: 'quota-storage-1',
        startOperations: firstStart.operations,
        estimatedStorageBytes: firstStart.estimatedStorageBytes,
      }),
      secondLimitedManager.commitStartAdmission({
        tenantId: 'acme',
        workflowId: 'quota-storage-2',
        startOperations: secondStart.operations,
        estimatedStorageBytes: secondStart.estimatedStorageBytes,
      }),
    ]);

    const fulfilled = results.filter(
      (result): result is PromiseFulfilledResult<void> => result.status === 'fulfilled',
    );
    const rejected = results.filter(
      (result): result is PromiseRejectedResult => result.status === 'rejected',
    );

    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(storage.conditionalBatchCalls).toBe(2);
    expect(storage.failedConditionalBatches).toBe(1);
    const firstWorkflowBytes = encode({
      id: 'quota-storage-1',
      status: 'pending',
      tenant: { id: 'acme' },
    });
    const secondWorkflowBytes = encode({
      id: 'quota-storage-2',
      status: 'pending',
      tenant: { id: 'acme' },
    });
    expect(rejected[0]!.reason).toMatchObject({
      tenantId: 'acme',
      quota: 'maxStorageBytes',
      currentUsage:
        measureStoredRecordBytes(KEYS.workflow('quota-storage-1'), firstWorkflowBytes) +
        measureStoredRecordBytes(KEYS.workflow('quota-storage-2'), secondWorkflowBytes),
      limit,
      windowMilliseconds: null,
    } satisfies Partial<QuotaExceededError>);
  });

  it('releases active workflow quota when a tenant workflow reaches a terminal state', async () => {
    const engine = createEngine({ quotas: { maxConcurrentWorkflows: 1 } });
    disposables.push(engine);

    const firstHandle = await engine.start('hold', { tenantId: 'acme' });

    await engine.signal(firstHandle.id, 'release');
    await firstHandle.result();

    const secondHandle = await engine.start('hold', { tenantId: 'acme' });
    const usage = await engine.getQuotaUsage('acme');

    expect(usage.activeWorkflows.used).toBe(1);
    expect(usage.activeWorkflows.limit).toBe(1);

    await engine.signal(secondHandle.id, 'release');
    await secondHandle.result();
  });

  it('releases active workflow quota when a tenant workflow fails', async () => {
    const engine = createEngine({ quotas: { maxConcurrentWorkflows: 1 } });
    disposables.push(engine);

    const failedHandle = await engine.start('explode', { tenantId: 'acme' });
    await expect(failedHandle.result()).rejects.toThrow('workflow exploded');

    const secondHandle = await engine.start('hold', { tenantId: 'acme' });
    await engine.signal(secondHandle.id, 'release');
    await expect(secondHandle.result()).resolves.toBeDefined();
  });

  it('releases active workflow quota when a tenant workflow is cancelled', async () => {
    const engine = createEngine({ quotas: { maxConcurrentWorkflows: 1 } });
    disposables.push(engine);

    const cancelledHandle = await engine.start('hold', { tenantId: 'acme' });
    await engine.cancel(cancelledHandle.id);
    await expect(cancelledHandle.result()).rejects.toThrow('cancelled');

    const secondHandle = await engine.start('hold', { tenantId: 'acme' });
    await engine.signal(secondHandle.id, 'release');
    await expect(secondHandle.result()).resolves.toBeDefined();
  });

  it('rejects starts that exceed maxWorkflowCreationRate within the configured window', async () => {
    let now = new Date('2026-04-19T07:00:00.000Z').getTime();
    const engine = createEngine({
      now: () => now,
      quotas: {
        maxWorkflowCreationRate: { count: 1, window: '1m' },
      },
    });
    disposables.push(engine);

    await engine.start('echo', { tenantId: 'acme', value: 1 });

    const error = await engine
      .start('echo', { tenantId: 'acme', value: 2 })
      .catch((value) => value);

    expect(error).toBeInstanceOf(QuotaExceededError);
    expect(error).toMatchObject({
      tenantId: 'acme',
      quota: 'maxWorkflowCreationRate',
      currentUsage: 2,
      limit: 1,
      windowMilliseconds: 60_000,
    } satisfies Partial<QuotaExceededError>);

    now += 61_000;

    await expect(engine.start('echo', { tenantId: 'acme', value: 3 })).resolves.toBeDefined();
  });

  it('rejects starts that would exceed maxStorageBytes for a tenant', async () => {
    const engine = createEngine({ quotas: { maxStorageBytes: 512 } });
    disposables.push(engine);

    const error = await engine
      .start('echo', {
        tenantId: 'acme',
        payload: 'x'.repeat(4_096),
      })
      .catch((value) => value);

    expect(error).toBeInstanceOf(QuotaExceededError);
    expect(error).toMatchObject({
      tenantId: 'acme',
      quota: 'maxStorageBytes',
      limit: 512,
      windowMilliseconds: null,
    } satisfies Partial<QuotaExceededError>);
    expect((error as QuotaExceededError).currentUsage).toBeGreaterThan(512);
  });

  it('counts attribute indexes and timer records in start-time storage byte estimates', async () => {
    const storage = new MemoryStorage();
    const workflowId = 'quota-storage-estimate';
    const workflowState = encode({
      id: workflowId,
      status: 'pending',
      tenant: { id: 'acme' },
    });
    const timerOperations = buildTimerBatchOperations({
      id: `deadline:${workflowId}`,
      workflowId,
      fireAt: 5_000,
      kind: 'execution-deadline',
    });
    const startOperations: BatchOperation[] = [
      {
        type: 'put',
        key: KEYS.workflow(workflowId),
        value: workflowState,
      },
      {
        type: 'put',
        key: KEYS.attributeIndex('status', 's:queued', workflowId),
        value: new Uint8Array(0),
      },
      ...timerOperations,
    ];
    const expectedStorageBytes = startOperations.reduce((total, operation) => {
      if (operation.type !== 'put') {
        return total;
      }

      return total + measureStoredRecordBytes(operation.key, operation.value);
    }, 0);
    const quotaManager = new TenantQuotaManager(storage, Date.now, {
      maxStorageBytes: expectedStorageBytes - 1,
    });

    const error = await quotaManager
      .commitStartAdmission({
        tenantId: 'acme',
        workflowId,
        startOperations,
        estimatedStorageBytes: quotaManager.estimateStartStorageBytes(workflowId, startOperations),
      })
      .catch((value: unknown) => value);

    expect(error).toBeInstanceOf(QuotaExceededError);
    expect(error).toMatchObject({
      tenantId: 'acme',
      quota: 'maxStorageBytes',
      currentUsage: expectedStorageBytes,
      limit: expectedStorageBytes - 1,
      windowMilliseconds: null,
    } satisfies Partial<QuotaExceededError>);
  });

  it('ignores malformed durable quota records instead of failing quota reads', async () => {
    const storage = new MemoryStorage();
    const engine = createEngine({
      storage,
      quotas: {
        maxConcurrentWorkflows: 2,
        maxWorkflowCreationRate: { count: 2, window: '1m' },
      },
    });
    disposables.push(engine);

    await storage.put('wf:corrupt', new Uint8Array([0xc1]));
    await storage.put(KEYS.quotaRate('acme', 60_000), new Uint8Array([0xc1]));

    const usage = await engine.getQuotaUsage('acme');

    expect(usage.activeWorkflows.used).toBe(0);
    expect(usage.workflowCreationRate.used).toBe(0);
    await expect(engine.start('echo', { tenantId: 'acme', value: 1 })).resolves.toBeDefined();
  });

  it('counts attribute indexes and timer records in tenant quota usage', async () => {
    const storage = new MemoryStorage();
    const quotaManager = new TenantQuotaManager(storage, Date.now, {
      maxStorageBytes: 65_536,
    });
    const workflowId = 'quota-usage-records';
    const workflowState = encode({
      id: workflowId,
      status: 'running',
      tenant: { id: 'acme' },
    });
    const indexValue = new Uint8Array(0);
    const timerOperations = buildTimerBatchOperations({
      id: `review-timeout:${workflowId}`,
      workflowId,
      fireAt: 15_000,
      kind: 'sleep',
    });

    await storage.put(KEYS.workflow(workflowId), workflowState);
    await storage.put(KEYS.attributeIndex('status', 's:queued', workflowId), indexValue);
    for (const operation of timerOperations) {
      if (operation.type === 'put') {
        await storage.put(operation.key, operation.value);
      }
    }

    const usage = await quotaManager.getUsage('acme');
    const expectedStorageBytes =
      measureStoredRecordBytes(KEYS.workflow(workflowId), workflowState) +
      measureStoredRecordBytes(KEYS.attributeIndex('status', 's:queued', workflowId), indexValue) +
      timerOperations.reduce((total, operation) => {
        if (operation.type !== 'put') {
          return total;
        }

        return total + measureStoredRecordBytes(operation.key, operation.value);
      }, 0);

    expect(usage.storageBytes.used).toBe(expectedStorageBytes);
  });

  it('reports current quota usage versus configured limits for a tenant', async () => {
    let now = new Date('2026-04-19T07:00:00.000Z').getTime();
    const engine = createEngine({
      now: () => now,
      quotas: {
        maxConcurrentWorkflows: 2,
        maxStorageBytes: 32_768,
        maxWorkflowCreationRate: { count: 3, window: '5m' },
      },
    });
    disposables.push(engine);

    const handle = await engine.start('hold', {
      tenantId: 'acme',
      payload: 'quota-visible',
    });

    const usage = await engine.getQuotaUsage('acme');

    expect(usage.tenantId).toBe('acme');
    expect(usage.activeWorkflows.used).toBe(1);
    expect(usage.activeWorkflows.limit).toBe(2);
    expect(usage.storageBytes.used).toBeGreaterThan(0);
    expect(usage.storageBytes.limit).toBe(32_768);
    expect(usage.workflowCreationRate.used).toBe(1);
    expect(usage.workflowCreationRate.limit).toBe(3);
    expect(usage.workflowCreationRate.windowMilliseconds).toBe(300_000);

    now += 1_000;
    await engine.signal(handle.id, 'release');
    await handle.result();
  });

  it('does not apply per-tenant quotas when the workflow has no tenant context', async () => {
    const engine = createEngine({ quotas: { maxConcurrentWorkflows: 1 } });
    disposables.push(engine);

    const firstHandle = await engine.start('hold', {});
    const secondHandle = await engine.start('hold', {});

    await engine.signal(firstHandle.id, 'release');
    await engine.signal(secondHandle.id, 'release');
    await Promise.all([firstHandle.result(), secondHandle.result()]);
  });

  it('requires conditionalBatch support for storage byte quotas', () => {
    const memoryStorage = new MemoryStorage();
    const storageWithoutConditionalBatch: WeftStorage = {
      get: memoryStorage.get.bind(memoryStorage),
      put: memoryStorage.put.bind(memoryStorage),
      delete: memoryStorage.delete.bind(memoryStorage),
      scan: memoryStorage.scan.bind(memoryStorage),
      batch: memoryStorage.batch.bind(memoryStorage),
      [Symbol.dispose]: memoryStorage[Symbol.dispose].bind(memoryStorage),
    };

    expect(
      () =>
        new TenantQuotaManager(storageWithoutConditionalBatch, Date.now, { maxStorageBytes: 1 }),
    ).toThrow(
      'EngineOptions.quotas.maxConcurrentWorkflows, maxWorkflowCreationRate, and maxStorageBytes require a storage backend that implements conditionalBatch().',
    );
  });
});
