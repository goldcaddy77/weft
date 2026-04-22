import { describe, expect, it } from 'bun:test';

import {
  encodeStorageKeyComponent,
  KEYS,
  type BatchOperation,
  type ScanOptions,
} from '../storage/interface.ts';
import { MemoryStorage } from '../storage/memory.ts';
import { BULK_WORKFLOW_FILTER_ERROR_MESSAGE } from './bulk-workflow-filter.ts';
import { Context } from './context.ts';
import { Engine } from './engine.ts';
import type { WorkflowContext, WorkflowState } from './types.ts';

async function* echoWorkflow(_ctx: WorkflowContext, input: unknown) {
  return input;
}

async function* waitForSignalWorkflow(ctx: WorkflowContext, input: unknown) {
  const signal = yield* (ctx as Context).waitForSignal<string>('continue');
  return `${String(input)}:${signal}`;
}

async function* failingWorkflow(_ctx: WorkflowContext, _input: unknown) {
  throw new Error('bulk failure');
}

async function waitForCondition(
  predicate: () => Promise<boolean>,
  message: string,
  timeoutMilliseconds = 500,
): Promise<void> {
  const deadline = Date.now() + timeoutMilliseconds;

  while (Date.now() < deadline) {
    if (await predicate()) {
      return;
    }

    await Bun.sleep(5);
  }

  throw new Error(message);
}

async function waitForWorkflowStatus(
  engine: Engine,
  workflowId: string,
  status: WorkflowState['status'],
): Promise<void> {
  await waitForCondition(async () => {
    const state = await engine.get(workflowId);
    return state?.status === status;
  }, `Expected workflow "${workflowId}" to reach ${status}`);
}

async function createCompletedWorkflow(
  engine: Engine,
  workflowId: string,
  tags?: string[],
): Promise<void> {
  const handle = await engine.start('echo', workflowId, { id: workflowId, ...(tags && { tags }) });
  await handle.result();
}

class BulkCancelFailureStorage extends MemoryStorage {
  shouldFail = false;
  workflowIdToFail: string | null = null;

  override async batch(operations: BatchOperation[]): Promise<void> {
    if (
      this.shouldFail &&
      this.workflowIdToFail !== null &&
      operations.some(
        (operation) =>
          operation.type === 'put' && operation.key === KEYS.workflow(this.workflowIdToFail!),
      )
    ) {
      throw new Error(`simulated bulk cancellation failure for ${this.workflowIdToFail}`);
    }

    await super.batch(operations);
  }
}

class BulkBatchTrackingStorage extends MemoryStorage {
  shouldTrackBulkMutations = false;
  scannedTopLevelWorkflowStateEntries = 0;
  firstMutationSeenAfterScanningCount: number | null = null;

  override async *scan(
    prefix: string,
    options: ScanOptions = {},
  ): AsyncIterable<[string, Uint8Array]> {
    for await (const entry of super.scan(prefix, options)) {
      const [key] = entry;
      if (prefix === 'wf:' && key.startsWith('wf:') && !key.slice('wf:'.length).includes(':')) {
        this.scannedTopLevelWorkflowStateEntries += 1;
      }
      yield entry;
    }
  }

  override async batch(operations: BatchOperation[]): Promise<void> {
    const mutatesTopLevelWorkflowState =
      this.shouldTrackBulkMutations &&
      operations.some(
        (operation) =>
          operation.key.startsWith('wf:') && !operation.key.slice('wf:'.length).includes(':'),
      );

    if (mutatesTopLevelWorkflowState && this.firstMutationSeenAfterScanningCount === null) {
      this.firstMutationSeenAfterScanningCount = this.scannedTopLevelWorkflowStateEntries;
    }

    await super.batch(operations);
  }
}

class BulkSignalFailureStorage extends MemoryStorage {
  workflowIdToFail: string | null = null;

  override async put(key: string, value: Uint8Array): Promise<void> {
    if (
      this.workflowIdToFail !== null &&
      key.startsWith(`sig:${encodeStorageKeyComponent(this.workflowIdToFail)}:`)
    ) {
      throw new Error(`simulated bulk signal failure for ${this.workflowIdToFail}`);
    }

    await super.put(key, value);
  }
}

describe('bulk workflow operations', () => {
  it('acceptance criterion: engine.cancelAll(filter) cancels matching workflows and reports per-workflow failures', async () => {
    const storage = new BulkCancelFailureStorage();
    const engine = new Engine({ storage });
    engine.register('wait-for-signal', waitForSignalWorkflow);

    try {
      await engine.start('wait-for-signal', 'one', {
        id: 'bulk-cancel-success-a',
        tags: ['bulk-cancel'],
      });
      await engine.start('wait-for-signal', 'two', {
        id: 'bulk-cancel-failure',
        tags: ['bulk-cancel'],
      });
      await engine.start('wait-for-signal', 'three', {
        id: 'bulk-cancel-success-b',
        tags: ['bulk-cancel'],
      });

      await Promise.all([
        waitForWorkflowStatus(engine, 'bulk-cancel-success-a', 'running'),
        waitForWorkflowStatus(engine, 'bulk-cancel-failure', 'running'),
        waitForWorkflowStatus(engine, 'bulk-cancel-success-b', 'running'),
      ]);

      storage.workflowIdToFail = 'bulk-cancel-failure';
      storage.shouldFail = true;

      const result = await engine.cancelAll({ tags: ['bulk-cancel'] });

      expect(result.cancelled).toBe(2);
      expect(result.failed).toBe(1);
      expect(result.errors).toEqual([
        {
          id: 'bulk-cancel-failure',
          error: 'simulated bulk cancellation failure for bulk-cancel-failure',
        },
      ]);
      const firstCancelledState = await engine.get('bulk-cancel-success-a');
      const secondCancelledState = await engine.get('bulk-cancel-success-b');
      const failedState = await engine.get('bulk-cancel-failure');
      expect(firstCancelledState?.status).toBe('cancelled');
      expect(secondCancelledState?.status).toBe('cancelled');
      expect(failedState?.status).toBe('running');
    } finally {
      await engine[Symbol.asyncDispose]();
    }
  });

  it('acceptance criterion: engine.signalAll(filter, name, payload) signals all matching workflows', async () => {
    const engine = new Engine({ storage: new MemoryStorage() });
    engine.register('wait-for-signal', waitForSignalWorkflow);

    try {
      const firstHandle = await engine.start('wait-for-signal', 'first', {
        id: 'bulk-signal-first',
        tags: ['bulk-signal'],
      });
      const secondHandle = await engine.start('wait-for-signal', 'second', {
        id: 'bulk-signal-second',
        tags: ['bulk-signal'],
      });
      const untouchedHandle = await engine.start('wait-for-signal', 'other', {
        id: 'bulk-signal-other',
        tags: ['not-targeted'],
      });

      await Promise.all([
        waitForWorkflowStatus(engine, firstHandle.id, 'running'),
        waitForWorkflowStatus(engine, secondHandle.id, 'running'),
        waitForWorkflowStatus(engine, untouchedHandle.id, 'running'),
      ]);

      const result = await engine.signalAll({ tags: ['bulk-signal'] }, 'continue', 'released');

      expect(result).toEqual({ signalled: 2, failed: 0 });
      await expect(firstHandle.result()).resolves.toBe('first:released');
      await expect(secondHandle.result()).resolves.toBe('second:released');
      const untouchedState = await engine.get(untouchedHandle.id);
      expect(untouchedState?.status).toBe('running');

      await engine.signal(untouchedHandle.id, 'continue', 'cleanup');
      await expect(untouchedHandle.result()).resolves.toBe('other:cleanup');
    } finally {
      await engine[Symbol.asyncDispose]();
    }
  });

  it('tracks failed signals when one matching workflow cannot be signalled', async () => {
    const storage = new BulkSignalFailureStorage();
    const engine = new Engine({ storage });
    engine.register('wait-for-signal', waitForSignalWorkflow);

    try {
      const firstHandle = await engine.start('wait-for-signal', 'first', {
        id: 'bulk-signal-success-a',
        tags: ['bulk-signal-failure'],
      });
      const failedHandle = await engine.start('wait-for-signal', 'second', {
        id: 'bulk-signal-failure',
        tags: ['bulk-signal-failure'],
      });
      const thirdHandle = await engine.start('wait-for-signal', 'third', {
        id: 'bulk-signal-success-b',
        tags: ['bulk-signal-failure'],
      });

      await Promise.all([
        waitForWorkflowStatus(engine, firstHandle.id, 'running'),
        waitForWorkflowStatus(engine, failedHandle.id, 'running'),
        waitForWorkflowStatus(engine, thirdHandle.id, 'running'),
      ]);

      storage.workflowIdToFail = failedHandle.id;

      const result = await engine.signalAll(
        { tags: ['bulk-signal-failure'] },
        'continue',
        'released',
      );

      expect(result).toEqual({ signalled: 2, failed: 1 });
      await expect(firstHandle.result()).resolves.toBe('first:released');
      await expect(thirdHandle.result()).resolves.toBe('third:released');
      const failedState = await engine.get(failedHandle.id);
      expect(failedState?.status).toBe('running');

      storage.workflowIdToFail = null;
      await engine.signal(failedHandle.id, 'continue', 'cleanup');
      await expect(failedHandle.result()).resolves.toBe('second:cleanup');
    } finally {
      await engine[Symbol.asyncDispose]();
    }
  });

  it('bulk operations honor the limit and offset fields from the list filter shape', async () => {
    const now = 2_000;
    const engine = new Engine({
      storage: new MemoryStorage(),
      getNow: () => now,
    });
    engine.register('echo', echoWorkflow);

    try {
      for (const workflowId of ['bulk-window-01', 'bulk-window-02', 'bulk-window-03']) {
        await engine.start('echo', workflowId, {
          id: workflowId,
          startAt: now + 60_000,
        });
      }

      const result = await engine.cancelAll({
        status: 'pending',
        offset: 1,
        limit: 1,
      });

      expect(result.cancelled).toBe(1);
      const firstWindowState = await engine.get('bulk-window-01');
      const secondWindowState = await engine.get('bulk-window-02');
      const thirdWindowState = await engine.get('bulk-window-03');
      expect(firstWindowState?.status).toBe('pending');
      expect(secondWindowState?.status).toBe('cancelled');
      expect(thirdWindowState?.status).toBe('pending');
    } finally {
      await engine[Symbol.asyncDispose]();
    }
  });

  it('applies limit and offset after narrowing to actionable statuses for cancellation', async () => {
    const engine = new Engine({ storage: new MemoryStorage() });
    engine.register('echo', echoWorkflow);
    engine.register('wait-for-signal', waitForSignalWorkflow);

    try {
      await createCompletedWorkflow(engine, 'bulk-pagination-01-completed', ['bulk-pagination']);
      await engine.start('wait-for-signal', 'running', {
        id: 'bulk-pagination-02-running',
        tags: ['bulk-pagination'],
      });

      await waitForWorkflowStatus(engine, 'bulk-pagination-02-running', 'running');

      const result = await engine.cancelAll({
        tags: ['bulk-pagination'],
        limit: 1,
      });

      expect(result.cancelled).toBe(1);
      const completedState = await engine.get('bulk-pagination-01-completed');
      const runningState = await engine.get('bulk-pagination-02-running');
      expect(completedState?.status).toBe('completed');
      expect(runningState?.status).toBe('cancelled');
    } finally {
      await engine[Symbol.asyncDispose]();
    }
  });

  it('acceptance criterion: engine.deleteAll(filter) deletes matching terminal workflows and rejects when running workflows would match', async () => {
    const engine = new Engine({ storage: new MemoryStorage() });
    engine.register('echo', echoWorkflow);
    engine.register('wait-for-signal', waitForSignalWorkflow);
    engine.register('failing', failingWorkflow);

    try {
      await createCompletedWorkflow(engine, 'bulk-delete-completed', ['bulk-delete']);

      const failedHandle = await engine.start('failing', null, {
        id: 'bulk-delete-failed',
        tags: ['bulk-delete'],
      });
      await failedHandle.result().catch(() => {});

      const runningHandle = await engine.start('wait-for-signal', 'payload', {
        id: 'bulk-delete-running',
        tags: ['bulk-delete'],
      });
      await waitForWorkflowStatus(engine, runningHandle.id, 'running');

      await expect(engine.deleteAll({ tags: ['bulk-delete'] })).rejects.toThrow(
        'Bulk delete matches non-terminal workflows',
      );

      expect(await engine.get('bulk-delete-completed')).not.toBeNull();
      expect(await engine.get('bulk-delete-failed')).not.toBeNull();
      expect(await engine.get('bulk-delete-running')).not.toBeNull();

      await engine.cancel(runningHandle.id);
      await runningHandle.result().catch(() => {});

      const result = await engine.deleteAll({
        tags: ['bulk-delete'],
        status: ['completed', 'failed', 'cancelled'],
      });

      expect(result).toEqual({ deleted: 3 });
      expect(await engine.get('bulk-delete-completed')).toBeNull();
      expect(await engine.get('bulk-delete-failed')).toBeNull();
      expect(await engine.get('bulk-delete-running')).toBeNull();
    } finally {
      await engine[Symbol.asyncDispose]();
    }
  });

  it('rejects unscoped bulk filters, including empty tags and attributes arrays', async () => {
    const engine = new Engine({ storage: new MemoryStorage() });

    try {
      await expect(engine.cancelAll({})).rejects.toThrow(BULK_WORKFLOW_FILTER_ERROR_MESSAGE);
      await expect(engine.cancelAll({ tags: [] })).rejects.toThrow(
        BULK_WORKFLOW_FILTER_ERROR_MESSAGE,
      );
      await expect(engine.cancelAll({ attributes: [] })).rejects.toThrow(
        BULK_WORKFLOW_FILTER_ERROR_MESSAGE,
      );
    } finally {
      await engine[Symbol.asyncDispose]();
    }
  });

  it('acceptance criterion: engine.tagAll(filter, tags) and engine.untagAll(filter, tags) bulk-modify workflow tags durably', async () => {
    const storage = new MemoryStorage();
    const engine = new Engine({ storage });
    engine.register('echo', echoWorkflow);

    try {
      await createCompletedWorkflow(engine, 'bulk-tags-first', ['selected']);
      await createCompletedWorkflow(engine, 'bulk-tags-second', ['selected']);
      await createCompletedWorkflow(engine, 'bulk-tags-other', ['other']);

      const tagResult = await engine.tagAll({ tags: ['selected'] }, ['bulk', 'selected']);
      expect(tagResult).toEqual({ modified: 2 });
      const firstTaggedState = await engine.get('bulk-tags-first');
      const secondTaggedState = await engine.get('bulk-tags-second');
      const otherTaggedState = await engine.get('bulk-tags-other');
      expect(firstTaggedState?.tags).toEqual(['bulk', 'selected']);
      expect(secondTaggedState?.tags).toEqual(['bulk', 'selected']);
      expect(otherTaggedState?.tags).toEqual(['other']);

      const untagResult = await engine.untagAll({ tags: ['bulk'] }, ['selected']);
      expect(untagResult).toEqual({ modified: 2 });
    } finally {
      await engine[Symbol.asyncDispose]();
    }

    const recoveredEngine = new Engine({ storage });
    recoveredEngine.register('echo', echoWorkflow);

    try {
      const recoveredFirstState = await recoveredEngine.get('bulk-tags-first');
      const recoveredSecondState = await recoveredEngine.get('bulk-tags-second');
      const recoveredOtherState = await recoveredEngine.get('bulk-tags-other');
      expect(recoveredFirstState?.tags).toEqual(['bulk']);
      expect(recoveredSecondState?.tags).toEqual(['bulk']);
      expect(recoveredOtherState?.tags).toEqual(['other']);
    } finally {
      await recoveredEngine[Symbol.asyncDispose]();
    }
  });

  it('acceptance criterion: bulk operations are batched internally in chunks of 1000 workflows', async () => {
    const now = 1_000;
    const storage = new BulkBatchTrackingStorage();
    const engine = new Engine({
      storage,
      getNow: () => now,
    });
    engine.register('echo', echoWorkflow);

    try {
      for (let index = 0; index < 1_005; index++) {
        await engine.start('echo', index, {
          id: `bulk-batch-${String(index)}`,
          startAt: now + 60_000,
        });
      }

      storage.shouldTrackBulkMutations = true;

      const result = await engine.cancelAll({ status: 'pending' });

      expect(result.cancelled).toBe(1_005);
      expect(storage.firstMutationSeenAfterScanningCount).toBe(1_000);
    } finally {
      await engine[Symbol.asyncDispose]();
    }
  });
});
