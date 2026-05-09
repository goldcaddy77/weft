import { describe, expect, it } from 'bun:test';

import {
  REMOTE_WORKER_MAX_PROTOCOL_VERSION,
  REMOTE_WORKER_MESSAGE_SCHEMAS,
  REMOTE_WORKER_MIN_PROTOCOL_VERSION,
  REMOTE_WORKER_PROTOCOL_JSON_SCHEMA,
  REMOTE_WORKER_PROTOCOL_VERSION,
  REMOTE_WORKER_SUPPORTED_PROTOCOL_VERSIONS,
  parseServerToWorkerMessage,
  parseWorkerToServerMessage,
} from './protocol.ts';

describe('RemoteWorker protocol contract', () => {
  it('pins the supported protocol version range to v1', () => {
    expect(REMOTE_WORKER_PROTOCOL_VERSION).toBe(1);
    expect(REMOTE_WORKER_MIN_PROTOCOL_VERSION).toBe(1);
    expect(REMOTE_WORKER_MAX_PROTOCOL_VERSION).toBe(1);
    expect(REMOTE_WORKER_SUPPORTED_PROTOCOL_VERSIONS).toEqual([1]);
  });

  it('publishes deterministic schemas for every protocol message', () => {
    expect(Object.keys(REMOTE_WORKER_MESSAGE_SCHEMAS)).toEqual([
      'register',
      'heartbeat',
      'taskResult',
      'task',
      'cancel',
      'shutdown',
      'registerAck',
      'registerError',
      'protocolError',
    ]);

    expect(JSON.stringify(REMOTE_WORKER_PROTOCOL_JSON_SCHEMA)).toBe(
      JSON.stringify(REMOTE_WORKER_PROTOCOL_JSON_SCHEMA),
    );
  });

  it('accepts a valid v1 register message', () => {
    const result = parseWorkerToServerMessage({
      type: 'register',
      protocolVersion: 1,
      workerId: 'worker-1',
      activities: ['charge'],
      concurrency: 4,
      queue: 'default',
    });

    expect(result).toEqual({
      ok: true,
      message: {
        type: 'register',
        protocolVersion: 1,
        workerId: 'worker-1',
        activities: ['charge'],
        concurrency: 4,
        queue: 'default',
      },
    });
  });

  it('rejects missing or unsupported protocol versions as registration errors', () => {
    expect(
      parseWorkerToServerMessage({
        type: 'register',
        workerId: 'worker-1',
        activities: ['charge'],
      }),
    ).toMatchObject({
      ok: false,
      error: { code: 'unsupported_protocol_version' },
    });

    expect(
      parseWorkerToServerMessage({
        type: 'register',
        protocolVersion: 99,
        workerId: 'worker-1',
        activities: ['charge'],
      }),
    ).toMatchObject({
      ok: false,
      error: { code: 'unsupported_protocol_version', requestedProtocolVersion: 99 },
    });
  });

  it('rejects malformed task results and unknown worker message types', () => {
    expect(
      parseWorkerToServerMessage({
        type: 'taskResult',
        operationId: 'op-1',
        status: 'completed',
      }),
    ).toMatchObject({
      ok: false,
      error: { code: 'invalid_message' },
    });

    expect(parseWorkerToServerMessage({ type: 'typo' })).toMatchObject({
      ok: false,
      error: { code: 'unknown_message_type' },
    });
  });

  it('parses server-to-worker acknowledgement, task, cancel, shutdown, and errors', () => {
    expect(
      parseServerToWorkerMessage({
        type: 'registerAck',
        protocolVersion: 1,
        workerId: 'worker-1',
        queue: 'default',
        activities: ['charge'],
        concurrency: 1,
      }),
    ).toMatchObject({ ok: true, message: { type: 'registerAck' } });

    expect(
      parseServerToWorkerMessage({
        type: 'task',
        operationId: 'op-1',
        activityName: 'charge',
        input: { amount: 42 },
        headers: { traceparent: 'trace' },
      }),
    ).toMatchObject({ ok: true, message: { type: 'task' } });

    expect(parseServerToWorkerMessage({ type: 'cancel', operationId: 'op-1' })).toMatchObject({
      ok: true,
      message: { type: 'cancel' },
    });
    expect(parseServerToWorkerMessage({ type: 'shutdown' })).toMatchObject({
      ok: true,
      message: { type: 'shutdown' },
    });
    expect(
      parseServerToWorkerMessage({
        type: 'registerError',
        code: 'unsupported_protocol_version',
        message: 'nope',
        supportedProtocolVersions: [1],
      }),
    ).toMatchObject({ ok: true, message: { type: 'registerError' } });
    expect(
      parseServerToWorkerMessage({
        type: 'protocolError',
        code: 'invalid_json',
        message: 'nope',
      }),
    ).toMatchObject({ ok: true, message: { type: 'protocolError' } });
  });

  it('keeps the documented message catalog aligned with exported schemas', async () => {
    const documentation = await Bun.file(
      'documentation/reference/remote-worker-protocol.md',
    ).text();
    const documentedMessages = [...documentation.matchAll(/^#### `([^`]+)`/gm)].map(
      (match) => match[1],
    );

    expect(documentedMessages).toEqual(Object.keys(REMOTE_WORKER_MESSAGE_SCHEMAS));
  });
});
