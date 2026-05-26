import { describe, expect, it } from 'bun:test';

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

  it('rejects unsupported operation shapes and oversized signature inputs', async () => {
    await expect(
      createWorkerReplayOperationSignature(
        {
          type: 'wait-update',
          operationId: 'wait-update-1',
          updateName: 'approve',
        },
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
