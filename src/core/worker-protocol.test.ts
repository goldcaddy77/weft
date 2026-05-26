import { describe, expect, it } from 'bun:test';

import type { ContextOperationRequest } from './context.ts';
import {
  MIN_WORKER_PROTOCOL_MESSAGE_BYTES,
  WORKER_REPLAY_SIGNATURE_FORMAT,
  WorkerProtocolError,
  WorkerProtocolMessageSizeError,
  assertWorkerOutboundMessageShape,
  assertWorkerProtocolMessageWithinLimit,
  createBoundedWorkerFailureMessage,
  createWorkerReplayOperationSignature,
  estimateWorkerProtocolMessageBytes,
} from './worker-protocol.ts';

describe('Worker protocol message accounting', () => {
  it('keeps the bounded failure envelope inside the minimum protocol limit', () => {
    const failure = createBoundedWorkerFailureMessage({
      workflowId: 'workflow-with-bounded-worker-failure',
      error: 'x'.repeat(10_000),
      failureCategory: 'resource',
      turnId: 17,
    });

    expect(estimateWorkerProtocolMessageBytes(failure)).toBeLessThanOrEqual(
      MIN_WORKER_PROTOCOL_MESSAGE_BYTES,
    );
  });

  it('counts binary payload bytes without requiring JSON-shaped messages', () => {
    const message = {
      type: 'checkpoint',
      workflowId: 'wf-binary',
      checkpoint: new Uint8Array(256),
      nested: {
        buffer: new ArrayBuffer(128),
      },
    };

    expect(estimateWorkerProtocolMessageBytes(message)).toBeGreaterThan(384);
    expect(() => assertWorkerProtocolMessageWithinLimit(message, 256)).toThrow(
      WorkerProtocolMessageSizeError,
    );
  });

  it('accepts messages whose encoded size exactly matches the configured limit', () => {
    const message = {
      type: 'completed',
      workflowId: 'wf-boundary',
      result: { value: 'ok' },
    };
    const messageBytes = estimateWorkerProtocolMessageBytes(message);

    expect(assertWorkerProtocolMessageWithinLimit(message, messageBytes)).toBe(messageBytes);
    expect(() => assertWorkerProtocolMessageWithinLimit(message, messageBytes - 1)).toThrow(
      WorkerProtocolMessageSizeError,
    );
  });

  it('rejects cyclic and non-cloneable protocol messages', () => {
    const cyclic: Record<string, unknown> = { type: 'checkpoint' };
    cyclic['self'] = cyclic;

    expect(() => estimateWorkerProtocolMessageBytes(cyclic)).toThrow(WorkerProtocolError);
    expect(() => estimateWorkerProtocolMessageBytes({ type: 'failed', handler: () => {} })).toThrow(
      WorkerProtocolError,
    );
  });

  it('validates outbound message shape before host forwarding', () => {
    expect(() =>
      assertWorkerOutboundMessageShape({
        type: 'checkpoint',
        workflowId: 'wf-malformed',
        checkpoint: 'not-bytes',
        operationRequest: { type: 'wait-signal' },
      }),
    ).toThrow(WorkerProtocolError);

    expect(() =>
      assertWorkerOutboundMessageShape({
        type: 'failed',
        workflowId: 'wf-failed',
        error: 'bounded failure',
      }),
    ).not.toThrow();
  });
});

describe('Worker replay operation signatures', () => {
  it('produces stable signatures independent of runtime-only operation fields', async () => {
    const left = await createWorkerReplayOperationSignature(
      {
        id: 'operation-a',
        workflowId: 'workflow-a',
        kind: 'activity',
        queue: 'default',
        activityName: 'load-user',
        input: { id: 'user-1' },
        attempt: 1,
        retryPolicy: {
          maxAttempts: 3,
          initialBackoff: '1s',
          backoffMultiplier: 2,
          maxBackoff: '1m',
        },
        scheduledAt: 1,
      },
      MIN_WORKER_PROTOCOL_MESSAGE_BYTES,
    );
    const right = await createWorkerReplayOperationSignature(
      {
        id: 'operation-b',
        workflowId: 'workflow-b',
        kind: 'activity',
        queue: 'default',
        activityName: 'load-user',
        input: { id: 'user-1' },
        attempt: 2,
        retryPolicy: {
          maxAttempts: 3,
          initialBackoff: '1s',
          backoffMultiplier: 2,
          maxBackoff: '1m',
        },
        scheduledAt: 2,
      },
      MIN_WORKER_PROTOCOL_MESSAGE_BYTES,
    );

    expect(left).toEqual(right);
    expect(left.format).toBe(WORKER_REPLAY_SIGNATURE_FORMAT);
  });

  it('changes signatures when semantic operation input changes', async () => {
    const first = await createWorkerReplayOperationSignature(
      {
        type: 'state-read',
        operationId: 'read-settings',
        scope: { type: 'workflow', workflowType: 'account' },
        key: 'settings',
      },
      MIN_WORKER_PROTOCOL_MESSAGE_BYTES,
    );
    const second = await createWorkerReplayOperationSignature(
      {
        type: 'state-read',
        operationId: 'read-profile',
        scope: { type: 'workflow', workflowType: 'account' },
        key: 'profile',
      },
      MIN_WORKER_PROTOCOL_MESSAGE_BYTES,
    );

    expect(first.stableFieldsDigest).not.toBe(second.stableFieldsDigest);
  });

  it('produces signatures for every workflow context operation variant', async () => {
    const operations: ContextOperationRequest[] = [
      {
        type: 'activity',
        operationId: 'activity-1',
        activityName: 'load-user',
        input: { id: 'user-1' },
        fn: () => 'ignored by signature',
      },
      {
        type: 'sleep',
        operationId: 'sleep-1',
        duration: 1_000,
        scheduledFireAt: 10_000,
      },
      {
        type: 'wait-signal',
        operationId: 'signal-1',
        signalName: 'resume',
      },
      {
        type: 'wait-update',
        operationId: 'update-1',
        updateName: 'approve',
      },
      {
        type: 'parallel',
        operationId: 'parallel-1',
        step: 1,
        operations: [
          {
            type: 'activity',
            operationId: 'parallel-activity-1',
            activityName: 'load-profile',
            input: { profileId: 'profile-1' },
            fn: () => undefined,
          },
        ],
      },
      {
        type: 'race',
        operationId: 'race-1',
        operations: [
          {
            type: 'sleep',
            operationId: 'race-sleep-1',
            duration: 5_000,
            scheduledFireAt: 15_000,
          },
        ],
      },
      {
        type: 'memo',
        operationId: 'memo-1',
        key: 'memo-key',
        fn: () => 'memoized',
      },
      {
        type: 'child-workflow',
        operationId: 'child-1',
        workflowType: 'child',
        input: { childId: 'child-1' },
        options: { id: 'child-workflow-1' },
      },
      {
        type: 'offload',
        operationId: 'offload-1',
        key: 'offload-key',
        fn: async () => ({ cached: true }),
      },
      {
        type: 'load',
        operationId: 'load-1',
        reference: { key: 'offload-key', workflowId: 'wf-1', sizeBytes: 12 },
      },
      {
        type: 'archive',
        operationId: 'archive-1',
        key: 'archive-key',
        data: { archived: true },
      },
      {
        type: 'state-read',
        operationId: 'state-read-1',
        scope: { type: 'workflow', workflowType: 'account' },
        key: 'settings',
        initial: { enabled: true },
      },
      {
        type: 'state-commit',
        operationId: 'state-commit-1',
        scope: { type: 'workflow', workflowType: 'account' },
        key: 'settings',
        expectedVersion: 1,
        mode: 'set',
        value: { enabled: false },
      },
      {
        type: 'run-all',
        operationId: 'run-all-1',
        step: 2,
        branches: {
          first: [() => 'first'],
          second: [() => 'second', { id: 'branch-input' }],
        },
      },
      {
        type: 'speculate',
        operationId: 'speculate-1',
        execute: function* () {
          return 'speculated';
        },
      },
      {
        type: 'stream',
        operationId: 'stream-1',
        key: 'stream-key',
        fn: async function* () {
          yield 'chunk';
        },
      },
      {
        type: 'wait-review',
        operationId: 'review-1',
        reviewOptions: {
          artifact: { title: 'Review this' },
          reviewers: ['reviewer@example.com'],
        },
      },
    ];

    for (const operation of operations) {
      const signature = await createWorkerReplayOperationSignature(
        operation,
        MIN_WORKER_PROTOCOL_MESSAGE_BYTES,
      );
      expect(signature).toMatchObject({
        format: WORKER_REPLAY_SIGNATURE_FORMAT,
        operationType: operation.type,
      });
    }
  });

  it('produces signatures for worker operation kind aliases', async () => {
    const timer = await createWorkerReplayOperationSignature(
      {
        id: 'timer-1',
        workflowId: 'workflow-timer',
        kind: 'timer',
        queue: 'default',
        attempt: 1,
        retryPolicy: {
          maxAttempts: 1,
          initialBackoff: 0,
          backoffMultiplier: 1,
          maxBackoff: 0,
        },
        scheduledAt: 1_000,
      },
      MIN_WORKER_PROTOCOL_MESSAGE_BYTES,
    );
    const signalWait = await createWorkerReplayOperationSignature(
      {
        id: 'signal-wait-1',
        workflowId: 'workflow-signal',
        kind: 'signal-wait',
        queue: 'default',
        attempt: 1,
        retryPolicy: {
          maxAttempts: 1,
          initialBackoff: 0,
          backoffMultiplier: 1,
          maxBackoff: 0,
        },
        scheduledAt: 1_000,
        signalName: 'resume',
      },
      MIN_WORKER_PROTOCOL_MESSAGE_BYTES,
    );

    expect(timer.operationType).toBe('timer');
    expect(signalWait.operationType).toBe('signal-wait');
  });

  it('rejects unknown operation shapes and oversized signature inputs', async () => {
    await expect(
      createWorkerReplayOperationSignature(
        {
          type: 'unknown-operation',
          operationId: 'unknown-1',
        } as never,
        1024,
      ),
    ).rejects.toThrow(WorkerProtocolError);

    await expect(
      createWorkerReplayOperationSignature(
        {
          type: 'state-commit',
          operationId: 'commit-large',
          scope: { type: 'workflow', workflowType: 'account' },
          key: 'large',
          expectedVersion: 1,
          mode: 'set',
          value: 'x'.repeat(1024),
        },
        128,
      ),
    ).rejects.toThrow(WorkerProtocolError);
  });
});
