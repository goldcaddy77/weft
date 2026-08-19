import { describe, expect, it } from 'bun:test';

import {
  KEYS,
  MAX_BATCH_OPERATIONS,
  assertStorageBatchOperationCount,
  storageCount,
  type BatchOperation,
  type Storage,
} from '../../storage/interface.ts';
import { MemoryStorage } from '../../storage/memory.ts';
import { encode } from '../codec.ts';
import type { WorkflowState } from '../types.ts';
import {
  clearPurgedWorkflowInMemoryState,
  collectWorkflowPurgeDeleteOperations,
  purgeInternal,
  purgeWorkflow,
} from './bulk-operations-purge.ts';
import { encodeEpoch } from './lease-codec.ts';
import { createTerminalCleanupTimerId } from './state-utilities.ts';

/**
 * MemoryStorage that enforces the MAX_BATCH_OPERATIONS cap inside batch(), the
 * same way the real Postgres/SQLite adapters do. The base MemoryStorage does
 * enforce it too, but wrapping it here documents intent and lets subclasses
 * strip the native range-delete fast paths without losing the cap.
 */
class CapEnforcingMemoryStorage extends MemoryStorage {
  override async batch(operations: BatchOperation[]): Promise<void> {
    assertStorageBatchOperationCount('batch operations', operations.length);
    await super.batch(operations);
  }
}

/**
 * A cap-enforcing MemoryStorage with its native deletePrefix/deleteRange
 * removed, forcing the derived scan-and-delete fallback — the exact path a
 * non-native adapter (NodeSQLiteStorage, boundedRangeDelete: false) takes. Used
 * because better-sqlite3's native bindings do not load under Bun's test runner.
 * Built as a delegating wrapper (rather than a subclass overriding the optional
 * methods to `undefined`) so the resulting object's type has no `deletePrefix`
 * / `deleteRange` at all — the same shape a genuinely non-native adapter has.
 */
function createNonNativeStorage(): MemoryStorage {
  const inner = new CapEnforcingMemoryStorage();
  const nonNative: Storage = {
    capabilities: () => ({ ...inner.capabilities(), boundedRangeDelete: false }),
    get: inner.get.bind(inner),
    put: inner.put.bind(inner),
    delete: inner.delete.bind(inner),
    scan: inner.scan.bind(inner),
    batch: inner.batch.bind(inner),
    conditionalBatch: inner.conditionalBatch?.bind(inner),
    has: inner.has.bind(inner),
    keys: inner.keys.bind(inner),
    count: inner.count.bind(inner),
    [Symbol.dispose]: inner[Symbol.dispose].bind(inner),
  };
  // The purge helpers accept a MemoryStorage-typed internals.storage; this object
  // satisfies the Storage contract the helpers actually use.
  return nonNative as unknown as MemoryStorage;
}

/**
 * Seed a terminal run whose checkpoint + event history exceeds one batch, plus
 * its state row and terminal index. `count` defaults above MAX_BATCH_OPERATIONS
 * so a single-batch purge would throw. Uses put() (not batch()) to seed so the
 * seeding itself never trips the cap.
 */
async function seedOversizedRun(
  storage: MemoryStorage,
  workflowId: string,
  updatedAt: number,
  count = MAX_BATCH_OPERATIONS + 1,
): Promise<void> {
  await storage.put(KEYS.workflow(workflowId), encode(createWorkflowState(workflowId, updatedAt)));
  await storage.put(KEYS.terminalWorkflow(updatedAt, workflowId), new Uint8Array());
  for (let index = 0; index < count; index += 1) {
    const step = String(index).padStart(10, '0');
    await storage.put(`wf:${workflowId}:ckpt:${step}`, new Uint8Array([1]));
    await storage.put(`ev:${workflowId}:${step}`, new Uint8Array([1]));
  }
}

/** Assert every key a purge owns for `workflowId` is gone. */
async function expectRunFullyPurged(storage: MemoryStorage, workflowId: string): Promise<void> {
  expect(await storageCount(storage, `wf:${workflowId}:`)).toBe(0);
  expect(await storageCount(storage, `ev:${workflowId}:`)).toBe(0);
  expect(await storage.get(KEYS.workflow(workflowId))).toBeNull();
  // The terminal index entry is gone, so the run is no longer selected by future sweeps.
  let terminalEntries = 0;
  for await (const [key] of storage.scan(KEYS.terminalWorkflowPrefix())) {
    if (key.endsWith(workflowId)) terminalEntries += 1;
  }
  expect(terminalEntries).toBe(0);
}

function createWorkflowState(
  workflowId: string,
  updatedAt: number,
  overrides: Partial<WorkflowState> = {},
): WorkflowState {
  return {
    createdAt: updatedAt,
    id: workflowId,
    input: null,
    result: 'done',
    startedAt: updatedAt,
    status: 'completed',
    type: 'workflow',
    updatedAt,
    versionTuple: { workflowVersion: '1' },
    ...overrides,
  };
}

function createInternals(
  storage: MemoryStorage,
  now = 10_000,
  retention: { completed?: number } | undefined = undefined,
) {
  return {
    checkpoints: new Map(),
    deposed: false,
    eventLogHeads: new Map(),
    handleCache: new Map(),
    heartbeatDetails: new Map(),
    lastHeartbeatDetailsByStep: new Map(),
    options: {
      getNow: () => now,
      ownershipMode: 'none',
      retention,
    },
    pendingAsyncActivities: new Map(),
    pendingAsyncActivityResolutions: new Map(),
    registrations: new Map(),
    resultResolvers: new Map(),
    storage,
    workflowHeaders: new Map(),
    workflowNestingDepths: new Map(),
    workflowTypeByWorkflowId: new Map(),
    workflowVersionTuples: new Map(),
  } as never;
}

describe('bulk purge helpers', () => {
  it('removes pending async activities for the purged workflow only', () => {
    const storage = new MemoryStorage();
    const internals = createInternals(storage) as {
      pendingAsyncActivities: Map<string, { workflowId: string }>;
    };

    internals.pendingAsyncActivities.set('token-a', { workflowId: 'purged-workflow' });
    internals.pendingAsyncActivities.set('token-b', { workflowId: 'other-workflow' });

    clearPurgedWorkflowInMemoryState(internals as never, 'purged-workflow', () => {});

    expect(internals.pendingAsyncActivities.has('token-a')).toBe(false);
    expect(internals.pendingAsyncActivities.has('token-b')).toBe(true);
  });

  it('applies the smaller of the filter limit and fallback limit during purge', async () => {
    const storage = new MemoryStorage();
    const internals = createInternals(storage);

    for (const [index, workflowId] of ['purge-a', 'purge-b', 'purge-c'].entries()) {
      const updatedAt = 1_000 + index;
      await storage.put(
        KEYS.workflow(workflowId),
        encode(createWorkflowState(workflowId, updatedAt)),
      );
      await storage.put(KEYS.terminalWorkflow(updatedAt, workflowId), new Uint8Array());
    }

    const result = await purgeInternal(
      internals,
      { status: 'completed', limit: 2 },
      { expiredOnly: false, now: 10_000, limit: 1 },
      () => {},
    );

    expect(result).toEqual({ deleted: 1 });
  });

  it('deletes workflow-linked fleet events during purge', async () => {
    const storage = new MemoryStorage();
    const internals = createInternals(storage);
    const purgedWorkflowId = 'purge-fleet-event';
    await storage.put(
      KEYS.workflow(purgedWorkflowId),
      encode(createWorkflowState(purgedWorkflowId, 1_000)),
    );
    await storage.put(KEYS.terminalWorkflow(1_000, purgedWorkflowId), new Uint8Array());
    await storage.put(
      KEYS.fleetEvent(0),
      encode({
        kind: 'workflow:completed',
        workflowId: purgedWorkflowId,
        sequence: 0,
        cursor: '0',
        emittedAtMs: 1_000,
        payload: { workflowId: purgedWorkflowId, result: 'secret' },
      }),
    );
    await storage.put(KEYS.fleetEventByWorkflow(purgedWorkflowId, 0), new Uint8Array());
    await storage.put(
      KEYS.fleetEvent(1),
      encode({
        kind: 'workflow:completed',
        workflowId: 'other-workflow',
        sequence: 1,
        cursor: '1',
        emittedAtMs: 1_001,
        payload: { workflowId: purgedWorkflowId, result: 'kept' },
      }),
    );
    await storage.put(KEYS.fleetEventByWorkflow('other-workflow', 1), new Uint8Array());
    await storage.put(KEYS.fleetEvent(2), Uint8Array.of(0xc1));

    const result = await purgeInternal(
      internals,
      { status: 'completed' },
      { expiredOnly: false, now: 10_000 },
      () => {},
    );

    expect(result).toEqual({ deleted: 1 });
    expect(await storage.get(KEYS.fleetEvent(0))).toBeNull();
    expect(await storage.get(KEYS.fleetEventByWorkflow(purgedWorkflowId, 0))).toBeNull();
    expect(await storage.get(KEYS.fleetEvent(1))).not.toBeNull();
    expect(await storage.get(KEYS.fleetEventByWorkflow('other-workflow', 1))).not.toBeNull();
    expect(await storage.get(KEYS.fleetEvent(2))).not.toBeNull();
  });

  it('collects deadline, terminal-cleanup, and update-response delete keys', async () => {
    const storage = new MemoryStorage();
    const internals = createInternals(storage);
    const state = createWorkflowState('purge-delete-keys', 2_000, {
      executionDeadline: 2_500,
      status: 'cancelled',
      terminalCleanupToken: 'cleanup-token',
    });

    await storage.put(KEYS.update(state.id, 'update-a'), encode({ updateId: 'update-a' }));
    await storage.put(KEYS.update(state.id, ''), encode({ updateId: '' }));

    const operations = await collectWorkflowPurgeDeleteOperations(internals, state);
    const deleteKeys = new Set(
      operations
        .filter((operation) => operation.type === 'delete')
        .map((operation) => operation.key),
    );
    const terminalCleanupKey = KEYS.terminalCleanup(
      state.updatedAt + 60_000,
      createTerminalCleanupTimerId(true, state.terminalCleanupToken!),
    );

    expect(deleteKeys.has(KEYS.deadline(state.executionDeadline!, state.id))).toBe(true);
    expect(deleteKeys.has(`timer-idx:deadline:${state.id}`)).toBe(true);
    expect(deleteKeys.has(terminalCleanupKey)).toBe(true);
    expect(deleteKeys.has(KEYS.update(state.id, 'update-a'))).toBe(true);
    expect(deleteKeys.has(KEYS.updateResponse('update-a'))).toBe(true);
    expect(deleteKeys.has(KEYS.updateResponse(''))).toBe(false);
    expect(deleteKeys.has(KEYS.teardownSucceeded(state.id))).toBe(true);
    expect(deleteKeys.has(KEYS.teardownDeadLetter(state.id))).toBe(false);
  });

  it('purges a run larger than MAX_BATCH_OPERATIONS on a native range-delete adapter', async () => {
    const storage = new CapEnforcingMemoryStorage();
    const internals = createInternals(storage);
    const workflowId = 'oversized-native';
    await seedOversizedRun(storage, workflowId, 1_000);

    // Sanity: the run alone exceeds one batch, so the pre-fix single-batch purge
    // would throw StorageBatchOperationLimitExceededError here.
    expect(await storageCount(storage, `wf:${workflowId}:ckpt:`)).toBeGreaterThan(
      MAX_BATCH_OPERATIONS,
    );

    const result = await purgeInternal(
      internals,
      { status: 'completed' },
      { expiredOnly: false, now: 10_000 },
      () => {},
    );

    expect(result).toEqual({ deleted: 1 });
    await expectRunFullyPurged(storage, workflowId);
  });

  it('purges a run larger than MAX_BATCH_OPERATIONS on a non-native (fallback) adapter', async () => {
    // A non-native adapter (like NodeSQLiteStorage) reports boundedRangeDelete:
    // false and routes deletePrefix through the cap-chunked derived fallback.
    // better-sqlite3's native bindings do not load under Bun's test runner, so
    // this stripped MemoryStorage exercises the identical fallback code path.
    const storage = createNonNativeStorage();
    const internals = createInternals(storage);
    const workflowId = 'oversized-fallback';
    await seedOversizedRun(storage, workflowId, 1_000);

    const result = await purgeInternal(
      internals,
      { status: 'completed' },
      { expiredOnly: false, now: 10_000 },
      () => {},
    );

    expect(result).toEqual({ deleted: 1 });
    await expectRunFullyPurged(storage, workflowId);
  });

  it('purges runs behind an oversized run without a batch cap aborting the sweep', async () => {
    // Three expired runs, oldest first. The oldest is oversized. Before the fix
    // it threw and aborted the whole sweep, leaving the two newer runs stranded.
    const storage = new CapEnforcingMemoryStorage();
    const internals = createInternals(storage, 10_000, { completed: 1 });

    const oversizedId = 'sweep-oversized';
    await seedOversizedRun(storage, oversizedId, 1_000, MAX_BATCH_OPERATIONS + 1);
    for (const [index, workflowId] of ['sweep-b', 'sweep-c'].entries()) {
      const updatedAt = 2_000 + index;
      await storage.put(KEYS.workflow(workflowId), encode(createWorkflowState(workflowId, updatedAt)));
      await storage.put(KEYS.terminalWorkflow(updatedAt, workflowId), new Uint8Array());
    }

    const result = await purgeInternal(
      internals,
      undefined,
      { expiredOnly: true, now: 10_000 },
      () => {},
    );

    expect(result).toEqual({ deleted: 3 });
    await expectRunFullyPurged(storage, oversizedId);
    expect(await storage.get(KEYS.workflow('sweep-b'))).toBeNull();
    expect(await storage.get(KEYS.workflow('sweep-c'))).toBeNull();
  });

  it('isolates a failing run and continues, reporting it via failed and onWorkflowPurgeError', async () => {
    const storage = new CapEnforcingMemoryStorage();
    const internals = createInternals(storage, 10_000, { completed: 1 });

    // Make the FIRST run's fenced remainder commit fail (simulate a storage
    // fault on the decisive commit). The sweep must still purge the run behind it.
    for (const [index, workflowId] of ['fail-a', 'ok-b'].entries()) {
      const updatedAt = 1_000 + index;
      await storage.put(KEYS.workflow(workflowId), encode(createWorkflowState(workflowId, updatedAt)));
      await storage.put(KEYS.terminalWorkflow(updatedAt, workflowId), new Uint8Array());
    }
    const originalBatch = storage.batch.bind(storage);
    storage.batch = async (operations: BatchOperation[]) => {
      if (operations.some((op) => op.key === KEYS.workflow('fail-a'))) {
        throw new Error('injected storage fault');
      }
      await originalBatch(operations);
    };

    const failedIds: string[] = [];
    const result = await purgeInternal(
      internals,
      undefined,
      {
        expiredOnly: true,
        now: 10_000,
        onWorkflowPurgeError: (workflowId) => failedIds.push(workflowId),
      },
      () => {},
    );

    expect(result).toEqual({ deleted: 1, failed: 1 });
    expect(failedIds).toEqual(['fail-a']);
    expect(await storage.get(KEYS.workflow('ok-b'))).toBeNull();
    // The failed run is untouched by its own failed commit AND still terminal +
    // listed, so a later sweep can re-purge it.
    expect(await storage.get(KEYS.workflow('fail-a'))).not.toBeNull();
    expect(await storage.get(KEYS.terminalWorkflow(1_000, 'fail-a'))).not.toBeNull();
  });

  it('leaves a re-purgeable terminal run with no orphans when interrupted after history delete', async () => {
    const storage = new CapEnforcingMemoryStorage();
    const internals = createInternals(storage);
    const workflowId = 'interrupted';
    await seedOversizedRun(storage, workflowId, 1_000, 5);
    // Give the run a deadline timer, so we can prove no orphan index/timer rows
    // survive without their state row.
    const state = createWorkflowState(workflowId, 1_000, { executionDeadline: 9_999 });
    await storage.put(KEYS.workflow(workflowId), encode(state));
    await storage.put(KEYS.deadline(9_999, workflowId), new Uint8Array());
    await storage.put(`timer-idx:deadline:${workflowId}`, new Uint8Array());

    // Interrupt Phase B (the fenced remainder commit that carries the state row).
    const originalBatch = storage.batch.bind(storage);
    let interrupted = false;
    storage.batch = async (operations: BatchOperation[]) => {
      if (!interrupted && operations.some((op) => op.key === KEYS.workflow(workflowId))) {
        interrupted = true;
        throw new Error('interrupted before final commit');
      }
      await originalBatch(operations);
    };

    await expect(purgeWorkflow(internals, state, () => {})).rejects.toThrow(
      'interrupted before final commit',
    );

    // History (Phase A) is gone, but the state row + terminal index remain, so
    // the run is still terminal, still listed, and re-purgeable. No orphan timer
    // or index rows survived without the state row (they live in Phase B beside it).
    expect(await storageCount(storage, `wf:${workflowId}:ckpt:`)).toBe(0);
    expect(await storageCount(storage, `ev:${workflowId}:`)).toBe(0);
    expect(await storage.get(KEYS.workflow(workflowId))).not.toBeNull();
    expect(await storage.get(KEYS.terminalWorkflow(1_000, workflowId))).not.toBeNull();
    expect(await storage.get(KEYS.deadline(9_999, workflowId))).not.toBeNull();

    // Re-purge (restore the real batch) drives the run fully to zero.
    storage.batch = originalBatch;
    await purgeWorkflow(internals, state, () => {});
    await expectRunFullyPurged(storage, workflowId);
    expect(await storage.get(KEYS.deadline(9_999, workflowId))).toBeNull();
    expect(await storage.get(`timer-idx:deadline:${workflowId}`)).toBeNull();
  });

  it('surfaces lost lease preconditions while purging a workflow', async () => {
    const storage = new MemoryStorage();
    const epochBytes = encodeEpoch(1);
    const state = createWorkflowState('purge-precondition-loss', 2_000);
    await storage.put(KEYS.leaseEpoch(), epochBytes);
    storage.conditionalBatch = async () => false;
    const internals = createInternals(storage) as {
      deposed: boolean;
      leaseManager?: { currentEpochBytes: () => Uint8Array } | null;
      options: { getNow: () => number; ownershipMode: 'none' | 'lease'; retention?: undefined };
      storage: MemoryStorage;
      tearDownAfterDeposition?: null;
    };
    internals.leaseManager = { currentEpochBytes: () => epochBytes };
    internals.options = {
      getNow: () => 10_000,
      ownershipMode: 'lease',
      retention: undefined,
    };
    internals.tearDownAfterDeposition = null;

    await expect(purgeWorkflow(internals as never, state, () => {})).rejects.toThrow(
      `Purge commit for workflow "${state.id}" lost its precondition.`,
    );
  });
});
