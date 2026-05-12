import { describe, expect, it } from 'bun:test';

import { encode } from '../../core/codec.ts';
import { Engine } from '../../core/engine.ts';
import type { WorkflowContext } from '../../core/types.ts';
import { KEYS, type ScanOptions } from '../../storage/interface.ts';
import { MemoryStorage } from '../../storage/memory.ts';
import { WorkerRegistry } from '../../worker/registry.ts';
import type { AuthorizationScope } from '../authorization-scope.ts';
import { createOperationRegistry, executeOperation } from '../operation-catalog.ts';
import { principalFromApiKey, principalFromJwtClaims } from '../principal.ts';
import { TaskQueue } from '../task-queue.ts';
import type { InflightRecord, QueuedRecord, ResolvedRecord } from '../task-state.ts';
import {
  createGetTaskDiagnosticsOperation,
  type GetTaskDiagnosticsOutput,
} from './get-task-diagnostics.ts';

function createEngine(storage: MemoryStorage): Engine {
  const engine = new Engine({ storage });
  engine.register('echo', async function* (_ctx: WorkflowContext, input: unknown) {
    return input;
  });
  return engine;
}

class ScanCountingStorage extends MemoryStorage {
  readonly scannedEntriesByPrefix = new Map<string, number>();

  override async *scan(
    prefix: string,
    options: ScanOptions = {},
  ): AsyncIterable<[string, Uint8Array]> {
    for await (const entry of super.scan(prefix, options)) {
      this.scannedEntriesByPrefix.set(prefix, (this.scannedEntriesByPrefix.get(prefix) ?? 0) + 1);
      yield entry;
    }
  }

  scannedEntryCount(prefix: string): number {
    return this.scannedEntriesByPrefix.get(prefix) ?? 0;
  }
}

async function runDiagnostics({
  engine,
  registry,
  taskQueue,
  input = {},
  scopes = ['system:read'],
}: {
  engine: Engine;
  registry: WorkerRegistry;
  taskQueue: TaskQueue;
  input?: Record<string, unknown>;
  scopes?: ReadonlyArray<AuthorizationScope>;
}) {
  const operation = createGetTaskDiagnosticsOperation({
    registry,
    taskQueue,
    now: () => 10_000,
  });
  const operationRegistry = createOperationRegistry([operation]);

  return executeOperation('weft.tasks.diagnostics', input, {
    principal: principalFromApiKey({ subject: 'operator', scopes }),
    engine,
    transport: 'jsonRpcStdio',
    registry: operationRegistry,
  });
}

describe('weft.tasks.diagnostics', () => {
  it('identifies stuck queued tasks, stale inflight tasks, retry storms, and capacity saturation', async () => {
    const storage = new MemoryStorage();
    const engine = createEngine(storage);
    const registry = new WorkerRegistry();
    const taskQueue = new TaskQueue();

    const stuckQueued: QueuedRecord = {
      operationId: 'queued-stuck',
      workflowId: 'workflow-a',
      activityName: 'charge',
      input: null,
      queue: 'payments',
      attempt: 1,
      visibilityTimeout: 30_000,
      queuedAt: 1_000,
      firstQueuedAt: 1_000,
      lastQueuedAt: 1_000,
      retryCount: 0,
      requeueCount: 0,
    };
    const staleInflight: InflightRecord = {
      operationId: 'inflight-stale',
      workflowId: 'workflow-a',
      activityName: 'charge',
      input: null,
      queue: 'payments',
      workerId: 'worker-stale',
      deadline: 20_000,
      attempt: 2,
      visibilityTimeout: 30_000,
      firstQueuedAt: 1_000,
      lastQueuedAt: 1_000,
      lastDispatchedAt: 2_000,
      startedAt: 2_100,
      lastHeartbeatAt: 3_000,
      retryCount: 1,
      requeueCount: 1,
    };
    const retryStorm: ResolvedRecord = {
      operationId: 'retry-storm',
      workflowId: 'workflow-a',
      activityName: 'ship',
      queue: 'payments',
      status: 'failed',
      resolvedAt: 9_000,
      firstQueuedAt: 1_000,
      lastQueuedAt: 8_000,
      lastDispatchedAt: 8_500,
      startedAt: 8_600,
      completedAt: 9_000,
      retryCount: 5,
      requeueCount: 5,
      resolutionReason: 'max-attempts-exceeded',
    };

    await storage.put(KEYS.operationQueued(stuckQueued.operationId), encode(stuckQueued));
    await storage.put(KEYS.operationInflight(staleInflight.operationId), encode(staleInflight));
    await storage.put(KEYS.operationResolved(retryStorm.operationId), encode(retryStorm));

    registry.register({
      id: 'worker-capacity',
      queue: 'payments',
      activities: ['charge'],
      concurrency: 1,
    });
    registry.assignTask('worker-capacity', 'busy-operation', 30_000);
    taskQueue.enqueue('payments', {
      operationId: 'queued-capacity',
      activityName: 'charge',
      input: null,
    });

    const result = await runDiagnostics({
      engine,
      registry,
      taskQueue,
      input: {
        workflowId: 'workflow-a',
        staleQueuedAfterMs: 5_000,
        staleHeartbeatAfterMs: 5_000,
        retryStormMinimumAttempts: 3,
        limit: 10,
      },
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected diagnostics result');
    const diagnostics = result.value as GetTaskDiagnosticsOutput;

    expect(diagnostics.summary).toEqual({
      stuckQueued: 1,
      staleInflight: 1,
      retryStorms: 1,
      allWorkersAtCapacity: 1,
    });
    expect(diagnostics.items.map((item) => item.kind)).toEqual([
      'stuck-queued',
      'stale-inflight',
      'retry-storm',
      'all-workers-at-capacity',
    ]);
    expect(diagnostics.items[0]).toMatchObject({
      operationId: 'queued-stuck',
      workflowId: 'workflow-a',
      queue: 'payments',
      queueLatencyMs: 9_000,
    });
    expect(diagnostics.items[1]).toMatchObject({
      operationId: 'inflight-stale',
      workerId: 'worker-stale',
      heartbeatAgeMs: 7_000,
    });
  });

  it('bounds diagnostic result items while retaining summary counts', async () => {
    const storage = new MemoryStorage();
    const engine = createEngine(storage);
    const registry = new WorkerRegistry();
    const taskQueue = new TaskQueue();

    for (let index = 0; index < 3; index += 1) {
      const record: QueuedRecord = {
        operationId: `queued-${index}`,
        activityName: 'charge',
        input: null,
        queue: 'default',
        attempt: 1,
        visibilityTimeout: 30_000,
        queuedAt: 1_000 + index,
        firstQueuedAt: 1_000 + index,
        lastQueuedAt: 1_000 + index,
        retryCount: 0,
        requeueCount: 0,
      };
      await storage.put(KEYS.operationQueued(record.operationId), encode(record));
    }

    const result = await runDiagnostics({
      engine,
      registry,
      taskQueue,
      input: { staleQueuedAfterMs: 1_000, limit: 2 },
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected diagnostics result');
    const diagnostics = result.value as GetTaskDiagnosticsOutput;
    expect(diagnostics.summary.stuckQueued).toBe(3);
    expect(diagnostics.items).toHaveLength(2);
    expect(diagnostics.limit).toBe(2);
  });

  it('bounds resolved history scans to the requested diagnostic limit', async () => {
    const storage = new ScanCountingStorage();
    const engine = createEngine(storage);
    const registry = new WorkerRegistry();
    const taskQueue = new TaskQueue();

    for (let index = 0; index < 5; index += 1) {
      const record: ResolvedRecord = {
        operationId: `resolved-retry-${index}`,
        workflowId: 'workflow-history',
        activityName: 'charge',
        queue: 'default',
        status: 'failed',
        resolvedAt: 9_000 + index,
        retryCount: 3,
        requeueCount: 3,
        resolutionReason: 'max-attempts-exceeded',
      };
      await storage.put(KEYS.operationResolved(record.operationId), encode(record));
    }

    const result = await runDiagnostics({
      engine,
      registry,
      taskQueue,
      input: {
        retryStormMinimumAttempts: 3,
        limit: 2,
      },
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected diagnostics result');
    const diagnostics = result.value as GetTaskDiagnosticsOutput;
    expect(storage.scannedEntryCount('op:resolved:')).toBe(2);
    expect(diagnostics.summary.retryStorms).toBe(2);
    expect(diagnostics.items).toHaveLength(2);
  });

  it('requires system read scope', async () => {
    const storage = new MemoryStorage();
    const engine = createEngine(storage);
    const operation = createGetTaskDiagnosticsOperation({
      registry: new WorkerRegistry(),
      taskQueue: new TaskQueue(),
    });
    const operationRegistry = createOperationRegistry([operation]);

    const result = await executeOperation(
      'weft.tasks.diagnostics',
      {},
      {
        principal: principalFromJwtClaims({ sub: 'user', scope: 'workflows:read' }),
        engine,
        transport: 'jsonRpcStdio',
        registry: operationRegistry,
      },
    );

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected authorization failure');
    expect(result.fault.code).toBe('Forbidden');
  });
});
