import { describe, expect, it, mock } from 'bun:test';

import { KEYS } from '../../storage/interface.ts';
import { MemoryStorage } from '../../storage/memory.ts';
import { serializeCheckpoint } from '../checkpoint/serialization.ts';
import { encode } from '../codec.ts';
import type { Checkpoint, WorkflowState } from '../types.ts';
import {
  createInitialWorkflowState,
  launchWorkflowFromCheckpoint,
  processPendingUpdatesAfterReplay,
  resolveScheduledStartAt,
  resumeWorkflowFromStorage,
} from './lifecycle.ts';

function createLifecycleCallbacks(overrides: Record<string, unknown> = {}) {
  return {
    createWorkflowHandleWithResultPromise: (workflowId: string) => ({ id: workflowId }),
    dispatchEvent: mock(() => {}),
    getComposedWorkflowInterceptor: () => null,
    getHandle: (workflowId: string) => ({ id: workflowId }),
    handleCleanupError: mock(() => {}),
    hasLocalCheckpointOwnership: () => false,
    isInlineWorkflowLocallyOwned: () => false,
    processPendingUpdatesAfterInlineAdvance: async () => {},
    processPendingUpdatesForHandlers: async () => {},
    processPendingUpdatesAfterReplay: () => {},
    queueInlineWorkflowExecutionStart: () => {},
    resolveWorkflowTypeTarget: (target: string | Function) =>
      typeof target === 'string' ? target : target.name,
    runSerializedWorkflowStateWrite: async <Result>(
      _workflowId: string,
      writeOperation: () => Promise<Result>,
    ) => writeOperation(),
    swallowPromiseRejection: async (promise: Promise<unknown> | undefined) => {
      await promise;
    },
    ...overrides,
  };
}

function createCheckpoint(workflowId: string, overrides: Partial<Checkpoint> = {}): Checkpoint {
  return {
    workflowId,
    step: overrides.step ?? 0,
    locals: overrides.locals ?? {},
    accumulatedResults: overrides.accumulatedResults ?? [],
    pendingSignals: overrides.pendingSignals ?? [],
    searchAttributes: overrides.searchAttributes ?? {},
    version: overrides.version ?? '1',
    schemaVersion: overrides.schemaVersion ?? 2,
    createdAt: overrides.createdAt ?? 1_000,
  };
}

function createWorkflowState(
  workflowId: string,
  overrides: Partial<WorkflowState> = {},
): WorkflowState {
  return {
    id: workflowId,
    type: overrides.type ?? 'workflow',
    status: overrides.status ?? 'running',
    input: overrides.input ?? { value: 1 },
    version: overrides.version ?? '1',
    executionStateOwnerId: overrides.executionStateOwnerId ?? workflowId,
    createdAt: overrides.createdAt ?? 1_000,
    startedAt: overrides.startedAt ?? 1_000,
    updatedAt: overrides.updatedAt ?? 1_000,
    ...overrides,
  };
}

describe('engine lifecycle coverage helpers', () => {
  it('resolveScheduledStartAt rejects startAfter values that overflow the storage timestamp range', () => {
    expect(() =>
      resolveScheduledStartAt(
        {} as never,
        { startAfter: Number.MAX_SAFE_INTEGER },
        Number.MAX_SAFE_INTEGER,
        createLifecycleCallbacks() as never,
      ),
    ).toThrow('options.startAfter must resolve to a finite, non-negative start time');
  });

  it('createInitialWorkflowState rejects executionTimeout values that overflow the storage timestamp range', () => {
    expect(() =>
      createInitialWorkflowState(
        {
          options: { getNow: () => Number.MAX_SAFE_INTEGER },
        } as never,
        'workflow-timeout-overflow',
        'workflow',
        null,
        { workflowVersion: '1' },
        { executionTimeout: Number.MAX_SAFE_INTEGER },
        undefined,
        undefined,
        'workflow-timeout-overflow',
        undefined,
        createLifecycleCallbacks() as never,
      ),
    ).toThrow('options.executionTimeout must resolve to a finite, non-negative deadline');
  });

  it('processPendingUpdatesAfterReplay routes handler failures through cleanup handling', async () => {
    const error = new Error('pending-update cleanup failed');
    const handleCleanupError = mock(() => {});

    await processPendingUpdatesAfterReplay({} as never, 'workflow-pending-update', {
      handleCleanupError,
      processPendingUpdatesForHandlers: async () => {
        throw error;
      },
    });

    expect(handleCleanupError).toHaveBeenCalledWith(
      'processPendingUpdates',
      error,
      'workflow-pending-update',
    );
  });

  it('launchWorkflowFromCheckpoint starts worker-mode workflows with headers, tenant, and deadlines', () => {
    const startWorkflow = mock(() => {});
    const dispatchEvent = mock(() => {});
    const internals = {
      agentWorkflowIds: new Set<string>(),
      checkpoints: new Map<string, Checkpoint>(),
      inlineStrategy: null,
      registrations: new Map(),
      strategy: { startWorkflow },
      workflowHeaders: new Map([['workflow-worker-launch', new Map([['x-test', '1']])]]),
      workflowVersionTuples: new Map(),
    };
    const checkpoint = createCheckpoint('workflow-worker-launch', {
      searchAttributes: { env: 'test' },
      createdAt: 4_000,
    });
    const state = createWorkflowState('workflow-worker-launch', {
      executionDeadline: 9_000,
      tenant: { id: 'tenant-a' },
      type: 'worker-launch',
    });
    const handle = { id: 'workflow-worker-launch' };

    const returnedHandle = launchWorkflowFromCheckpoint(
      internals as never,
      state.id,
      state,
      checkpoint,
      {
        handler: async function* () {
          return 'done';
        },
        version: '1',
      } as never,
      createLifecycleCallbacks({
        createWorkflowHandleWithResultPromise: () => handle,
        dispatchEvent,
      }) as never,
    );

    expect(returnedHandle.id).toBe(handle.id);
    expect(internals.checkpoints.get(state.id)).toEqual(checkpoint);
    expect(internals.workflowVersionTuples.get(state.id)).toEqual({ workflowVersion: '1' });
    expect(startWorkflow).toHaveBeenCalledWith(
      expect.objectContaining({
        checkpoint: serializeCheckpoint(checkpoint),
        deadline: 9_000,
        executionStateOwnerId: state.id,
        headers: [['x-test', '1']],
        input: state.input,
        tenant: { id: 'tenant-a' },
        workflowId: state.id,
        workflowType: 'worker-launch',
      }),
    );
    expect(dispatchEvent).toHaveBeenCalledTimes(1);
  });

  it('resumeWorkflowFromStorage rejects non-running stored states before loading a checkpoint', async () => {
    const storage = new MemoryStorage();
    const workflowId = 'workflow-resume-completed';

    await storage.put(
      KEYS.workflow(workflowId),
      encode(createWorkflowState(workflowId, { status: 'completed' })),
    );

    await expect(
      resumeWorkflowFromStorage(
        {
          registrations: new Map(),
          storage,
        } as never,
        workflowId,
        true,
        createLifecycleCallbacks() as never,
      ),
    ).rejects.toThrow('Cannot resume workflow "workflow-resume-completed": status is "completed"');
  });

  it('resumeWorkflowFromStorage rejects running states whose workflow type is no longer registered', async () => {
    const storage = new MemoryStorage();
    const workflowId = 'workflow-resume-missing-registration';

    await storage.put(KEYS.workflow(workflowId), encode(createWorkflowState(workflowId)));
    await storage.put(
      KEYS.checkpoint(workflowId),
      serializeCheckpoint(createCheckpoint(workflowId)),
    );

    await expect(
      resumeWorkflowFromStorage(
        {
          registrations: new Map(),
          storage,
        } as never,
        workflowId,
        true,
        createLifecycleCallbacks() as never,
      ),
    ).rejects.toThrow(
      'No workflow registered with name "workflow" (needed to resume "workflow-resume-missing-registration")',
    );
  });

  it('resumeWorkflowFromStorage replays worker-mode workflows through the execution strategy', async () => {
    const storage = new MemoryStorage();
    const workflowId = 'workflow-resume-worker-mode';
    const startWorkflow = mock(() => {});
    const dispatchEvent = mock(() => {});
    const workflowState = createWorkflowState(workflowId, {
      executionDeadline: 15_000,
      tenant: { id: 'tenant-b' },
      type: 'worker-resume',
    });
    const checkpoint = createCheckpoint(workflowId, {
      searchAttributes: { region: 'us-west-2' },
      createdAt: 5_000,
      step: 3,
    });

    await storage.put(KEYS.workflow(workflowId), encode(workflowState));
    await storage.put(KEYS.checkpoint(workflowId), serializeCheckpoint(checkpoint));
    await storage.put(KEYS.workflowHeaders(workflowId), encode([['traceparent', '00-test']]));
    await storage.put(KEYS.terminalCleanupNeeded(workflowId), new Uint8Array());

    const handle = { id: workflowId };
    const internals = {
      agentWorkflowIds: new Set<string>(),
      checkpoints: new Map<string, Checkpoint>(),
      eventLogHeads: new Map(),
      inlineStrategy: null,
      options: { development: false, getNow: () => 20_000 },
      parkedInlineWorkflows: new Set<string>(),
      registrations: new Map([
        [
          'worker-resume',
          {
            handler: async function* () {
              return 'done';
            },
            version: '1',
          },
        ],
      ]),
      storage,
      strategy: { startWorkflow },
      terminalizingWorkflows: new Set<string>(),
      workflowHeaders: new Map<string, Map<string, string>>(),
      workflowNestingDepths: new Map([[workflowId, 2]]),
      workflowVersionTuples: new Map<string, { workflowVersion: string }>(),
      workflowsNeedingTerminalCleanup: new Set<string>(),
    };

    const resumedHandle = await resumeWorkflowFromStorage(
      internals as never,
      workflowId,
      true,
      createLifecycleCallbacks({
        dispatchEvent,
        getHandle: () => handle,
      }) as never,
    );

    expect(resumedHandle.id).toBe(handle.id);
    expect(internals.checkpoints.get(workflowId)).toEqual(checkpoint);
    expect(internals.workflowVersionTuples.get(workflowId)).toEqual({ workflowVersion: '1' });
    expect(internals.workflowHeaders.get(workflowId)).toEqual(
      new Map([['traceparent', '00-test']]),
    );
    expect(internals.workflowsNeedingTerminalCleanup.has(workflowId)).toBe(true);
    expect(startWorkflow).toHaveBeenCalledWith(
      expect.objectContaining({
        checkpoint: serializeCheckpoint(checkpoint),
        deadline: 15_000,
        executionStateOwnerId: workflowId,
        headers: [['traceparent', '00-test']],
        input: workflowState.input,
        nestingDepth: 2,
        tenant: { id: 'tenant-b' },
        workflowId,
        workflowType: 'worker-resume',
      }),
    );
    expect(dispatchEvent).toHaveBeenCalledTimes(1);
  });
});
